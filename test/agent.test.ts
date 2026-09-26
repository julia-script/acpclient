import { AcpTransport } from "../src/AcpTransport.ts"
import { field } from "./support/field.ts"
import * as Json from "../src/internal/json.ts"
/**
 * AcpAgent behavior, checked from the wire with the scripted `driver` rather
 * than with the library's own client: the point is what the agent puts on the
 * socket, not that it agrees with itself.
 */
import { describe, expect, test } from "bun:test"
import * as Context from "effect/Context"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as AcpAgent from "../src/AcpAgent.ts"
import * as Store from "../src/agent/Store.ts"
import * as InMemory from "../src/transport/InMemory.ts"
import * as ProcessStdio from "../src/transport/ProcessStdio.ts"
import { driver } from "./support/driver.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | Store.Store>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(Store.layer)))

/** Minimal handlers any test can start from. */
const baseOptions = (): AcpAgent.Options => ({
  info: { name: "test-agent", version: "0.0.1" },
  versions: [2, 1],
  session: { create: () => Effect.succeed({ sessionId: "s-1" }) },
  prompt: {
    insert: () => Effect.succeed({ messageId: "m-1" }),
    execute: ({ emit }) => Effect.as(emit.agentChunk("m-1", { type: "text", text: "hi" }), "end_turn")
  }
})

/** Serves `agent` on one end of an in-memory pair and drives the other. */
const connect = (agent: AcpAgent.AcpAgent) =>
  Effect.gen(function*() {
    const [left, right] = yield* InMemory.makePair()
    yield* Effect.forkScoped(Effect.ignore(agent.serve.pipe(Effect.provideService(AcpTransport, right))))
    return yield* driver(left)
  })

const initialize = (version: 1 | 2, capabilities?: unknown) =>
  version === 2
    ? {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 2, info: { name: "test-client", version: "1.0.0" }, capabilities }
    }
    : {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: { protocolVersion: 1, clientInfo: { name: "test-client", version: "1.0.0" } }
    }

describe("capability validation", () => {
  test("advertising sessions without a create handler fails before serving", () => {
    // Deliberately bypass the public type to exercise validation for JS callers.
    expect(() =>
      AcpAgent.make({ ...baseOptions(), session: {} as never })
    ).toThrow(/session.create/)
  })

  test("advertising authentication methods without a logout handler fails", () => {
    expect(() =>
      AcpAgent.make({
        ...baseOptions(),
        auth: { methods: [{ methodId: "token", name: "Token" }], login: () => Effect.void }
      })
    ).toThrow(/auth.logout/)
  })

  test("advertising authentication methods without a login handler fails", () => {
    expect(() =>
      AcpAgent.make({
        ...baseOptions(),
        auth: { methods: [{ methodId: "token", name: "Token" }], logout: () => Effect.void }
      })
    ).toThrow(/auth.login/)
  })

  test("an empty method list needs no login or logout", () => {
    expect(() => AcpAgent.make({ ...baseOptions(), auth: { methods: [] } })).not.toThrow()
  })

  test("only surfaces with installed handlers are advertised", () =>
    run(Effect.gen(function*() {
      const agent = AcpAgent.make({ ...baseOptions(), session: { create: () => Effect.succeed({ sessionId: "s-1" }) } })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      const response = yield* peer.next
      // No delete handler, so no delete capability.
      expect(field(response, "result.capabilities.session.delete")).toBeUndefined()
      expect(field(response, "result.info.name")).toBe("test-agent")
    })))
})

describe("version negotiation", () => {
  test("a v1 client gets the v1 advertisement shape", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send(initialize(1))
      const response = yield* peer.next
      expect(field(response, "result.protocolVersion")).toBe(1)
      expect(field(response, "result.agentInfo.name")).toBe("test-agent")
      expect(field(response, "result.capabilities")).toBeUndefined()
    })))

  test("a version outside the enabled set is answered with our own, not accepted", () =>
    run(Effect.gen(function*() {
      const agent = AcpAgent.make({ ...baseOptions(), versions: [1] })
      const peer = yield* connect(agent)
      yield* peer.send({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: 2, info: { name: "test", version: "1" } } })
      const response = yield* peer.next
      expect(field(response, "result.protocolVersion")).toBe(1)
    })))

  test("requests before initialize are rejected", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      const response = yield* peer.next
      expect(field(response, "error.message")).toMatch(/Not initialized/)
    })))
})

