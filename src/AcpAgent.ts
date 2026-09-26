import { McpServer } from "./AcpApp.ts"
import * as V1 from "./protocol/v1/Schema.ts"
import * as V2 from "./protocol/v2/Schema.ts"
import type { RequestMethod } from "./AcpSchema.ts"
import * as Data from "effect/Data"
/**
 * Author an ACP agent from typed Effect handlers.
 *
 * You supply implementation metadata, a version policy, and handlers; the
 * library owns the wire: version negotiation, capability advertisement,
 * request decoding, update emission, cancellation, and error mapping. Nothing
 * here knows about models — everything an agent needs from the outside world
 * arrives through the Effect environment, including the {@link Store}.
 *
 * Prompting is split in two phases, because v1 and v2 disagree about when a
 * prompt is answered:
 *
 * - `prompt.insert` records the user message and returns its canonical
 *   `messageId`. Only its success permits a v2 `session/prompt` response.
 * - `prompt.execute` runs the foreground turn, emitting updates and returning
 *   a stop reason. v2 runs it *after* responding; v1's response waits for it.
 *
 * ```ts
 * import * as AcpAgent from "effect-acp/AcpAgent"
 * import * as Effect from "effect/Effect"
 *
 * const agent = AcpAgent.make({
 *   info: { name: "echo", version: "1.0.0" },
 *   versions: [2, 1],
 *   session: {
 *     create: ({ cwd }) => Effect.succeed({ sessionId: `s-${cwd.length}` })
 *   },
 *   prompt: {
 *     insert: () => Effect.succeed({ messageId: "m-1" }),
 *     execute: ({ emit }) => Effect.as(emit.agentChunk("m-1", { type: "text", text: "hi" }), "end_turn")
 *   }
 * })
 * ```
 *
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as AcpProtocol from "./AcpProtocol.ts"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Scope from "effect/Scope"
import type * as Stdio from "effect/Stdio"
import * as AcpConnection from "./AcpConnection.ts"
import { AcpRemoteError, type AcpTransportError } from "./AcpError.ts"
import { type Method, ErrorCode } from "./AcpSchema.ts"
import { AcpTransport } from "./AcpTransport.ts"
import type { ContentBlock, Prompt } from "./agent/Content.ts"
import { type MessageRole, Store, StoreError } from "./agent/Store.ts"
import * as ProcessStdio from "./transport/ProcessStdio.ts"

/** The protocol version a connection negotiated. */
export type Version = 1 | 2

// -----------------------------------------------------------------------------
// Failures
// -----------------------------------------------------------------------------

/**
 * An agent's advertised capabilities do not match its installed handlers.
 *
 * Raised by {@link make} before anything is served, so a misconfigured agent
 * never accepts a connection it cannot honor.
 */
export class AcpAgentConfigError extends Data.TaggedError("AcpAgentConfigError")<{ readonly missing: string; readonly message: string }> {
  /** The handler or capability that is missing or inconsistent. */
  constructor(missing: string, message: string) {
    super({ message, missing })
  }
}

/**
 * A handler rejected an operation. `code` is sent to the client verbatim;
 * defects are *not*, and surface as a bare Internal error.
 */
export class AcpAgentError extends Data.TaggedError("AcpAgentError")<{ readonly code: number; readonly message: string; readonly data: unknown }> {
  constructor(options: { readonly code?: number; readonly message: string; readonly data?: unknown }) {
    super({ message: options.message, code: options.code ?? ErrorCode.InternalError, data: options.data })
  }
}

/** Rejects the current operation with `Resource not found` for an unknown session. */
export const unknownSession = (sessionId: string): AcpAgentError =>
  new AcpAgentError({ code: ErrorCode.ResourceNotFound, message: `Unknown session ${sessionId}` })

/** Rejects the current operation with `Authentication required`. */
export const authRequired = (message = "Authentication required"): AcpAgentError =>
  new AcpAgentError({ code: ErrorCode.AuthRequired, message })

/** Failures an author's handler may return. */
export type HandlerError = AcpAgentError | StoreError

// -----------------------------------------------------------------------------
// Session updates
// -----------------------------------------------------------------------------

/** Terminal state of a foreground turn. */
export type StopReason = "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled"

/**
 * Version-aware update emission for one session.
 *
 * Every method maps to the negotiated version's `session/update` shape.
 * `messageId` is required on v2 and dropped on v1, which has no message
 * identities; emitting a v2-only update on a v1 session fails rather than
 * inventing a wire shape.
 */
