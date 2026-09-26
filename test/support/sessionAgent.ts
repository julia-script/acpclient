import * as Layer from "effect/Layer"
import { AcpTransport } from "../../src/AcpTransport.ts"
import type * as Schema from "effect/Schema"
import * as Json from "../../src/internal/json.ts"
/**
 * A scriptable ACP agent for `AcpClient` tests.
 *
 * Like `fixtures/agent.ts` it speaks raw JSON and does not import the
 * library, so the client is checked against the wire rather than against
 * itself. Unlike that fixture it is controllable from the test: a test can
 * hold a lifecycle response open, push updates at a chosen moment, and
 * answer requests on demand, which is what the ordering scenarios need.
 */
import * as Deferred from "effect/Deferred"
import * as Exit from "effect/Exit"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AcpConnector from "../../src/AcpConnector.ts"
import * as InMemory from "../../src/transport/InMemory.ts"

type RequestId = string | number | null

export interface AgentOptions {
  readonly uniqueSessions?: boolean
  readonly version: 1 | 2
  /** Replaces the default initialize result. */
  readonly initialize?: Record<string, unknown>
  /** Held open until the test releases it, to test update-before-response. */
  readonly holdNewSession?: boolean
}

export interface ScriptedAgent {
  readonly disconnect: Effect.Effect<void>
  readonly connector: Layer.Layer<AcpConnector.AcpConnector>
  /** Sends a raw JSON-RPC message to the client. */
  readonly send: (message: unknown) => Effect.Effect<void, Schema.SchemaError>
  /** Sends one `session/update` notification. */
  readonly update: (sessionId: string, update: unknown) => Effect.Effect<void, Schema.SchemaError>
  /** Answers a request the client sent, by method name, with `result`. */
  readonly respond: (method: string, result: unknown) => Effect.Effect<void, Schema.SchemaError>
  /** Answers a request with a JSON-RPC error. */
  readonly respondError: (method: string, code: number, message: string) => Effect.Effect<void, Schema.SchemaError>
  /** Waits for the client to send `method` and returns its params. */
  readonly awaitRequest: (method: string) => Effect.Effect<unknown>
  /** Waits for the client's response to an agent request. */
  readonly awaitReply: (id: RequestId) => Effect.Effect<Record<string, unknown>>
  /** Every message the client sent, in order. */
  readonly received: Effect.Effect<ReadonlyArray<Record<string, unknown>>>
  /** Releases a held `session/new`. */
  readonly releaseNewSession: (result: unknown) => Effect.Effect<void>
}

const defaultInitialize = (version: 1 | 2): Record<string, unknown> =>
  version === 2
    ? {
      protocolVersion: 2,
      info: { name: "scripted-agent", version: "1.0.0" },
      capabilities: { session: { delete: {}, additionalDirectories: {}, mcp: { stdio: {} }, prompt: { image: {} } } },
      authMethods: [{ type: "agent", methodId: "oauth", name: "OAuth" }]
    }
    : {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        // v1 spells prompt and MCP capabilities as booleans, not objects.
        promptCapabilities: { image: true },
        mcpCapabilities: { http: false },
        sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {}, additionalDirectories: {} },
        auth: { logout: {} }
      },
      // v1 names the auth method identifier `id`; v2 names it `methodId`.
      authMethods: [{ id: "oauth", name: "OAuth" }]
    }

