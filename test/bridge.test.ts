import { field } from "./support/field.ts"
import * as Json from "../src/internal/json.ts"
/**
 * Transparent relay semantics: order-preserving bidirectional forwarding,
 * opaque extension/batch handling, exactly-once release, and stalled-consumer
 * failure. Uses paired in-memory transports on both sides.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AcpBridge from "../src/AcpBridge.ts"
import type { Transport } from "../src/AcpTransport.ts"
import * as InMemory from "../src/transport/InMemory.ts"
import { driver } from "./support/driver.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>, timeoutMs?: number) => {
  const scoped = Effect.scoped(effect)
  const bound = timeoutMs === undefined ? scoped : Effect.timeout(scoped, `${timeoutMs} millis`)
  return Effect.runPromise(bound)
}

const setup = (options: { pressureDeadline?: Parameters<typeof AcpBridge.make>[0]["pressureDeadline"] } = {}) =>
  Effect.gen(function*() {
    const browserPair = yield* InMemory.make()
    const peerPair = yield* InMemory.make()
    const bridgeScope = yield* Scope.fork(yield* Scope.Scope)
    const browserClientScope = yield* Scope.fork(yield* Scope.Scope)

    const browserClient = yield* Scope.provide(browserPair.left, browserClientScope)
    const browserBridge = yield* Scope.provide(browserPair.right, bridgeScope)
    const peerBridge = yield* Scope.provide(peerPair.left, bridgeScope)
    const peerClient = yield* peerPair.right

    let releases = 0
    const bridge = yield* AcpBridge.make({
      browser: browserBridge,
      peer: peerBridge,
      pressureDeadline: options.pressureDeadline,
      release: Effect.andThen(Effect.sync(() => {
        releases++
      }), Scope.close(bridgeScope, Exit.void))
    })

    const browser = yield* driver(browserClient)
    const peer = yield* driver(peerClient)
    return {
      bridge,
      browser,
      peer,
      bridgeScope,
      browserClientScope,
      releases: () => releases,
      disconnectBrowser: Scope.close(browserClientScope, Exit.void)
    }
  })

describe("AcpBridge", () => {
  test("forwards responses, requests, notifications, and batches in both directions with ids intact", () =>
    run(Effect.gen(function*() {
      const { browser, peer } = yield* setup()

      yield* peer.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } })
      expect(yield* browser.next).toEqual({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 2 } })

      yield* browser.send({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 2 } })
      expect(yield* peer.next).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 2 } })

      yield* peer.send({ jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "agent_message_chunk" } })
      expect(yield* browser.next).toEqual({ jsonrpc: "2.0", method: "session/update", params: { sessionUpdate: "agent_message_chunk" } })

      yield* peer.send({
        jsonrpc: "2.0",
        id: 7,
        method: "session/request_permission",
        params: { sessionId: "s", toolCall: { toolCallId: "t" }, options: [] }
      })
      expect(yield* browser.next).toMatchObject({ id: 7, method: "session/request_permission" })

      yield* browser.send({ jsonrpc: "2.0", id: 7, result: { outcome: { outcome: "selected", optionId: "allow" } } })
      expect(yield* peer.next).toMatchObject({ id: 7, result: { outcome: { outcome: "selected", optionId: "allow" } } })

      const batch: import("effect/Schema").Json = [
        { jsonrpc: "2.0", id: 10, method: "session/new", params: { cwd: "/", mcpServers: [] } },
        { jsonrpc: "2.0", method: "log", params: { level: "info" } }
      ]
      yield* browser.send(batch)
      expect(yield* peer.next).toEqual(batch)
    }), 10_000))

  test("unknown extension frames and malformed JSON cross verbatim and uninterpreted", () =>
    run(Effect.gen(function*() {
      const { browser, peer } = yield* setup()
      const extension = `{"jsonrpc":"2.0","id":42,"method":"x/vendor/custom","params":{"meta":{"deep":[1,2,{"z":true}]},"blob":"<>&","n":null}}`
      yield* browser.send(extension)
      expect(yield* peer.next).toEqual((yield* Json.decode(extension)))
      expect(peer.received.at(-1)).toBe(extension)

      yield* browser.send("{not valid json]")
      for (let i = 0; i < 200 && !peer.received.includes("{not valid json]"); i++) yield* Effect.sleep("5 millis")
      expect(peer.received.includes("{not valid json]")).toBe(true)

      yield* peer.send(`"bare string frame"`)
      expect(yield* browser.poll()).toMatchObject({ _tag: "Some", value: "bare string frame" })
    }), 10_000))

  test("preserves per-direction order across many frames and interleaved directions", () =>
    run(Effect.gen(function*() {
      const { browser, peer } = yield* setup()
      for (let i = 0; i < 25; i++) yield* browser.send({ jsonrpc: "2.0", id: i, method: "m", params: { i } })
      while (peer.received.length < 25) yield* Effect.sleep("5 millis")
      expect((yield* Effect.forEach(peer.received, (frame) => Json.decode(frame))).map((value) => field(value, "id"))).toEqual(
        Array.from({ length: 25 }, (_, i) => i)
      )

      for (let i = 0; i < 25; i++) yield* peer.send({ jsonrpc: "2.0", id: 100 + i, method: "m" })
      while (browser.received.length < 25) yield* Effect.sleep("5 millis")
      expect((yield* Effect.forEach(browser.received, (frame) => Json.decode(frame))).map((value) => field(value, "id"))).toEqual(
        Array.from({ length: 25 }, (_, i) => 100 + i)
      )
    }), 10_000))

  test("a browser disconnect releases both owned transports exactly once and reports closure", () =>
    run(Effect.gen(function*() {
      const { bridge, peer, releases, disconnectBrowser } = yield* setup()
      yield* disconnectBrowser
      const reason = yield* bridge.closed
      expect(reason.side).toBe("browser")
      expect(releases()).toBe(1)

      // Closing the peer side after the fact does not release again.
      yield* peer.closed.pipe(Effect.timeoutOption("1 seconds"))
      yield* bridge.terminate("again", "peer")
      expect(releases()).toBe(1)
    }), 10_000))

  test("a stalled downstream write fails after the pressure deadline and releases both sides", () =>
    run(Effect.gen(function*() {
      const browserPair = yield* InMemory.make()
      const browserClient = yield* browserPair.left
      const browserBridge = yield* browserPair.right
      const stalled: Transport = { incoming: Stream.never, send: () => Effect.never }
      let releases = 0
      const bridge = yield* AcpBridge.make({
        browser: browserBridge,
        peer: stalled,
        pressureDeadline: "40 millis",
        release: Effect.sync(() => {
          releases++
        })
      })

      yield* browserClient.send(`{"jsonrpc":"2.0","id":1,"method":"session/prompt"}`)
      const reason = yield* bridge.closed
      expect(reason.message).toContain("pressure deadline")
      expect(reason.side).toBe("browser")
      expect(releases).toBe(1)

      const browserDriver = yield* driver(browserClient)
      void browserDriver
    }), 10_000))

  test("terminate() is idempotent and reports the explicit reason once", () =>
    run(Effect.gen(function*() {
      const { bridge, releases } = yield* setup()
      yield* bridge.terminate("operator closed", "peer")
      const reason = yield* bridge.closed
      expect(reason).toMatchObject({ message: "operator closed", side: "peer" })
      yield* bridge.terminate("later", "browser")
      expect(releases()).toBe(1)
    }), 10_000))
})