describe("prompt insertion and execution", () => {
  test("v2 answers with the inserted message id and keeps emitting afterwards", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      const created = yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: field(created, "result.sessionId"), prompt: [{ type: "text", text: "hey" }] }
      })

      // Everything until the response, then everything after it.
      const frames: Array<unknown> = []
      for (let i = 0; i < 4; i++) frames.push(yield* peer.next)
      const response = frames.find((frame) => field(frame, "id") === 2)
      expect(field(response, "result.messageId")).toBe("m-1")
      expect(field(response, "result.stopReason")).toBeUndefined()

      const updates = frames.filter((frame) => field(frame, "method") === "session/update")
      const kinds = updates.map((frame) => field(frame, "params.update.sessionUpdate"))
      expect(kinds).toContain("agent_message_chunk")
      // The turn ends with an idle state update, not with the response.
      const idle = updates.find((frame) => field(frame, "params.update.state") === "idle")
      expect(field(idle, "params.update.stopReason")).toBe("end_turn")
      expect(frames.indexOf(response)).toBeLessThan(frames.indexOf(idle))
    })))

  test("a prompt whose insertion fails produces no acknowledgement", () =>
    run(Effect.gen(function*() {
      let executed = false
      const agent = AcpAgent.make({
        ...baseOptions(),
        prompt: {
          insert: () => Effect.fail(new AcpAgent.AcpAgentError({ message: "cannot insert" })),
          execute: () =>
            Effect.sync(() => {
              executed = true
              return "end_turn" as const
            })
        }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "s-1", prompt: [{ type: "text", text: "hey" }] }
      })
      const response = yield* peer.next
      expect(field(response, "error.message")).toBe("cannot insert")
      expect(field(response, "result")).toBeUndefined()
      expect(executed).toBe(false)
    })))

  test("v1 waits for the turn and answers with a stop reason", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send(initialize(1))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } })
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "s-1", prompt: [{ type: "text", text: "hey" }] }
      })
      const update = yield* peer.next
      // v1 chunks carry no messageId: the version has no message identities.
      expect(field(update, "params.update.sessionUpdate")).toBe("agent_message_chunk")
      expect(field(update, "params.update.messageId")).toBeUndefined()
      const response = yield* peer.next
      expect(field(response, "id")).toBe(2)
      expect(field(response, "result.stopReason")).toBe("end_turn")
      expect(field(response, "result.messageId")).toBeUndefined()
    })))

  test("prompting an unknown session is rejected", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 1,
        method: "session/prompt",
        params: { sessionId: "nope", prompt: [] }
      })
      const response = yield* peer.next
      expect(field(response, "error.code")).toBe(-32002)
      expect(field(response, "error.message")).toMatch(/Unknown session nope/)
    })))

  test("a handler defect becomes a bare Internal error, leaking no cause", () =>
    run(Effect.gen(function*() {
      const agent = AcpAgent.make({
        ...baseOptions(),
        session: { create: () => Effect.die(new Error("database password is hunter2")) }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      const response = yield* peer.next
      expect(field(response, "error.code")).toBe(-32603)
      expect(field(response, "error.message")).toBe("Internal error")
      expect((yield* Json.encode(response))).not.toContain("hunter2")
    })))
})