export interface Emit {
  /** The negotiated version, for handlers that genuinely need to branch. */
  readonly version: Version
  /** Appends a chunk to an agent message. */
  readonly agentChunk: (messageId: string, content: ContentBlock) => Effect.Effect<void, HandlerError>
  /** Appends a chunk to an agent thought. */
  readonly thoughtChunk: (messageId: string, content: ContentBlock) => Effect.Effect<void, HandlerError>
  /** Appends a chunk echoing the user's message. */
  readonly userChunk: (messageId: string, content: ContentBlock) => Effect.Effect<void, HandlerError>
  /**
   * Replaces a message's full content (v2 only). Clients reset any content
   * they had accumulated for `messageId` before applying it.
   */
  readonly message: (
    role: MessageRole,
    messageId: string,
    content: ReadonlyArray<ContentBlock>
  ) => Effect.Effect<void, HandlerError>
  /** Sends a raw update for the negotiated version, for surfaces without a helper. */
  readonly raw: (update: unknown) => Effect.Effect<void, HandlerError>
}

/** Session-scoped client interactions available to `prompt.execute`. */
export interface Interactions {
  /**
   * Asks the client to choose a permission option, returning the selected
   * `optionId` or `null` when the client cancelled. Runs on its own request,
   * so other traffic keeps flowing while it waits.
   */
  readonly requestPermission: (options: {
    readonly title: string
    readonly options: ReadonlyArray<{ readonly optionId: string; readonly name: string; readonly kind: V1.PermissionOptionKind }>
    readonly toolCallId?: string | undefined
  }) => Effect.Effect<string | null, HandlerError>
  /**
   * Asks the client to elicit input. Fails before sending when the client did
   * not advertise the requested `mode`.
   */
  readonly elicit: (request: Omit<V2.CreateElicitationRequest, "sessionId">) => Effect.Effect<V2.CreateElicitationResponse, HandlerError>
}

// -----------------------------------------------------------------------------
// Handlers
// -----------------------------------------------------------------------------

/** What the client told us about itself during `initialize`. */
export interface Peer {
  readonly version: Version
  /** Client implementation metadata, when it sent any. */
  readonly info: { readonly name: string; readonly version: string } | null
  /** Elicitation modes the client advertised. */
  readonly elicitation: ReadonlyArray<"form" | "url">
  /** The decoded initialize params verbatim. */
  readonly raw: V1.InitializeRequest | V2.InitializeRequest
}

export interface SessionContext {
  readonly sessionId: string
  readonly version: Version
  readonly peer: Peer
}

export interface CreateSessionRequest {
  readonly cwd: string
  readonly additionalDirectories: ReadonlyArray<string>
  readonly mcpServers: ReadonlyArray<McpServer>
  readonly peer: Peer
}

export interface InsertRequest extends SessionContext {
  readonly prompt: Prompt
}

export interface ExecuteRequest extends SessionContext {
  readonly prompt: Prompt
  /** The message id `insert` returned for this turn. */
  readonly messageId: string
  readonly emit: Emit
  readonly client: Interactions
}

/** Session lifecycle handlers. `create` is the v2 baseline requirement. */
export interface SessionHandlers<R = never> {
  /** Creates a session and returns its id. Required whenever sessions are served. */
  readonly create: (request: CreateSessionRequest) => Effect.Effect<{ readonly sessionId: string }, HandlerError, R>
  /** Resumes an existing session. Advertised as `session/resume` when present. */
  readonly resume?: (
    request: SessionContext & { readonly cwd: string; readonly replayFromStart: boolean }
  ) => Effect.Effect<void, HandlerError, R>
  /** Deletes a session. Advertised as `session.delete` when present. */
  readonly delete?: (request: SessionContext) => Effect.Effect<void, HandlerError, R>
  /** Closes a session without deleting it. */
  readonly close?: (request: SessionContext) => Effect.Effect<void, HandlerError, R>
  /** Cancels foreground work. Called after owned execution is interrupted. */
  readonly cancel?: (request: SessionContext) => Effect.Effect<void, HandlerError, R>
}

/** Prompt handlers: insertion is separate from foreground execution. */
export interface PromptHandlers<R = never> {
  /**
   * Records the user message and returns its canonical id. On v2 its success
   * — and only its success — produces the `session/prompt` response.
   */
  readonly insert: (request: InsertRequest) => Effect.Effect<{ readonly messageId: string }, HandlerError, R>
  /**
   * Runs the foreground turn. On v2 this runs after the response, in a scope
   * owned by the session; on v1 the response waits for its stop reason.
   */
  readonly execute: (request: ExecuteRequest) => Effect.Effect<StopReason, HandlerError, R>
}

/**
 * Authentication handlers. Supplying `methods` obliges you to supply both
 * `login` and `logout`: advertising methods you cannot service is rejected.
 */
