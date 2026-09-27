import { expect, expectTypeOf, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AcpConnection from "../src/AcpConnection.ts"
import * as AcpConnector from "../src/AcpConnector.ts"
import { AcpTransport, type Transport } from "../src/AcpTransport.ts"
import * as InMemory from "../src/transport/InMemory.ts"
import { driver } from "./support/driver.ts"

class EndpointConfig extends Context.Service<EndpointConfig, { readonly label: string }>()("test/EndpointConfig") {}

it.effect("connection consumers use the transport service through Layers", () => Effect.scoped(Effect.gen(function*() {
  const pair = yield* InMemory.make()
  const peer = yield* Effect.flatMap(pair.right, driver)
  yield* Effect.forkScoped(Effect.gen(function*() {
    expect(yield* peer.next).toMatchObject({ method: "echo", id: 0 })
    yield* peer.send({ jsonrpc: "2.0", id: 0, result: "from peer" })
  }))
  const reply = yield* Effect.gen(function*() {
    const connection = yield* AcpConnection.AcpConnection
    return yield* connection.requestRaw("echo", {})
  }).pipe(Effect.provide(AcpConnection.layer().pipe(Layer.provide(InMemory.layer(pair.left)))))
  expect(reply).toBe("from peer")
})))

it.effect("a connector captures dependencies and acquires separate transport lifetimes", () => Effect.scoped(Effect.gen(function*() {
  let opened = 0
  const closed: Array<number> = []
  const writes: Array<string> = []
  const acquire = Effect.gen(function*() {
    const config = yield* EndpointConfig
    const id = yield* Effect.acquireRelease(Effect.sync(() => ++opened), (id) => Effect.sync(() => { closed.push(id) }))
    return AcpTransport.of({ incoming: Stream.never, send: (frame) => Effect.sync(() => { writes.push(`${config.label}:${id}:${frame}`) }) })
  })
  const connectorLayer = AcpConnector.layer(Layer.effect(AcpTransport, acquire)).pipe(
    Layer.provide(Layer.succeed(EndpointConfig, { label: "injected" }))
  )
  const connector = yield* AcpConnector.AcpConnector.pipe(Effect.provide(connectorLayer))
  expect(opened).toBe(0)
  const firstScope = yield* Scope.fork(yield* Scope.Scope)
  const secondScope = yield* Scope.fork(yield* Scope.Scope)
  const first = yield* Scope.provide(connector.connect, firstScope)
  const second = yield* Scope.provide(connector.connect, secondScope)
  expect(first).not.toBe(second)
  expect(opened).toBe(2)
  yield* Scope.close(firstScope, Exit.void)
  expect(closed).toEqual([1])
  yield* second.send("still live")
  expect(writes).toEqual(["injected:2:still live"])
  yield* Scope.close(secondScope, Exit.void)
  expect(closed).toEqual([1, 2])
})))

it("the connection declares its transport dependency", () => {
  expectTypeOf<Effect.Services<ReturnType<typeof AcpConnection.make>>>().toEqualTypeOf<AcpTransport | Scope.Scope>()
  expectTypeOf<AcpTransport["Service"]>().toEqualTypeOf<Transport>()
})