describe("client interactions", () => {
  test("a permission request uses the negotiated shape and does not block other traffic", () =>
    run(Effect.gen(function*() {
      const agent = AcpAgent.make({
        ...baseOptions(),
        list: true,
        prompt: {
          insert: () => Effect.succeed({ messageId: "m-1" }),
          execute: ({ client }) =>
            Effect.map(
              client.requestPermission({
                title: "Edit file",
                options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
              }),
              (choice) => choice === "allow" ? "end_turn" : "refusal"
            )
        }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "s-1", prompt: [{ type: "text", text: "hey" }] }
      })

      const frames: Array<unknown> = []
      let permission: unknown
      while (permission === undefined) {
        const frame = yield* peer.next
        frames.push(frame)
        if (field(frame, "method") === "session/request_permission") permission = frame
      }
      expect(field(permission, "params.title")).toBe("Edit file")
      // The prompt was already acknowledged: the agent is not blocked on us.
      expect(frames.some((frame) => field(frame, "id") === 2 && field(frame, "result.messageId") === "m-1")).toBe(true)

      // Unrelated traffic is answered while the permission request is pending:
      // the waiting handler fiber does not hold up the connection.
      yield* peer.send({ jsonrpc: "2.0", id: 3, method: "session/list", params: {} })
      let other: unknown
      while (other === undefined) {
        const frame = yield* peer.next
        if (field(frame, "id") === 3) other = frame
      }
      expect(field(other, "result.sessions")).toHaveLength(1)

      yield* peer.send({
        jsonrpc: "2.0",
        id: field(permission, "id"),
        result: { outcome: { outcome: "selected", optionId: "allow" } }
      })
      let idle: unknown
      while (idle === undefined) {
        const frame = yield* peer.next
        if (field(frame, "params.update.state") === "idle") idle = frame
      }
      expect(field(idle, "params.update.stopReason")).toBe("end_turn")
    })))

  test("an elicitation mode the client never advertised is rejected before sending", () =>
    run(Effect.gen(function*() {
      const attempted = Deferred.makeUnsafe<import("effect/Exit").Exit<import("../src/protocol/v2/Schema.ts").CreateElicitationResponse, AcpAgent.HandlerError>>()
      const agent = AcpAgent.make({
        ...baseOptions(),
        prompt: {
          insert: () => Effect.succeed({ messageId: "m-1" }),
          execute: ({ client }) =>
            client.elicit({ mode: "url", message: "open this" }).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.succeed(attempted, exit)),
              Effect.as("end_turn")
            )
        }
      })
      const peer = yield* connect(agent)
      // Advertise form elicitation only.
      yield* peer.send(initialize(2, { elicitation: { form: {} } }))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "s-1", prompt: [] }
      })
      const outcome = yield* Deferred.await(attempted)
      expect(field(outcome, "_tag")).toBe("Failure")
      // Nothing about elicitation reached the wire.
      expect(peer.received.some((frame) => frame.includes("elicitation/create"))).toBe(false)
    })))
})

describe("cancellation", () => {
  test("cancelling a v2 session emits final updates before the cancelled idle state", () =>
    run(Effect.gen(function*() {
      const started = Deferred.makeUnsafe<void>()
      const agent = AcpAgent.make({
        ...baseOptions(),
        prompt: {
          insert: () => Effect.succeed({ messageId: "m-1" }),
          execute: ({ emit }) =>
            Effect.andThen(Deferred.succeed(started, undefined), Effect.never).pipe(
              // A final update drained on interruption, before completion.
              Effect.onInterrupt(() => Effect.ignore(emit.agentChunk("m-1", { type: "text", text: "partial" }))),
              Effect.as("end_turn")
            )
        }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next
      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/prompt",
        params: { sessionId: "s-1", prompt: [] }
      })
      yield* Deferred.await(started)
      yield* peer.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } })

      const seen: Array<unknown> = []
      let idle: unknown
      while (idle === undefined) {
        const frame = yield* peer.next
        seen.push(frame)
        if (field(frame, "params.update.state") === "idle") idle = frame
      }
      expect(field(idle, "params.update.stopReason")).toBe("cancelled")
      const partial = seen.find((frame) => field(frame, "params.update.content.text") === "partial")
      expect(partial).toBeDefined()
      expect(seen.indexOf(partial)).toBeLessThan(seen.indexOf(idle))
    })))
})