export interface AuthHandlers<R = never> {
  readonly methods: ReadonlyArray<{
    readonly methodId: string
    readonly name: string
    readonly type?: string | undefined
    readonly description?: string | undefined
  }>
  readonly login?: (request: { readonly methodId: string }) => Effect.Effect<void, HandlerError, R>
  readonly logout?: () => Effect.Effect<void, HandlerError, R>
}

export interface Options<R = never> {
  /** Advertised implementation identity. */
  readonly info: { readonly name: string; readonly version: string; readonly title?: string | undefined }
  /** Enabled versions, highest first. Defaults to `[1]`; v2 is draft. */
  readonly versions?: readonly [1] | readonly [2] | readonly [2, 1] | undefined
  readonly session: SessionHandlers<R>
  readonly prompt: PromptHandlers<R>
  readonly auth?: AuthHandlers<R> | undefined
  /**
   * `session/list` support. Omitted means the method is not advertised; the
   * store still backs session existence checks.
   */
  readonly list?: boolean | undefined
}

// -----------------------------------------------------------------------------
// Capability validation
// -----------------------------------------------------------------------------

const validate = <R>(options: Options<R>): AcpAgentConfigError | undefined => {
  // v2's session capability has a baseline: advertising it obliges the agent to
  // serve session/new, session/prompt, session/cancel and session/update.
  if (typeof options.session?.create !== "function") {
    return new AcpAgentConfigError("session.create", "Advertising sessions requires a session.create handler")
  }
  if (typeof options.prompt?.insert !== "function") {
    return new AcpAgentConfigError("prompt.insert", "Advertising sessions requires a prompt.insert handler")
  }
  if (typeof options.prompt?.execute !== "function") {
    return new AcpAgentConfigError("prompt.execute", "Advertising sessions requires a prompt.execute handler")
  }
  if (options.auth !== undefined && options.auth.methods.length > 0) {
    if (typeof options.auth.login !== "function") {
      return new AcpAgentConfigError("auth.login", "Advertising authentication methods requires an auth.login handler")
    }
    if (typeof options.auth.logout !== "function") {
      return new AcpAgentConfigError("auth.logout", "Advertising authentication methods requires an auth.logout handler")
    }
  }
  return undefined
}

// -----------------------------------------------------------------------------
// Agent
// -----------------------------------------------------------------------------

export interface AcpAgent<R = never> {
  /** The validated options this agent serves. */
  readonly options: Options<R>
  /**
   * Serves one client using the injected `AcpTransport` until it disconnects. Owned session work
   * and pending interactions are settled before it returns.
   */
  readonly serve: Effect.Effect<void, AcpTransportError, R | Store | AcpTransport | Scope.Scope>
}

/**
 * The capability set this agent advertises for `version`.
 *
 * Only surfaces with an installed handler are advertised, so the wire never
 * promises more than {@link make} validated.
 */
const advertisement = <R>(options: Options<R>, version: Version): V1.InitializeResponse | V2.InitializeResponse => {
  const methods = options.auth?.methods ?? []
  if (version === 1) {
    return {
      protocolVersion: 1,
      agentInfo: { name: options.info.name, version: options.info.version, title: options.info.title ?? null },
      agentCapabilities: {
        loadSession: false,
        sessionCapabilities: {
          ...(options.list ? { list: {} } : {}),
          ...(options.session.resume ? { resume: {} } : {}),
          ...(options.session.delete ? { delete: {} } : {}),
          ...(options.session.close ? { close: {} } : {})
        }
      },
      // v1 keys an auth method by `id`; v2 by `methodId`.
      authMethods: methods.map((method) => ({
        type: method.type ?? "agent",
        id: method.methodId,
        name: method.name,
        description: method.description ?? null
      }))
    }
  }
  return {
    protocolVersion: 2,
    info: { name: options.info.name, version: options.info.version, title: options.info.title ?? null },
    capabilities: {
      session: (options.session.delete ? { delete: {} } : {})
    },
    authMethods: methods.map((method) => ({
      type: method.type ?? "agent",
      methodId: method.methodId,
      name: method.name,
      description: method.description ?? null
    }))
  }
}

/** Maps a handler failure onto the wire without leaking internal causes. */
const toRemote = (error: unknown): AcpRemoteError => {
  if (Schema.is(AcpRemoteError)(error)) return error
  if (error instanceof AcpAgentError) {
    return new AcpRemoteError({ code: error.code, message: error.message, data: error.data })
  }
  if (error instanceof StoreError) {
    return error.kind === "SessionError"
      ? new AcpRemoteError({ code: ErrorCode.ResourceNotFound, message: error.message })
      : new AcpRemoteError({ code: ErrorCode.InternalError, message: "Internal error" })
  }
  return new AcpRemoteError({ code: ErrorCode.InternalError, message: "Internal error" })
}

