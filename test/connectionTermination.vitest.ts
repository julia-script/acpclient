import { expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AcpConnection from "../src/AcpConnection.ts"
import { AcpTransportError } from "../src/AcpError.ts"
import { AcpTransport } from "../src/AcpTransport.ts"

it.effect("transport failure settles pending requests even when its scope closes during termination", () =>
  Effect.gen(function*() {
    let failWrites = false
    const transport = AcpTransport.of({
      incoming: Stream.never,
      send: () => failWrites
        ? Effect.fail(new AcpTransportError({ reason: "Write", message: "broken transport" }))
        : Effect.void
    })
    const scope = yield* Scope.make()
    const connection = yield* AcpConnection.make({ maxPendingRequests: 10_000 }).pipe(
      Effect.provideService(AcpTransport, transport),
      Scope.provide(scope)
    )
    const pending: Array<AcpConnection.PendingRequest> = []
    for (let i = 0; i < 10_000; i++) pending.push(yield* connection.send("pending"))

    failWrites = true
    yield* Effect.exit(connection.notifyRaw("trigger_failure"))
    while ((yield* connection.pendingRequests) !== 0) yield* Effect.yieldNow
    yield* Scope.close(scope, Exit.void)
    const waiters = yield* Effect.forEach(pending,
      (request) => Effect.forkChild(Effect.exit(request.response), { startImmediately: true }), { concurrency: 64 })
    const closedWaiter = yield* Effect.forkChild(connection.closed, { startImmediately: true })
    yield* Effect.yieldNow
    const replies = waiters.map((fiber) => fiber.pollUnsafe())
    const closed = closedWaiter.pollUnsafe()
    yield* Effect.forEach(waiters, Fiber.interrupt, { concurrency: 64, discard: true })
    expect(replies).toHaveLength(pending.length)
    expect(replies.every((exit) => exit?._tag === "Success" && Exit.isFailure(exit.value) &&
      exit.value.cause.reasons.length === 1 &&
      exit.value.cause.reasons.some((reason) => Cause.isFailReason(reason) && reason.error._tag === "AcpConnectionClosed")))
      .toBe(true)
    expect(closed?._tag === "Success" && closed.value._tag === "AcpConnectionClosed").toBe(true)
  }))
