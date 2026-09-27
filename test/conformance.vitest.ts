import * as Schema from "effect/Schema"
import { field } from "./support/field.ts"
import { failure } from "./support/failure.ts"
/**
 * Foundation conformance scenarios, run against the independent fixture agent
 * for both protocol versions over both in-memory and stdio compositions.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as AcpConnection from "../src/AcpConnection.ts"
import * as AcpProtocol from "../src/AcpProtocol.ts"
import * as V1 from "../src/protocol/v1/Schema.ts"
import * as V2 from "../src/protocol/v2/Schema.ts"
import type { AgentOptions } from "./fixtures/agent.ts"
import { type Compose, inMemory, stdio } from "./support/compositions.ts"
import { isStandardFrame } from "./support/driver.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.scoped(effect)

const policy = (version: 1 | 2): AcpProtocol.InitializeOptions =>
  version === 1
    ? { params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } } }
    : { versions: [2, 1], params: { info: { name: "conformance", version: "0" }, capabilities: {} } }

const fixtureEcho: AcpConnection.Handlers = {
  request: (method) => method === "_fixture/echo" ? Effect.succeed({ echo: true }) : undefined
}

const clientHandlers = (updates: Array<string>) => (negotiated: AcpProtocol.Negotiated) =>
  negotiated.version === 1
    ? AcpConnection.handlers([
      AcpConnection.onRequest(
        V1.clientMethods["session/request_permission"],
        () => Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "allow" } })
      ),
      AcpConnection.onNotification(V1.clientMethods["session/update"], ({ update }) =>
        Effect.sync(() => updates.push(update.sessionUpdate)))
    ], fixtureEcho)
    : AcpConnection.handlers([
      AcpConnection.onRequest(
        V2.clientMethods["session/request_permission"],
        () => Effect.succeed({ outcome: { outcome: "selected" as const, optionId: "allow" } })
      ),
      AcpConnection.onNotification(V2.clientMethods["session/update"], ({ update }) =>
        Effect.sync(() => updates.push(update.sessionUpdate)))
    ], fixtureEcho)

const open = (compose: Compose, agent: AgentOptions, options = policy(agent.version)) =>
  Effect.gen(function*() {
    const composition = yield* compose(agent)
    const scope = yield* Scope.fork(yield* Scope.Scope)
    const updates: Array<string> = []
    const connected = yield* AcpProtocol.connect({ ...options, handlers: clientHandlers(updates) }).pipe(
      Effect.provide(composition.connector),
      Scope.provide(scope)
    )
    return { ...connected, composition, scope, updates }
  })

const compositions: ReadonlyArray<readonly [string, Compose]> = [["in-memory", inMemory], ["stdio", stdio]]

for (const [name, compose] of compositions) {
  // The process composition needs live time; the in-memory peer uses test services.
  const check = name === "stdio" ? it.live : it.effect
  describe(`conformance over ${name}`, () => {
    check("v1 by default, opt-in v2, and v2 preference downgrading to v1", () =>
      run(Effect.gen(function*() {
        expect((yield* open(compose, { version: 1 })).negotiated.version).toBe(1)
        expect((yield* open(compose, { version: 2 })).negotiated.version).toBe(2)
        const downgraded = yield* open(compose, { version: 1 }, policy(2))
        expect(downgraded.negotiated.version).toBe(1)
        expect(downgraded.negotiated.advertised.version).toBe(2)
      })), 20_000)

    check("unsupported version fails and releases the agent", () =>
      run(Effect.gen(function*() {
        const composition = yield* compose({ version: 2, mode: "unsupported" })
        const error = yield* failure(Effect.scoped(
          AcpProtocol.connect(policy(2)).pipe(Effect.provide(composition.connector))
        ))
        expect(error).toMatchObject({ _tag: "AcpUnsupportedVersion" })
        yield* composition.released
      })), 20_000)

    for (const version of [1, 2] as const) {
      check(`v${version}: reverse request with a colliding id during a prompt, plus ordered notifications`, () =>
        run(Effect.gen(function*() {
          const { connection, negotiated, updates } = yield* open(compose, { version })
          expect(negotiated.version).toBe(version)
          if (negotiated.version === 1) {
            const { sessionId } = yield* connection.request(V1.agentMethods["session/new"], { cwd: "/", mcpServers: [] })
            const result = yield* connection.request(V1.agentMethods["session/prompt"], {
              sessionId,
              prompt: [{ type: "text", text: "hi" }]
            })
            expect(result).toEqual({ stopReason: "end_turn", _meta: { optionId: "allow" } })
            expect(updates).toEqual(["agent_message_chunk"])
          } else {
            const { sessionId } = yield* connection.request(V2.agentMethods["session/new"], { cwd: "/" })
            const result = yield* connection.request(V2.agentMethods["session/prompt"], {
              sessionId,
              prompt: [{ type: "text", text: "hi" }]
            })
            expect(result).toEqual({ messageId: "m-1", _meta: { optionId: "allow" } })
            for (let i = 0; i < 100 && updates.length < 2; i++) {
              yield* name === "stdio" ? Effect.sleep("10 millis") : Effect.yieldNow
            }
            expect(updates).toEqual(["agent_message_chunk", "state_update"])
          }
        })), 20_000)

      check(`v${version}: malformed JSON, unknown methods, and mixed batches get JSON-RPC answers`, () =>
        run(Effect.gen(function*() {
          const { connection } = yield* open(compose, { version })
          const report = yield* Effect.flatMap(connection.send("_fixture/malformed", {}), (p) => p.response)
          expect(field(report, "parse")).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })
          expect(field(report, "unknown")).toEqual({ jsonrpc: "2.0", id: "u-1", error: { code: -32601, message: "Method not found" } })
          expect(field(report, "batch.batch")).toHaveLength(2)
          expect(field(report, "batch.batch")).toContainEqual({ jsonrpc: "2.0", id: "b-1", result: { echo: true } })
          expect(field(report, "batch.batch")).toContainEqual({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32600, message: "Invalid Request" }
          })
        })), 20_000)

      check(`v${version}: request cancellation is confirmed by the agent`, () =>
        run(Effect.gen(function*() {
          const { connection } = yield* open(compose, { version })
          const pending = yield* connection.send("_fixture/slow", {})
          yield* connection.cancelRequest(pending.id)
          expect(yield* failure(pending.response)).toMatchObject({ _tag: "AcpRemoteError", code: -32800 })
        })), 20_000)

      check(`v${version}: only standard JSON-RPC reaches the wire`, () =>
        run(Effect.gen(function*() {
          const { connection } = yield* open(compose, { version })
          const pending = yield* connection.send("_fixture/slow", {})
          yield* connection.cancelRequest(pending.id)
          yield* Effect.ignore(pending.response)
          yield* Effect.flatMap(connection.send("_fixture/malformed", {}), (p) => p.response)
          const { lines } = yield* Effect.flatMap(connection.send("_fixture/transcript", {}), (p) => p.response).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ lines: Schema.Array(Schema.String) }))))
          expect(lines.length).toBeGreaterThan(4)
          for (const line of lines) expect({ line, standard: isStandardFrame(line) }).toEqual({ line, standard: true })
        })), 20_000)

      check(`v${version}: agent exit fails pending calls and releases resources`, () =>
        run(Effect.gen(function*() {
          const { connection, composition } = yield* open(compose, { version })
          const pending = yield* connection.send("_fixture/slow", {})
          yield* connection.send("_fixture/crash", {})
          expect(yield* failure(pending.response)).toMatchObject({ _tag: "AcpConnectionClosed" })
          expect((yield* connection.closed)._tag).toBe("AcpConnectionClosed")
          expect(yield* connection.pendingRequests).toBe(0)
          yield* composition.released
        })), 20_000)

      check(`v${version}: closing the owner scope settles pending calls and releases the agent`, () =>
        run(Effect.gen(function*() {
          const { connection, composition, scope } = yield* open(compose, { version })
          const pending = yield* connection.send("_fixture/slow", {})
          yield* Scope.close(scope, Exit.void)
          expect(yield* failure(pending.response)).toMatchObject({ _tag: "AcpConnectionClosed" })
          yield* composition.released
        })), 20_000)
    }
  })
}