interface SessionState {
  /** Scope owning this session's foreground execution. */
  readonly scope: Scope.Closeable
  inserting?: boolean
  running: Fiber.Fiber<StopReason, HandlerError> | undefined
  cancelled: boolean
}

/**
 * Builds an agent from handlers, validating that everything it would
 * advertise is actually installed.
 *
 * Fails synchronously (by throwing `AcpAgentConfigError`) rather than at the
 * first connection: a capability surface the agent cannot honor is a
 * programming error, not a runtime condition.
 */
export const make = <R = never>(options: Options<R>): AcpAgent<R> => {
  const invalid = validate(options)
  if (invalid) throw invalid
  const enabled: ReadonlyArray<Version> = options.versions ?? [1]

  const serve = Effect.gen(function*() {
      const store = yield* Effect.service(Store)
      // Routes must be `Effect<_, _, never>`, so capture the author's services
      // once here and provide them to every handler effect.
      const services = yield* Effect.context<R>()
      const provided = <A, E>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E> =>
        Effect.provideContext(effect, services)
      const connection = yield* AcpConnection.make()
      const sessions = new Map<string, SessionState>()
      let peer: Peer | undefined

      const ended = (sessionId: string) =>
        Effect.suspend(() => {
          const state = sessions.get(sessionId)
          if (!state) return Effect.void
          state.cancelled = true
          sessions.delete(sessionId)
          return Scope.close(state.scope, Exit.void).pipe(Effect.ignore)
        })

      // --- updates -----------------------------------------------------------

      const notify = (sessionId: string, update: unknown) =>
        Schema.encodeUnknownEffect(AcpProtocol.schemas[peer!.version].clientMethods["session/update"].params)({ sessionId, update }).pipe(
          Effect.flatMap((encoded) => connection.notifyRaw("session/update", encoded)),
          Effect.mapError(() => new AcpAgentError({ message: "Invalid update or closed connection" })))

      const emitFor = (sessionId: string, version: Version): Emit => {
        const chunk = (kind: "agent" | "thought" | "user") => (messageId: string, content: ContentBlock) => {
          const sessionUpdate = { agent: "agent_message_chunk", thought: "agent_thought_chunk", user: "user_message_chunk" }[kind]
          const payload = version === 2
            ? { sessionUpdate, messageId, content }
            : { sessionUpdate, content }
          return Effect.andThen(
            // Retention is the store's guarantee, not the library's: we record
            // what we emit and let the store decide what survives.
            store.retain({
              sessionId,
              messageId,
              role: kind === "thought" ? "thought" : kind,
              replacement: null,
              chunks: [content],
              recordedAt: "1970-01-01T00:00:00.000Z"
            }).pipe(Effect.ignore),
            notify(sessionId, payload)
          )
        }
        return {
          version,
          agentChunk: chunk("agent"),
          thoughtChunk: chunk("thought"),
          userChunk: chunk("user"),
          message: (role, messageId, content) =>
            version === 1
              ? Effect.fail(
                new AcpAgentError({ message: "Full message replacement requires protocol v2" })
              )
              : Effect.andThen(
                store.retain({
                  sessionId,
                  messageId,
                  role,
                  replacement: content,
                  chunks: [],
                  recordedAt: "1970-01-01T00:00:00.000Z"
                }).pipe(Effect.ignore),
                notify(sessionId, {
                  sessionUpdate: messageRole(role),
                  messageId,
                  content
                })
              ),
          raw: (update) => notify(sessionId, update)
        }
      }

      /** v2 reports turn completion as an idle state update; v1 in its response. */
      const emitIdle = (sessionId: string, version: Version, stopReason: StopReason) =>
        version === 2 ? notify(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason }) : Effect.void

      const emitRunning = (sessionId: string, version: Version) =>
        version === 2 ? notify(sessionId, { sessionUpdate: "state_update", state: "running" }) : Effect.void

      // --- client interactions ----------------------------------------------

      const requestClient = <P, A>(descriptor: RequestMethod<string, P, A>, params: P) => Effect.gen(function*() {
        const encoded = yield* Schema.encodeEffect(descriptor.params)(params)
        const sent = yield* connection.send(descriptor.method, encoded)
        return yield* sent.response.pipe(Effect.flatMap(Schema.decodeUnknownEffect(descriptor.result)),
          Effect.onInterrupt(() => Effect.ignore(connection.cancelRequest(sent.id))))
      })
      const interactionsFor = (sessionId: string, version: Version, current: Peer): Interactions => ({
        requestPermission: ({ options: permissionOptions, title, toolCallId }) =>
          (version === 2
            ? requestClient(V2.clientMethods["session/request_permission"], { sessionId, title, options: permissionOptions })
            : requestClient(V1.clientMethods["session/request_permission"], {
              sessionId, toolCall: { toolCallId: toolCallId ?? "tool-1", title }, options: permissionOptions
            })).pipe(
            Effect.map((raw) => {
              const outcome = raw.outcome
              return outcome.outcome === "selected" && "optionId" in outcome ? outcome.optionId : null
            }),
            Effect.mapError((error) => new AcpAgentError({ message: `Permission request failed: ${error.message}` }))
          ),
        elicit: (request) =>
          current.elicitation.some((mode) => mode === request.mode)
            // Reject before sending: the client told us it cannot answer this mode.
            ? requestClient(AcpProtocol.schemas[version].clientMethods["elicitation/create"], { ...request, sessionId }).pipe(
              Effect.mapError((error) => new AcpAgentError({ message: `Elicitation failed: ${error.message}` }))
            )
            : Effect.fail(
              new AcpAgentError({
                code: ErrorCode.InvalidRequest,
                message: `Client does not support ${request.mode} elicitation`
              })
            )
      })

      // --- request handling --------------------------------------------------

      const requirePeer = Effect.suspend(() =>
        peer === undefined
          ? Effect.fail(new AcpRemoteError({ code: ErrorCode.InvalidRequest, message: "Not initialized" }))
          : Effect.succeed(peer)
      )

      const requireSession = (sessionId: string) =>
        store.get(sessionId).pipe(
          Effect.mapError(toRemote),
          Effect.filterOrFail(
            (session) => session !== undefined,
            () => toRemote(unknownSession(sessionId))
          )
        )

      /**
       * Runs an author handler. Typed failures keep their code and message;
       * defects are logged locally and reported as a bare Internal error, so a
       * handler that throws never leaks its cause to the client.
       */
      const handler = <A>(effect: Effect.Effect<A, HandlerError, R>) =>
        effect.pipe(
          Effect.mapError(toRemote),
          Effect.catchDefect(() =>
            Effect.andThen(
              Effect.logError("Agent handler failed"),
              Effect.fail(new AcpRemoteError({ code: ErrorCode.InternalError, message: "Internal error" }))
            )
          ),
          provided
        )

      const initialize = (params: unknown) => Effect.gen(function*() {
        if (peer !== undefined) return yield* new AcpRemoteError({ code: ErrorCode.InvalidRequest, message: "Already initialized" })
        const raw = yield* decodeInput(PeerInput, params)
        const wire = raw.protocolVersion === 1
          ? yield* decodeInput(V1.InitializeRequest, params)
          : yield* decodeInput(V2.InitializeRequest, params)
        const highest: Version = enabled.includes(2) ? 2 : 1
        const version = enabled.find((candidate) => candidate === raw.protocolVersion) ?? highest
        const capabilities = raw.capabilities ?? raw.clientCapabilities
        const elicitation = capabilities?.elicitation
        peer = {
          version, info: raw.info ?? raw.clientInfo ?? null,
          elicitation: elicitation ? (["form", "url"] as const).filter((mode) => elicitation[mode] != null) : [],
          raw: wire
        }
        return advertisement(options, version)
      })

      const newSession = (params: unknown) =>
        Effect.gen(function*() {
          const current = yield* requirePeer
          const request = yield* decodeInput(CreateInput, params)
          const created = yield* handler(options.session.create({
            cwd: request.cwd,
            additionalDirectories: request.additionalDirectories ?? [],
            mcpServers: request.mcpServers ?? [],
            peer: current
          }))
          yield* store.create({
            sessionId: created.sessionId,
            cwd: request.cwd,
            additionalDirectories: request.additionalDirectories ?? null
          }).pipe(Effect.mapError(toRemote))
          return { sessionId: created.sessionId }
        })

      /** Owns one turn's foreground work; used by both versions. */
      const execute = (context: SessionContext, prompt: Prompt, messageId: string) =>
        Effect.gen(function*() {
          const emit = emitFor(context.sessionId, context.version)
          const client = interactionsFor(context.sessionId, context.version, context.peer)
          yield* emitRunning(context.sessionId, context.version)
          // A failed turn still ends: report it as a refusal rather than
          // leaving the session running forever. Interruption (cancellation)
          // passes through, so its own completion signal is emitted instead.
          const stopReason = yield* options.prompt.execute({ ...context, prompt, messageId, emit, client }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause)
              if (Cause.hasInterrupts(cause)) {
                return Effect.andThen(Effect.logError("Agent execution failed", cause), Effect.failCause(cause))
              }
              return Effect.andThen(Effect.logError("Agent execution failed"), Effect.succeed<StopReason>("refusal"))
            })
          )
          // Final updates precede the idle signal.
          yield* emitIdle(context.sessionId, context.version, stopReason)
          return stopReason
        })

      const prompt = (params: unknown) =>
        Effect.gen(function*() {
          const current = yield* requirePeer
          const request = yield* decodeInput(PromptInput, params)
          yield* requireSession(request.sessionId)
          const context: SessionContext = {
            sessionId: request.sessionId,
            version: current.version,
            peer: current
          }
          const state: SessionState = sessions.get(request.sessionId) ?? { scope: yield* Scope.make(), running: undefined, cancelled: false }
          sessions.set(request.sessionId, state)
          if (state.running || state.inserting) return yield* new AcpRemoteError({ code: ErrorCode.InvalidRequest, message: "Session is busy" })
          state.inserting = true
          state.cancelled = false
          const inserted = yield* handler(Effect.suspend(() => options.prompt.insert({ ...context, prompt: request.prompt }))).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? Effect.sync(() => { state.inserting = false }) : Effect.void))
          const { fiber, completed } = yield* Effect.uninterruptible(Effect.gen(function*() {
          yield* store.retain({
            sessionId: request.sessionId,
            messageId: inserted.messageId,
            role: "user",
            replacement: [...request.prompt],
            chunks: [],
            recordedAt: "1970-01-01T00:00:00.000Z"
          }).pipe(Effect.mapError(toRemote))

          if (state.cancelled) {
            state.inserting = false
            return yield* new AcpRemoteError({ code: ErrorCode.RequestCancelled, message: "Request cancelled" })
          }

          const started = yield* Deferred.make<void>()
          const completed = yield* Deferred.make<StopReason, HandlerError>()
          const work = Deferred.await(started).pipe(Effect.andThen(execute(context, request.prompt, inserted.messageId)),
            Effect.catchCauseIf((cause) => state.cancelled && Cause.hasInterruptsOnly(cause),
              () => Effect.succeed<StopReason>("cancelled")),
            Effect.ensuring(Effect.sync(() => { state.running = undefined })),
            Effect.onExit((exit) => state.cancelled && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
              ? Deferred.succeed(completed, "cancelled")
              : Deferred.done(completed, exit)))
          const fiber = yield* Effect.forkIn(Effect.interruptible(work), state.scope)
          state.running = fiber
          state.inserting = false
          yield* Deferred.succeed(started, undefined)
          return { fiber, completed }
          }).pipe(Effect.ensuring(Effect.sync(() => { state.inserting = false }))))
          if (current.version === 1) return { stopReason: yield* Deferred.await(completed).pipe(Effect.onInterrupt(() => Fiber.interrupt(fiber))) }
          return { messageId: inserted.messageId }
        })

      const cancelSession = (params: unknown) =>
        Effect.gen(function*() {
          const { sessionId } = yield* decodeInput(SessionInput, params)
          const state = sessions.get(sessionId)
          const current = peer
          if (state) state.cancelled = true
          if (state?.running) {
            // Interrupting drains the execution's finalizers (its final
            // updates) before we report the cancelled stop reason.
            yield* Fiber.interrupt(state.running)
            state.running = undefined
          }
          if (options.session.cancel && current) {
            yield* options.session.cancel({ sessionId, version: current.version, peer: current }).pipe(Effect.ignore)
          }
          if (current) yield* emitIdle(sessionId, current.version, "cancelled")
        })

      const routes: Array<AcpConnection.Route> = [
        { _tag: "Request", method: "initialize", run: (params) => initialize(params) },
        { _tag: "Request", method: "session/new", run: (params) => newSession(params) },
        { _tag: "Request", method: "session/prompt", run: (params) => provided(prompt(params)).pipe(Effect.mapError(toRemote)) },
        {
          _tag: "Notification",
          method: "session/cancel",
          run: (params) => provided(cancelSession(params)).pipe(Effect.ignore)
        }
      ]

      if (options.list || enabled.includes(2)) {
        routes.push({
          _tag: "Request",
          method: "session/list",
          run: (params) =>
            decodeInput(ListInput, params ?? {}).pipe(
              Effect.flatMap(({ cwd }) => store.list(cwd)),
              Effect.map((sessions) => ({
                sessions: sessions.map((session) => ({
                  sessionId: session.sessionId,
                  cwd: session.cwd,
                  title: session.title ?? null,
                  updatedAt: session.updatedAt ?? null
                }))
              })),
              Effect.mapError(toRemote)
            )
        })
      }

      if (options.session.resume || enabled.includes(2)) {
        const resume = options.session.resume ?? (() => Effect.void)
        routes.push({
          _tag: "Request",
          method: "session/resume",
          run: (params) =>
            Effect.gen(function*() {
              const current = yield* requirePeer
              if (current.version === 1 && !options.session.resume) return yield* new AcpRemoteError({ code: ErrorCode.MethodNotFound, message: "Method not found" })
              const request = yield* decodeInput(ResumeInput, params)
              yield* requireSession(request.sessionId)
              const context: SessionContext = {
                sessionId: request.sessionId,
                version: current.version,
                peer: current
              }
              const replayFromStart = request.replayFrom?.type === "start"
              yield* handler(resume({ ...context, cwd: request.cwd, replayFromStart }))
              if (replayFromStart) yield* replay(context)
              return {}
            })
        })
      }

      if (options.session.delete) {
        const remove = options.session.delete
        routes.push({
          _tag: "Request",
          method: "session/delete",
          run: (params) =>
            Effect.gen(function*() {
              const current = yield* requirePeer
              const { sessionId } = yield* decodeInput(SessionInput, params)
              yield* requireSession(sessionId)
              yield* handler(remove({ sessionId, version: current.version, peer: current }))
              yield* ended(sessionId)
              yield* store.remove(sessionId).pipe(Effect.mapError(toRemote))
              return {}
            })
        })
      }

      if (options.session.close || enabled.includes(2)) {
        const close = options.session.close ?? (() => Effect.void)
        routes.push({
          _tag: "Request",
          method: "session/close",
          run: (params) =>
            Effect.gen(function*() {
              const current = yield* requirePeer
              const { sessionId } = yield* decodeInput(SessionInput, params)
              yield* requireSession(sessionId)
              yield* handler(close({ sessionId, version: current.version, peer: current }))
              yield* ended(sessionId)
              return {}
            })
        })
      }

      const auth = options.auth
      if (auth && auth.methods.length > 0) {
        const login = auth.login!
        const logout = auth.logout!
        // v1 and v2 disagree on the method names for the same operations.
        routes.push(
          {
            _tag: "Request",
            method: "authenticate",
            run: (params) =>
              decodeInput(LoginInput, params).pipe(Effect.flatMap((request) => handler(login(request))), Effect.as({}))
          },
          {
            _tag: "Request",
            method: "auth/login",
            run: (params) =>
              decodeInput(LoginInput, params).pipe(Effect.flatMap((request) => handler(login(request))), Effect.as({}))
          },
          { _tag: "Request", method: "logout", run: () => Effect.as(handler(logout()), {}) },
          { _tag: "Request", method: "auth/logout", run: () => Effect.as(handler(logout()), {}) }
        )
      }

      /**
       * Replays retained history. A replacement resets whatever the client
       * accumulated for that message before the chunks are appended, so the
       * replayed message keeps its original identity.
       */
      const replay = (context: SessionContext) =>
        Effect.gen(function*() {
          const messages = yield* store.retained(context.sessionId)
          for (const message of messages) {
            const role = messageRole(message.role)
            if (context.version === 2) yield* notify(context.sessionId, {
              sessionUpdate: role, messageId: message.messageId, content: message.replacement ?? []
            })
            const chunks = context.version === 1 ? [...(message.replacement ?? []), ...message.chunks] : message.chunks
            for (const content of chunks) yield* notify(context.sessionId, {
              sessionUpdate: `${role}_chunk`, ...(context.version === 2 ? { messageId: message.messageId } : {}), content
            })
          }
        }).pipe(Effect.mapError(toRemote))

      const dispatch = AcpConnection.handlers(routes)
      yield* connection.setHandlers({
        request: (method, params, context) => Effect.gen(function*() {
          if (method !== "initialize") yield* requirePeer
          const requested = isRecord(params) && params["protocolVersion"] === 2 ? 2 : 1
          const selected = method === "initialize" ? requested : peer!.version
          if (selected === 1 && method === "session/list" && !options.list) return yield* new AcpRemoteError({ code: ErrorCode.MethodNotFound, message: "Method not found" })
          const methods: Readonly<Record<string, Method>> = AcpProtocol.schemas[selected].agentMethods
          const descriptor = methods[method]
          if (descriptor?._tag !== "Request") return yield* new AcpRemoteError({ code: ErrorCode.MethodNotFound, message: "Method not found" })
          const decoded = yield* Schema.decodeUnknownEffect(descriptor.params)(params).pipe(
            Effect.mapError(() => new AcpRemoteError({ code: ErrorCode.InvalidParams, message: "Invalid params" })))
          const effect = dispatch.request?.(method, decoded, context)
          if (effect === undefined) return yield* new AcpRemoteError({ code: ErrorCode.MethodNotFound, message: "Method not found" })
          const result = yield* effect
          const resultSchema = method === "initialize" ? AcpProtocol.schemas[peer!.version].InitializeResponse : descriptor.result
          return yield* Schema.encodeUnknownEffect(resultSchema)(result).pipe(
            Effect.mapError(() => new AcpRemoteError({ code: ErrorCode.InternalError, message: "Invalid handler result" })))
        }).pipe(Effect.catchDefect(() => Effect.fail(new AcpRemoteError({ code: ErrorCode.InternalError, message: "Internal error" })))),
        notification: (method, params) => Effect.gen(function*() {
          if (!peer) return
          const methods: Readonly<Record<string, Method>> = AcpProtocol.schemas[peer.version].agentMethods
          const descriptor = methods[method]
          if (descriptor?._tag !== "Notification") return
          const decoded = yield* Schema.decodeUnknownEffect(descriptor.params)(params)
          yield* dispatch.notification?.(method, decoded) ?? Effect.void
        }).pipe(Effect.ignoreCause)
      })
      // Serve until the client disconnects, then settle owned work.
      yield* Effect.ensuring(
        connection.closed,
        Effect.suspend(() => Effect.forEach([...sessions.keys()], ended, { discard: true }))
      )
    }).pipe(Effect.scoped)

  return { options, serve }
}

