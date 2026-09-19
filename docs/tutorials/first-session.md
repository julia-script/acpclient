# Run your first agent session

In this lesson, you will start an ACP agent as a child process, open a session, send a prompt, and read its reply. The agent echoes text so you can complete the whole lesson without credentials or a model download.

You need Bun on your PATH and basic familiarity with TypeScript and Effect. Work in a new directory. The example uses the published package and matching Effect platform version.

## 1. Create the project

```sh
mkdir first-acp-session
cd first-acp-session
bun init -y
bun add effect-acp effect@4.0.0-rc.115 @effect/platform-bun@4.0.0-rc.115
```

## 2. Save the agent

Create `echo-agent.ts` with the following content. You will run it through the client in the next step; it waits for ACP messages on stdin when started by itself.

<!-- example: ../examples/echo-agent.ts -->
```ts
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as AcpAgent from "effect-acp/AcpAgent"
import * as Store from "effect-acp/agent/Store"

const counter = Ref.makeUnsafe(0)
const nextId = (prefix: string) => Ref.updateAndGet(counter, (n) => n + 1).pipe(
  Effect.map((n) => `${prefix}-${n}`)
)

export const agent = AcpAgent.make({
  info: { name: "echo-agent", version: "1.0.0" },
  versions: [2, 1],
  session: {
    create: () => nextId("session").pipe(Effect.map((sessionId) => ({ sessionId })))
  },
  prompt: {
    insert: () => nextId("message").pipe(Effect.map((messageId) => ({ messageId }))),
    execute: ({ emit, prompt }): Effect.Effect<AcpAgent.StopReason, AcpAgent.HandlerError> => Effect.gen(function*() {
      const messageId = yield* nextId("reply")
      const text = prompt.flatMap((block) =>
        "text" in block && typeof block.text === "string" ? [block.text] : []
      ).join(" ")
      yield* emit.agentChunk(messageId, { type: "text", text: "Echo: " })
      yield* emit.agentChunk(messageId, { type: "text", text })
    }).pipe(Effect.as("end_turn"))
  }
})

if (import.meta.main) {
  BunRuntime.runMain(Effect.scoped(AcpAgent.serveStdio(agent)).pipe(
    Effect.provide(Layer.mergeAll(Store.layer, BunServices.layer))
  ))
}
```

The agent accepts both protocol versions. For each prompt, it sends two text chunks with the same reply ID.

## 3. Save the client

Create `first-session.ts` in the same directory:

<!-- example: ../examples/first-session.ts -->
```ts
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

BunRuntime.runMain(Effect.scoped(program).pipe(Effect.provide(ClientLive)))
```

The layers provide a stdio transport, a connector, and the application client. The scope keeps the child process alive until the exchange is complete and releases it when the program finishes.

## 4. Run the exchange

```sh
bun first-session.ts
```

You should see:

```text
Connected using ACP v2
Agent: Echo: Hello ACP
Turn state: idle
```

The reply contains both chunks. `submission.outcome` has completed, and the session snapshot reports an idle foreground turn.

## 5. Change the prompt

In `first-session.ts`, change `text: "Hello ACP"` to `text: "Hello again"` and run the same command. The second line becomes:

```text
Agent: Echo: Hello again
```

You have now opened a scoped connection, created a session, and read its completed output. Continue with [Claude or Codex](../how-to/real-agents.md), or use [the session UI guide](../how-to/session-ui.md) to display updates as they arrive.
