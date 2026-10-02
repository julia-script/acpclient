/**
 * Session and transcript persistence for AcpAgent.
 *
 * **Details**
 *
 * An AcpAgent stores enough history to answer `session/list`, to reject
 * unknown `sessionId`s, and to replay retained messages (v2) without
 * depending on a particular model or backend. The `Store` service is context
 * that the author provides when serving; `InMemory` is a reference
 * implementation with deterministic behavior.
 */
import * as Context from "effect/Context"
import { TaggedError } from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as String from "effect/String"
import type { ContentBlock } from "./Content.ts"

/**
 * Why a store operation failed.
 *
 * @category models
 */
export type StoreErrorKind =
  /** The session does not exist. */
  | "SessionError"
  /** The session already exists. */
  | "Conflict"
  /** Stored data could not be interpreted. */
  | "Corrupt"

/**
 * Typed persistence failure distinguishing missing sessions, conflicts, and corrupt data.
 *
 * @category errors
 */
export class StoreError extends TaggedError("StoreError")<{
  readonly kind: StoreErrorKind
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * Durable metadata about a session, as reported by `session/list`.
 *
 * @category models
 */
export interface SessionRef {
  /**
   * Agent-issued identity used to look up the persisted session.
   */
  readonly sessionId: string
  /**
   * Working directory. Must be an absolute path.
   */
  readonly cwd: string
  /**
   * Optional human-readable title retained for session listings.
   */
  readonly title?: string | null
  /**
   * RFC 3339 timestamp of last activity.
   */
  readonly updatedAt?: string | null
  /**
   * Optional additional workspace directories retained with the session.
   */
  readonly additionalDirectories?: ReadonlyArray<string> | null
}

/**
 * The role a retained message is replayed as.
 *
 * @category models
 */
export type MessageRole = "user" | "agent" | "thought"

/**
 * A retained message in a session transcript.
 *
 * **Details**
 *
 * `replacement` is the full replacement content (`ContentBlock`s emitted by
 * a full-message update), and `chunks` the blocks appended since. On replay
 * the library first emits the replacement (which resets prior content when
 * the client has already accumulated it), then the chunks.
 *
 * @category models
 */
export interface RetainedMessage {
  /**
   * Session whose transcript contains this message.
   */
  readonly sessionId: string
  /**
   * Agent-issued message identity, stable across replacements and chunks.
   */
  readonly messageId: string
  /**
   * Transcript role used when replaying the retained content.
   */
  readonly role: MessageRole
  /**
   * Full replacement content, or null when this write only appends chunks.
   */
  readonly replacement: ReadonlyArray<ContentBlock> | null
  /**
   * Content appended after the most recent replacement.
   */
  readonly chunks: ReadonlyArray<ContentBlock>
  /**
   * UTC instant when this message was first recorded; later writes retain it.
   */
  readonly recordedAt: DateTime.Utc
}

/**
 * Session and transcript persistence.
 *
 * @category services
 */
export class Store extends Context.Service<Store, {
  /**
   * Lists session metadata, optionally filtered by working directory.
   */
  readonly list: (cwd?: string | null) => Effect.Effect<ReadonlyArray<SessionRef>, StoreError>
  /**
   * Reads a session, or `undefined` when it does not exist.
   */
  readonly get: (sessionId: string) => Effect.Effect<SessionRef | undefined, StoreError>
  /**
   * Creates a session, failing with `Conflict` when it already exists.
   */
  readonly create: (session: SessionRef) => Effect.Effect<void, StoreError>
  /**
   * Updates durable fields of a session (excluding `sessionId`).
   */
  readonly update: (
    sessionId: string,
    partial: Readonly<Omit<SessionRef, "sessionId">>
  ) => Effect.Effect<void, StoreError>
  /**
   * Removes a session and its retained transcript. Missing sessions are a no-op.
   */
  readonly remove: (sessionId: string) => Effect.Effect<void, StoreError>
  /**
   * Records or merges a retained message. Merging appends `chunks` ; when `replacement` is non-null
   * it is set and prior chunks are cleared before appending (a replacement resets content). The
   * first `recordedAt` and insertion position for each `(sessionId, messageId)` survive later
   * writes. Returns the stored form.
   */
  readonly retain: (message: RetainedMessage) => Effect.Effect<RetainedMessage, StoreError>
  /**
   * Reads messages by first-recorded instant, breaking equal-time ties by first insertion order.
   * Persistent implementations must keep that order themselves; the interface cannot derive it from
   * timestamps alone.
   */
  readonly retained: (sessionId: string) => Effect.Effect<ReadonlyArray<RetainedMessage>, StoreError>
}>()("effect-acp/agent/Store") {}

/** Merges a retained message into its stored form; see `Store.retain`. */
const mergeMessage = (
  previous: RetainedMessage | undefined,
  incoming: RetainedMessage
): RetainedMessage => {
  if (previous === undefined) return incoming
  if (incoming.replacement !== null) {
    return { ...previous, ...incoming, chunks: incoming.chunks, recordedAt: previous.recordedAt }
  }
  return { ...previous, ...incoming, replacement: previous.replacement, chunks: [...previous.chunks, ...incoming.chunks], recordedAt: previous.recordedAt }
}

interface InMemoryState {
  readonly sessions: ReadonlyMap<string, SessionRef>
  readonly retained: ReadonlyMap<string, ReadonlyMap<string, RetainedMessage>>
}

const emptyState = (): InMemoryState => ({ sessions: new Map(), retained: new Map() })

/**
 * A deterministic in-memory Store. Sessions and transcripts live for the lifetime of the referenced
 * service; nothing survives the process. Its `list` method orders sessions lexically by session ID.
 *
 * @category constructors
 */
export const InMemory = Effect.gen(function*() {
  const state = yield* Ref.make(emptyState())
  return Store.of({
    list: (cwd) =>
      Ref.get(state).pipe(Effect.map(({ sessions }) =>
        [...sessions.values()]
          .filter((session) => cwd === undefined || cwd === null || session.cwd === cwd)
          .sort((a, b) => String.Order(a.sessionId, b.sessionId))
      )),
    get: (sessionId) => Ref.get(state).pipe(Effect.map(({ sessions }) => sessions.get(sessionId))),
    create: (session) =>
      Ref.modify(state, (current): [Effect.Effect<void, StoreError>, InMemoryState] => {
        if (current.sessions.has(session.sessionId)) {
          return [
            Effect.fail(new StoreError({ kind: "Conflict", message: `Session ${session.sessionId} already exists` })),
            current
          ]
        }
        const sessions = new Map(current.sessions)
        sessions.set(session.sessionId, session)
        return [Effect.void, { ...current, sessions }]
      }).pipe(Effect.flatten),
    update: (sessionId, partial) =>
      Ref.modify(state, (current): [Effect.Effect<void, StoreError>, InMemoryState] => {
        const existing = current.sessions.get(sessionId)
        if (existing === undefined) {
          return [
            Effect.fail(new StoreError({ kind: "SessionError", message: `Session ${sessionId} not found` })),
            current
          ]
        }
        const sessions = new Map(current.sessions)
        sessions.set(sessionId, { ...existing, ...partial })
        return [Effect.void, { ...current, sessions }]
      }).pipe(Effect.flatten),
    remove: (sessionId) =>
      Ref.update(state, (current) => {
        const sessions = new Map(current.sessions)
        sessions.delete(sessionId)
        const retained = new Map(current.retained)
        retained.delete(sessionId)
        return { sessions, retained }
      }),
    retain: (message) =>
      Ref.modify(state, (current): [Effect.Effect<RetainedMessage, StoreError>, InMemoryState] => {
        const byId = new Map(current.retained.get(message.sessionId) ?? new Map())
        const merged = mergeMessage(byId.get(message.messageId), message)
        byId.set(message.messageId, merged)
        const retained = new Map(current.retained)
        retained.set(message.sessionId, byId)
        return [Effect.succeed(merged), { ...current, retained }]
      }).pipe(Effect.flatten),
    retained: (sessionId) =>
      Ref.get(state).pipe(Effect.map(({ retained }) =>
        [...(retained.get(sessionId)?.values() ?? [])]
          .map((message, insertion) => ({ message, insertion }))
          .sort((a, b) => DateTime.toEpochMillis(a.message.recordedAt) - DateTime.toEpochMillis(b.message.recordedAt) || a.insertion - b.insertion)
          .map(({ message }) => message)
      ))
  })
})

/**
 * A layer providing an in-memory Store.
 *
 * @category layers
 */
export const layer: Layer.Layer<Store> = Layer.effect(Store, InMemory)
