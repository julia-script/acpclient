import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { AcpClient } from "effect-acp/AcpClient"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as Stdio from "effect-acp/transport/Stdio"

// Start the echo agent and communicate over its stdin/stdout.
const agentProcess = ChildProcess.make("bun", ["echo-agent.ts"], {
  forceKillAfter: "2 seconds"
})

const ClientLive = AcpLocalClient.layer.pipe(
  Layer.provide(Stdio.layer(agentProcess)),
  Layer.provide(BunServices.layer)
)

const program = Effect.gen(function*() {
  // 1. Connect to the agent.
  const client = yield* AcpClient
  const connection = yield* client.connect({
    versions: [2, 1],
    params: {
      info: { name: "first-session", version: "1.0.0" },
      capabilities: {}
    },
    timeout: "10 seconds"
  })
  yield* Console.log(`Connected using ACP v${connection.capabilities.version}`)

  // 2. Open a session in the current directory.
  const session = yield* connection.newSession({ cwd: process.cwd() })

  // 3. Send a prompt and wait for the agent to finish its turn.
  const submission = yield* session.submit([{ type: "text", text: "Hello ACP" }])
  yield* submission.outcome

  // 4. Read the completed reply from the session snapshot.
  const snapshot = yield* session.snapshot
  for (const message of snapshot.messages) {
    if (message.kind !== "agent") continue

    // Join the text chunks that make up each agent message.
    const text = message.content
      .flatMap((block) =>
        "text" in block && typeof block.text === "string" ? [block.text] : []
      )
      .join("")
    yield* Console.log(`Agent: ${text}`)
  }
  yield* Console.log(`Turn state: ${snapshot.foreground.state}`)
})

if (import.meta.main) {
  // Release the connection and child process when the program finishes.
  BunRuntime.runMain(program.pipe(
    Effect.provide(ClientLive),
    Effect.scoped
  ))
}