describe("store-backed replay", () => {
  test("replay preserves the message id and resets content before appending chunks", () =>
    run(Effect.gen(function*() {
      const store = yield* Effect.service(Store.Store)
      const agent = AcpAgent.make({
        ...baseOptions(),
        session: {
          create: () => Effect.succeed({ sessionId: "s-1" }),
          resume: () => Effect.void
        }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next

      yield* store.retain({
        sessionId: "s-1",
        messageId: "kept-1",
        role: "agent",
        replacement: [{ type: "text", text: "final" }],
        chunks: [{ type: "text", text: " more" }],
        recordedAt: "2020-01-01T00:00:00Z"
      })

      yield* peer.send({
        jsonrpc: "2.0",
        id: 2,
        method: "session/resume",
        params: { sessionId: "s-1", cwd: "/tmp", replayFrom: { type: "start" } }
      })

      const updates: Array<unknown> = []
      let response: unknown
      while (response === undefined) {
        const frame = yield* peer.next
        if (field(frame, "id") === 2) response = frame
        else updates.push(frame)
      }
      expect(field(response, "error")).toBeUndefined()
      const full = updates.find((frame) => field(frame, "params.update.sessionUpdate") === "agent_message")
      const chunk = updates.find((frame) => field(frame, "params.update.sessionUpdate") === "agent_message_chunk")
      // The replacement resets prior content; the chunk appends to it. Both
      // carry the original identity.
      expect(field(full, "params.update.messageId")).toBe("kept-1")
      expect(field(full, "params.update.content")).toEqual([{ type: "text", text: "final" }])
      expect(field(chunk, "params.update.messageId")).toBe("kept-1")
      expect(updates.indexOf(full)).toBeLessThan(updates.indexOf(chunk))
    })))

  test("a full message replacement is refused on v1, which has no message identities", () =>
    run(Effect.gen(function*() {
      const outcome = Deferred.makeUnsafe<import("effect/Exit").Exit<void, AcpAgent.HandlerError>>()
      const agent = AcpAgent.make({
        ...baseOptions(),
        versions: [1],
        prompt: {
          insert: () => Effect.succeed({ messageId: "m-1" }),
          execute: ({ emit }) =>
            emit.message("agent", "m-1", [{ type: "text", text: "x" }]).pipe(
              Effect.exit,
              Effect.flatMap((exit) => Deferred.succeed(outcome, exit)),
              Effect.as("end_turn")
            )
        }
      })
      const peer = yield* connect(agent)
      yield* peer.send(initialize(1))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } })
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })
      const exit = yield* Deferred.await(outcome)
      expect(field(exit, "_tag")).toBe("Failure")
    })))

  test("session/list is advertised and answered only when enabled", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make({ ...baseOptions(), list: true }))
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 2, method: "session/list", params: {} })
      const response = yield* peer.next
      expect(field(response, "result.sessions")).toEqual([{ sessionId: "s-1", cwd: "/tmp", title: null, updatedAt: null }])
    })))

  test("v2 session/list is part of the baseline even without an optional list flag", () =>
    run(Effect.gen(function*() {
      const peer = yield* connect(AcpAgent.make(baseOptions()))
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} })
      const response = yield* peer.next
      expect(field(response, "result.sessions")).toEqual([])
    })))
})

describe("process stdio serving", () => {
  const decode = (chunk: string | Uint8Array) => typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)

  /** A `Stdio` layer over fixed stdin bytes that captures stdout and stderr. */
  const testStdio = (input: string) => {
    const out: Array<string> = []
    const err: Array<string> = []
    const into = (buffer: Array<string>) => Sink.forEach((chunk: string | Uint8Array) => Effect.sync(() => buffer.push(decode(chunk))))
    const layer = Layer.succeed(
      Stdio.Stdio,
      Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.make(new TextEncoder().encode(input)),
        stdout: () => into(out),
        stderr: () => into(err)
      })
    )
    return { out, err, layer }
  }

  test("stdout carries only ACP frames and diagnostics go to stderr", () =>
    run(Effect.gen(function*() {
      const { err, layer, out } = testStdio(
        `${(yield* Json.encode(initialize(2)))}\n` +
          `${(yield* Json.encode({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } }))}\n`
      )
      const agent = AcpAgent.make(baseOptions())
      yield* Effect.provide(
        Effect.gen(function*() {
          yield* ProcessStdio.diagnostic("starting up")
          const transport = yield* ProcessStdio.make()
          yield* Effect.forkScoped(Effect.ignore(agent.serve.pipe(Effect.provideService(AcpTransport, transport))))
          yield* Effect.sleep("200 millis")
        }),
        layer
      )
      const frames = out.join("").split("\n").filter((line) => line.trim() !== "")
      expect(frames.length).toBeGreaterThan(0)
      // Every stdout line is a JSON-RPC frame and nothing else.
      for (const frame of frames) expect(field(yield* Json.decode(frame), "jsonrpc")).toBe("2.0")
      expect(err.join("")).toContain("starting up")
      expect(out.join("")).not.toContain("starting up")
    })))
})