export const scriptedAgent = (
  options: AgentOptions
): Effect.Effect<ScriptedAgent, never, Scope.Scope> =>
  Effect.gen(function*() {
    const received: Array<Record<string, unknown>> = []
    let sessions = 0
    let disconnect: Effect.Effect<void> = Effect.void
    // Requests the client has sent that the agent has not answered yet.
    const openRequests = new Map<string, Array<{ readonly id: RequestId; readonly params: unknown }>>()
    const arrivals = new Map<string, Array<Deferred.Deferred<unknown>>>()
    const replies = new Map<RequestId, Deferred.Deferred<Record<string, unknown>>>()
    const outbox = yield* Queue.unbounded<string>()
    let held = yield* Deferred.make<unknown>()

    const emit = (message: unknown) => Json.encode(message).pipe(Effect.flatMap((text) => Queue.offer(outbox, text)))

    const noteArrival = (method: string, id: RequestId | undefined, params: unknown) =>
      Effect.suspend(() => {
        const waiting = arrivals.get(method)?.shift()
        if (id !== undefined) {
          const entry = { id, params }
          const open = openRequests.get(method) ?? []
          open.push(entry)
          openRequests.set(method, open)
        }
        return waiting === undefined ? Effect.void : Effect.asVoid(Deferred.succeed(waiting, params))
      })

    /** Answers the requests the agent handles itself, so tests need not. */
    const autoRespond = (method: string, id: RequestId | undefined) => {
      switch (method) {
        case "initialize":
          return emit({ jsonrpc: "2.0", id, result: options.initialize ?? defaultInitialize(options.version) })
        case "session/new":
          return options.holdNewSession
            ? Effect.flatMap(Deferred.await(held), (result) => Effect.gen(function*() {
              held = yield* Deferred.make<unknown>()
              yield* emit({ jsonrpc: "2.0", id, result })
            }))
            : emit({ jsonrpc: "2.0", id, result: { sessionId: options.uniqueSessions ? `sess-${++sessions}` : "sess-1", ...(options.version === 1 ? { modes: { currentModeId: "architect", availableModes: [{ id: "architect", name: "Architect" }] } } : {}) } })
        default:
          // Everything else is answered explicitly by the test.
          return Effect.void
      }
    }

    const onLine = (line: string) =>
      Effect.gen(function*() {
        const parsed = yield* Json.decode(line)
        if (!isRecord(parsed)) return yield* Effect.die("Expected a JSON-RPC object")
        const message = parsed
        received.push(message)
        if (typeof message?.method !== "string") {
          const waiting = replies.get(message.id as RequestId)
          if (waiting !== undefined) yield* Deferred.succeed(waiting, message)
          return
        }
        const id = message.id
        if (id !== undefined && id !== null && typeof id !== "string" && typeof id !== "number") {
          return yield* Effect.die("Invalid JSON-RPC request id")
        }
        return yield* Effect.andThen(
          noteArrival(message.method, id, message.params),
          autoRespond(message.method, id)
        )
      })

    const connect = Effect.gen(function*() {
      const pair = yield* InMemory.make({ capacity: 256 })
      const agentScope = yield* Scope.make()
      disconnect = Scope.close(agentScope, Exit.void)
      const agentEnd = yield* Scope.provide(pair.right, agentScope)
      yield* Stream.fromQueue(outbox).pipe(Stream.runForEach(agentEnd.send), Effect.ignore, Effect.forkIn(agentScope))
      yield* agentEnd.incoming.pipe(
        Stream.runForEach(onLine),
        Effect.ignore,
        Effect.andThen(Scope.close(agentScope, Exit.void)),
        Effect.forkDetach
      )
      yield* Scope.addFinalizerExit(yield* Scope.Scope, () => Scope.close(agentScope, Exit.void))
      return yield* pair.left
    })

    const take = (method: string) =>
      Effect.suspend(() => {
        const open = openRequests.get(method)
        const entry = open?.shift()
        return entry === undefined
          ? Effect.die(new Error(`No open ${method} request`))
          : Effect.succeed(entry)
      })

    return {
      connector: AcpConnector.layer(Layer.effect(AcpTransport, connect)),
      disconnect: Effect.suspend(() => disconnect),
      send: emit,
      update: (sessionId, update) =>
        emit({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }),
      respond: (method, result) =>
        Effect.flatMap(take(method), (entry) => emit({ jsonrpc: "2.0", id: entry.id, result })),
      respondError: (method, code, message) =>
        Effect.flatMap(take(method), (entry) => emit({ jsonrpc: "2.0", id: entry.id, error: { code, message } })),
      awaitRequest: (method) =>
        Effect.suspend(() => {
          const open = openRequests.get(method)
          // Already arrived: answer from the backlog rather than waiting.
          if (open !== undefined && open.length > 0) return Effect.succeed(open[0]!.params)
          const deferred = Deferred.makeUnsafe<unknown>()
          const waiting = arrivals.get(method) ?? []
          waiting.push(deferred)
          arrivals.set(method, waiting)
          return Deferred.await(deferred)
        }),
      awaitReply: (id) =>
        Effect.suspend(() => {
          const reply = received.find((message) => message.id === id && typeof message.method !== "string")
          if (reply !== undefined) return Effect.succeed(reply)
          const deferred = replies.get(id) ?? Deferred.makeUnsafe<Record<string, unknown>>()
          replies.set(id, deferred)
          return Deferred.await(deferred)
        }),
      received: Effect.sync(() => received.slice()),
      releaseNewSession: (result) => Effect.asVoid(Deferred.succeed(held, result))
    } satisfies ScriptedAgent
  })

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
