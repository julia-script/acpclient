import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import * as AcpGatewayClient from "effect-acp/AcpGatewayClient"
import { openHostedSession } from "./hosted-client.ts"

const storage = AcpGatewayClient.memoryStorage()
const url = "ws://localhost:8318/acp/gateway?token=local-demo"
const program = Effect.gen(function*() {
  const descriptor = yield* Effect.scoped(Effect.gen(function*() {
    const opened = yield* openHostedSession(url, process.cwd(), storage)
    const submission = yield* opened.session.submit([{ type: "text", text: "Hello ACP" }])
    yield* submission.outcome
    return opened.descriptor
  })) // Detach and close the socket; the host retains the session.
  yield* Effect.scoped(Effect.gen(function*() {
    const restored = yield* openHostedSession(url, process.cwd(), storage, descriptor)
    const snapshot = yield* restored.session.snapshot
    yield* Console.log("Restored turn state:", snapshot.foreground.state)
    yield* Console.log("Retained messages:", snapshot.messages.length)
  }))
})

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)))
}
