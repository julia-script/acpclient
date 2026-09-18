import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import type * as Scope from "effect/Scope"
import * as AcpConnection from "../src/AcpConnection.ts"
import * as AcpConnector from "../src/AcpConnector.ts"
import * as AcpProtocol from "../src/AcpProtocol.ts"
import * as InMemory from "../src/transport/InMemory.ts"
import { driver } from "./support/driver.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect))

const info = { name: "test-client", version: "0.0.0" }
const v1Params = { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }
const v2Params = { info, capabilities: {} }
const v1Response = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
  authMethods: []
}
const v2Response = { protocolVersion: 2, info: { name: "agent", version: "1" }, capabilities: { session: {} } }

/** Runs `connect` against a raw scripted agent that answers initialize with `answer`. */
const negotiate = (options: AcpProtocol.ConnectOptions, answer: (request: any) => unknown) =>
  Effect.gen(function*() {
    const { left, right } = yield* InMemory.make()
    const agent = yield* Effect.flatMap(right, driver)
    const connecting = yield* Effect.forkChild(
      AcpProtocol.connect(options).pipe(Effect.provide(AcpConnector.layer(left)))
    )
    const request = yield* agent.next
    yield* agent.send({ jsonrpc: "2.0", id: request.id, result: answer(request) })
    const exit = yield* Fiber.await(connecting)
    return { exit, request, agent }
  })

describe("version negotiation", () => {
  test("v1 is the default and sends v1 params", () =>
    run(Effect.gen(function*() {
      const { exit, request } = yield* negotiate({ params: v1Params }, () => v1Response)
      expect(request).toEqual({ jsonrpc: "2.0", id: 0, method: "initialize", params: { ...v1Params, protocolVersion: 1 } })
      expect(exit._tag).toBe("Success")
      if (exit._tag === "Success") expect(exit.value.negotiated.version).toBe(1)
    })))

  test("opt-in v2 negotiates v2 and advertises nothing beyond the supplied baseline params", () =>
    run(Effect.gen(function*() {
      const { exit, request } = yield* negotiate({ versions: [2, 1], params: v2Params }, () => v2Response)
      expect(request.params).toEqual({ protocolVersion: 2, info, capabilities: {} })
      if (exit._tag !== "Success") throw new Error("expected success")
      const { negotiated } = exit.value
      expect(negotiated.version).toBe(2)
      expect(negotiated.response).toEqual(v2Response)
    })))

  test("v2 preference accepts a valid v1 downgrade and keeps the actual advertisement", () =>
    run(Effect.gen(function*() {
      const { exit } = yield* negotiate({ versions: [2, 1], params: v2Params }, () => v1Response)
      if (exit._tag !== "Success") throw new Error("expected success")
      const { negotiated } = exit.value
      expect(negotiated.version).toBe(1)
      expect(negotiated.response).toEqual(v1Response)
      expect(negotiated.advertised).toEqual({ version: 2, params: { protocolVersion: 2, info, capabilities: {} } })
      // no v1 client execution capabilities were advertised
      expect("clientCapabilities" in negotiated.advertised.params).toBe(false)
    })))

  test("responses are validated strictly with the selected version's codec", () =>
    run(Effect.gen(function*() {
      const invalidV1 = yield* negotiate({ versions: [2, 1], params: v2Params }, () => ({ ...v1Response, authMethods: "x" }))
      expect(invalidV1.exit._tag).toBe("Failure")
      expect(JSON.stringify(invalidV1.exit)).toContain("AcpProtocolError")
      yield* invalidV1.agent.closed
      const v2WithoutInfo = yield* negotiate({ versions: [2], params: v2Params }, () => ({ protocolVersion: 2 }))
      expect(JSON.stringify(v2WithoutInfo.exit)).toContain("Invalid v2 initialize response")
      yield* v2WithoutInfo.agent.closed
    })))

  test("an unsupported version fails and releases the transport without further requests", () =>
    run(Effect.gen(function*() {
      for (
        const [options, answer] of [
          [{ versions: [2, 1], params: v2Params }, { ...v2Response, protocolVersion: 3 }],
          [{ params: v1Params }, v2Response],
          [{ versions: [2], params: v2Params }, v1Response]
        ] as const
      ) {
        const { exit, agent } = yield* negotiate(options as AcpProtocol.ConnectOptions, () => answer)
        expect(exit._tag).toBe("Failure")
        expect(JSON.stringify(exit)).toContain("AcpUnsupportedVersion")
        yield* agent.closed
        expect(agent.received).toHaveLength(1)
      }
    })))

  test("an initialized connection is never initialized again", () =>
    run(Effect.gen(function*() {
      const [client, agentEnd] = yield* InMemory.makePair()
      const agent = yield* driver(agentEnd)
      const connection = yield* AcpConnection.make(client, { handlers: {} })
      const first = yield* Effect.forkChild(AcpProtocol.initialize(connection, { params: v1Params }))
      const request = yield* agent.next
      yield* agent.send({ jsonrpc: "2.0", id: request.id, result: v1Response })
      yield* Fiber.join(first)
      const again = yield* Effect.flip(AcpProtocol.initialize(connection, { params: v1Params }))
      expect(again).toMatchObject({ _tag: "AcpProtocolError" })
      expect(agent.received).toHaveLength(1)
    })))

  test("handlers are chosen for the negotiated version before incoming messages dispatch", () =>
    run(Effect.gen(function*() {
      const versions: Array<number> = []
      const { exit, agent } = yield* negotiate({
        versions: [2, 1],
        params: v2Params,
        handlers: (negotiated) => {
          versions.push(negotiated.version)
          return { request: () => Effect.succeed({ version: negotiated.version }) }
        }
      }, () => v1Response)
      expect(exit._tag).toBe("Success")
      yield* agent.send({ jsonrpc: "2.0", id: 0, method: "_probe" })
      expect(yield* agent.next).toEqual({ jsonrpc: "2.0", id: 0, result: { version: 1 } })
      expect(versions).toEqual([1])
    })))
})
