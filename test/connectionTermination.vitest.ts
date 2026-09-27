import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
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
    let last: AcpConnection.PendingRequest | undefined
    for (let i = 0; i < 10_000; i++) last = yield* connection.send("pending")

    failWrites = true
    yield* Effect.exit(connection.notifyRaw("trigger_failure"))
    while ((yield* connection.pendingRequests) !== 0) yield* Effect.yieldNow
    yield* Scope.close(scope, Exit.void)
    const lastWaiter = yield* Effect.forkChild(Effect.exit(last!.response), { startImmediately: true })
    const closedWaiter = yield* Effect.forkChild(connection.closed, { startImmediately: true })
    yield* Effect.yieldNow
    expect(lastWaiter.pollUnsafe()).toBeDefined()
    expect(closedWaiter.pollUnsafe()).toBeDefined()
  }))
