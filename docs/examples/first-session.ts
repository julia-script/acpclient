import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { AcpClient } from "effect-acp/AcpClient"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as Stdio from "effect-acp/transport/Stdio"

const ClientLive = AcpLocalClient.layer.pipe(
  Layer.provide(AcpConnector.layer(Stdio.layer(
    ChildProcess.make("bun", ["echo-agent.ts"], { forceKillAfter: "2 seconds" })
  ))),
  Layer.provide(BunServices.layer)
)

const program = Effect.gen(function*() {
  const client = yield* AcpClient
  const connection = yield* client.connect({
    versions: [2, 1],
    params: { info: { name: "first-session", version: "1.0.0" }, capabilities: {} },
    timeout: "10 seconds"
  })
  yield* Console.log(`Connected using ACP v${connection.capabilities.version}`)
  const session = yield* connection.newSession({ cwd: process.cwd() })
  const submission = yield* session.submit([{ type: "text", text: "Hello ACP" }])
  yield* submission.outcome
  const snapshot = yield* session.snapshot
  for (const message of snapshot.messages) {
    if (message.kind !== "agent") continue
    const text = message.content.flatMap((block) =>
      "text" in block && typeof block.text === "string" ? [block.text] : []
    ).join("")
    yield* Console.log(`Agent: ${text}`)
  }
  yield* Console.log(`Turn state: ${snapshot.foreground.state}`)
})

if (import.meta.main) {
  BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(ClientLive)))
}