describe("author dependencies", () => {
  class Greeter extends Context.Service<Greeter, {
    readonly greet: (name: string) => string
  }>()("test/Greeter") {}
  const GreeterLayer = Layer.succeed(Greeter, Greeter.of({ greet: (name) => `hello ${name}` }))

  test("a handler's own services stay in the agent's requirements and are provided at serve time", () =>
    run(Effect.gen(function*() {
      // `R` is inferred from the handlers, not declared: the agent needs Greeter.
      const agent = AcpAgent.make({
        ...baseOptions(),
        session: {
          create: () =>
            Effect.map(Effect.service(Greeter), (greeter) => ({ sessionId: greeter.greet("session") }))
        }
      })
      const [left, right] = yield* InMemory.makePair()
      yield* Effect.forkScoped(
        Effect.ignore(Effect.provide(agent.serve.pipe(Effect.provideService(AcpTransport, right)), GreeterLayer))
      )
      const peer = yield* driver(left)
      yield* peer.send(initialize(2))
      yield* peer.next
      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp" } })
      const response = yield* peer.next
      expect(field(response, "result.sessionId")).toBe("hello session")
    })))
})

test("v1 session cancellation interrupts the owned turn and returns cancelled after final updates", () => run(Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  const agent = AcpAgent.make({ ...baseOptions(), prompt: {
    insert: () => Effect.succeed({ messageId: "m" }),
    execute: ({ emit }) => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.ignore(emit.agentChunk("m", { type: "text", text: "final" }))), Effect.as("end_turn"))
  } })
  const peer = yield* connect(agent)
  yield* peer.send(initialize(1)); yield* peer.next
  yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }); yield* peer.next
  yield* peer.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })
  yield* Deferred.await(started)
  yield* peer.send({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s-1" } })
  const final = yield* peer.next
  expect(field(final, "params.update.content.text")).toBe("final")
  const response = yield* peer.next
  expect(field(response, "result.stopReason")).toBe("cancelled")
})))

for (const method of ["session/close", "session/delete"] as const) {
  test(`v1 in-flight prompt completes as cancelled during ${method}`, () => run(Effect.gen(function*() {
    const started = yield* Deferred.make<void>()
    const agent = AcpAgent.make({ ...baseOptions(), session: {
      create: () => Effect.succeed({ sessionId: "s-1" }),
      close: () => Effect.void,
      delete: () => Effect.void
    }, prompt: {
      insert: () => Effect.succeed({ messageId: "m" }),
      execute: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
    } })
    const peer = yield* connect(agent)
    yield* peer.send(initialize(1)); yield* peer.next
    yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }); yield* peer.next
    yield* peer.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })
    yield* Deferred.await(started)
    yield* peer.send({ jsonrpc: "2.0", id: 3, method, params: { sessionId: "s-1" } })
    const replies = [yield* peer.next, yield* peer.next]
    expect(replies).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 2, result: { stopReason: "cancelled" } }),
      expect.objectContaining({ id: 3, result: {} })
    ]))
  })))
}

test("v1 close does not turn an interruption-time defect into cancellation", () => run(Effect.gen(function*() {
  const started = yield* Deferred.make<void>()
  const agent = AcpAgent.make({ ...baseOptions(), session: {
    create: () => Effect.succeed({ sessionId: "s-1" }),
    close: () => Effect.void
  }, prompt: {
    insert: () => Effect.succeed({ messageId: "m" }),
    execute: () => Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.die(new Error("private defect")))
    )
  } })
  const peer = yield* connect(agent)
  yield* peer.send(initialize(1)); yield* peer.next
  yield* peer.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/tmp", mcpServers: [] } }); yield* peer.next
  yield* peer.send({ jsonrpc: "2.0", id: 2, method: "session/prompt", params: { sessionId: "s-1", prompt: [] } })
  yield* Deferred.await(started)
  yield* peer.send({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: "s-1" } })
  const replies = [yield* peer.next, yield* peer.next]
  expect(replies).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 2, error: { code: -32603, message: "Internal error" } }),
    expect.objectContaining({ id: 3, result: {} })
  ]))
})))

test("store appends chunks without losing previous chunks or replacement content", () => run(Effect.gen(function*() {
  const store = yield* Store.Store
  yield* store.create({ sessionId: "s", cwd: "/tmp" })
  const message = { sessionId: "s", messageId: "m", role: "agent" as const, recordedAt: "2026-01-01T00:00:00Z" }
  yield* store.retain({ ...message, replacement: [{ type: "text", text: "base" }], chunks: [] })
  for (const text of ["one", "two"]) yield* store.retain({ ...message, replacement: null, chunks: [{ type: "text", text }] })
  const [retained] = yield* store.retained("s")
  expect(retained!.replacement).toEqual([{ type: "text", text: "base" }])
  expect(retained!.chunks).toEqual([{ type: "text", text: "one" }, { type: "text", text: "two" }])
})))
