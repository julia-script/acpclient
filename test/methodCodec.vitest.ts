import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as AcpConnection from "../src/AcpConnection.ts"
import * as AcpSchema from "../src/AcpSchema.ts"
import { AcpTransport } from "../src/AcpTransport.ts"
import * as InMemory from "../src/transport/InMemory.ts"
import { driver } from "./support/driver.ts"
import { field } from "./support/field.ts"

const Params = Schema.Struct({ value: Schema.FiniteFromString })
const Convert = AcpSchema.request("test/convert", Params, Schema.FiniteFromString)
const Notice = AcpSchema.notification("test/notice", Params)

describe("transforming method codecs", () => {
  it.effect("outgoing calls encode params and decode results", () => Effect.scoped(Effect.gen(function*() {
    const pair = yield* InMemory.make({ capacity: 8 })
    const connection = yield* AcpConnection.make().pipe(Effect.provideService(AcpTransport, yield* pair.left))
    const peer = yield* pair.right.pipe(Effect.flatMap(driver))

    const pending = yield* Effect.forkChild(connection.request(Convert, { value: 7 }))
    const sent = yield* peer.next
    expect(sent).toMatchObject({ jsonrpc: "2.0", method: "test/convert", params: { value: "7" } })
    yield* peer.send({ jsonrpc: "2.0", id: field(sent, "id"), result: "12" })
    expect(yield* Fiber.join(pending)).toBe(12)

    yield* connection.notify(Notice, { value: 8 })
    expect(yield* peer.next).toMatchObject({ jsonrpc: "2.0", method: "test/notice", params: { value: "8" } })
  })))

  it.effect("incoming handlers receive decoded params and encode results", () => Effect.scoped(Effect.gen(function*() {
    const observed = yield* Deferred.make<number>()
    const pair = yield* InMemory.make({ capacity: 8 })
    const connection = yield* AcpConnection.make({
      handlers: AcpConnection.handlers([
        AcpConnection.onRequest(Convert, ({ value }) => Effect.succeed(value + 1)),
        AcpConnection.onNotification(Notice, ({ value }) => Deferred.succeed(observed, value))
      ])
    }).pipe(Effect.provideService(AcpTransport, yield* pair.left))
    const peer = yield* pair.right.pipe(Effect.flatMap(driver))

    yield* peer.send({ jsonrpc: "2.0", id: 3, method: "test/convert", params: { value: "4" } })
    expect(yield* peer.next).toEqual({ jsonrpc: "2.0", id: 3, result: "5" })
    yield* peer.send({ jsonrpc: "2.0", method: "test/notice", params: { value: "6" } })
    expect(yield* Deferred.await(observed)).toBe(6)
    void connection
  })))
})