/**
 * Serves this agent over the current process's stdin/stdout until the client
 * disconnects. Stdout carries only ACP frames.
 */
export const serveStdio = <R>(
  agent: AcpAgent<R>,
  options?: ProcessStdio.Options
): Effect.Effect<void, AcpTransportError, R | Store | Stdio.Stdio | Scope.Scope> =>
  agent.serve.pipe(Effect.provide(Layer.merge(ProcessStdio.layer(options), Logger.layer([Logger.withConsoleError(Logger.formatJson)]))))

/**
 * A layer that serves this agent over process stdio for the layer's lifetime.
 * Provide `Store` (e.g. `agent/Store.layer`) and a platform `Stdio`.
 */
export const layerStdio = <R>(
  agent: AcpAgent<R>,
  options?: ProcessStdio.Options
): Layer.Layer<never, AcpTransportError, R | Store | Stdio.Stdio> =>
  Layer.effectDiscard(Effect.forkScoped(serveStdio(agent, options)))

export type { ContentBlock, Prompt } from "./agent/Content.ts"
export { Store, StoreError } from "./agent/Store.ts"

const messageRole = (role: "agent" | "thought" | "user") => ({ agent: "agent_message", thought: "agent_thought", user: "user_message" })[role]

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const ElicitationCapabilities = Schema.Struct({ elicitation: Schema.optionalKey(Schema.NullOr(V2.ElicitationCapabilities)) })
const PeerInput = Schema.Struct({
  protocolVersion: Schema.Finite,
  info: Schema.optionalKey(Schema.NullOr(AcpProtocol.schemas[2].Implementation)),
  clientInfo: Schema.optionalKey(Schema.NullOr(AcpProtocol.schemas[1].Implementation)),
  capabilities: Schema.optionalKey(Schema.NullOr(ElicitationCapabilities)),
  clientCapabilities: Schema.optionalKey(Schema.NullOr(ElicitationCapabilities))
})
const CreateInput = Schema.Struct({ cwd: Schema.String,
  additionalDirectories: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  mcpServers: Schema.optionalKey(Schema.NullOr(Schema.Array(McpServer))) })
const SessionInput = Schema.Struct({ sessionId: Schema.String })
const PromptInput = Schema.Struct({ sessionId: Schema.String, prompt: Schema.Array(
  Schema.Union([V1.ContentBlock, V2.ContentBlock])) })
const ResumeInput = Schema.Struct({ sessionId: Schema.String, cwd: Schema.String,
  replayFrom: Schema.optionalKey(Schema.NullOr(Schema.Struct({ type: Schema.optionalKey(Schema.String) }))) })
const ListInput = Schema.Struct({ cwd: Schema.optionalKey(Schema.NullOr(Schema.String)) })
const LoginInput = Schema.Struct({ methodId: Schema.String })
const decodeInput = <A>(schema: Schema.Codec<A>, value: unknown) => Schema.decodeUnknownEffect(schema)(value).pipe(
  Effect.mapError(() => new AcpRemoteError({ code: ErrorCode.InvalidParams, message: "Invalid params" })))
