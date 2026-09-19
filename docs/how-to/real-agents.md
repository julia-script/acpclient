# Use Claude and Codex ACP agents

Use this guide when you already have an Effect application and want to connect it to a real coding agent. You need Bun, Node.js 22 or newer for these adapter packages, and a provider account or API credentials for model-backed prompts. You can inspect either agent's ACP handshake without starting a model turn.

The executables here are ACP adapters. Install them explicitly; ordinary `claude` and `codex` commands are not interchangeable ACP stdio endpoints. Current upstream packages are [`@agentclientprotocol/claude-agent-acp`](https://github.com/agentclientprotocol/claude-agent-acp) and [`@agentclientprotocol/codex-acp`](https://github.com/agentclientprotocol/codex-acp).

## Install the client and adapter

In your application directory:

```sh
bun add effect-acp effect@4.0.0-rc.115 @effect/platform-bun@4.0.0-rc.115
bun add --dev @agentclientprotocol/claude-agent-acp@0.79.0 @agentclientprotocol/codex-acp@1.12.0
```

These adapter versions are the versions used to verify the handshakes in this guide. You can install just the adapter you need. The Codex ACP package includes a compatible Codex CLI dependency; a separate global Codex installation is unnecessary for its default launch. See the [upstream Codex adapter instructions](https://github.com/agentclientprotocol/codex-acp#readme).

## Save the client

Save this as `real-agent.ts`. It takes an executable followed by its arguments, uses ACP v1, and reads its settings through Effect Config. It has a minimal permission policy: decline every permission and elicitation request. Replace that policy with a user interface for a coding workflow.

<!-- example: ../examples/real-agent.ts -->
```ts
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import type { SessionSnapshot } from "effect-acp/AcpApp"
import { AcpClient } from "effect-acp/AcpClient"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as Stdio from "effect-acp/transport/Stdio"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

const clientLayer = (command: ChildProcess.Command) => AcpLocalClient.layer.pipe(
  Layer.provide(AcpConnector.layer(Stdio.layer(
    command
  ))),
  Layer.provide(BunServices.layer)
)

const program = Effect.gen(function*() {
  const inspect = yield* Config.Boolean("ACP_INSPECT").pipe(Config.withDefault(false))
  const authMethod = yield* Config.option(Config.String("ACP_AUTH_METHOD"))
  const cwd = yield* Config.String("ACP_WORKSPACE").pipe(Config.withDefault(process.cwd()))
  const prompt = yield* Config.String("ACP_PROMPT").pipe(Config.withDefault(
    "Reply with one short greeting. Do not read files, run commands, or use tools."
  ))
  const client = yield* AcpClient
  const connection = yield* client.connect({
    versions: [1],
    params: { clientInfo: { name: "real-agent-example", version: "1.0.0" } },
    timeout: "30 seconds",
    interactionTimeout: "30 seconds"
  })
  yield* Console.log("Agent:", connection.capabilities.agentInfo)
  yield* Console.log("ACP version:", connection.capabilities.version)
  yield* Console.log("Authentication methods:", connection.capabilities.auth.methods)
  if (inspect) return
  if (Option.isSome(authMethod)) yield* connection.authenticate(authMethod.value)

  const session = yield* connection.newSession({ cwd })
  const observed = yield* session.observe
  const handled = new Set<string>()
  // This greeting example declines tool permissions and elicitation. A real
  // UI should present them to the user; see the session UI guide.
  const declineInteractions = (snapshot: SessionSnapshot) => Effect.gen(function*() {
    for (const interaction of Object.values(snapshot.interactions)) {
      if (interaction.status !== "pending" || handled.has(interaction.interactionId)) continue
      handled.add(interaction.interactionId)
      yield* session.resolveInteraction(interaction.interactionId,
        interaction.kind === "permission" ? { _tag: "cancelled" } : { _tag: "cancel" }
      ).pipe(
        Effect.catchTags({
          AcpInteractionAlreadyResolved: () => Effect.void,
          AcpInteractionExpired: () => Effect.void
        })
      )
    }
  })
  yield* declineInteractions(observed.snapshot)
  const observer = yield* Effect.forkChild(observed.changes.pipe(
    Stream.runForEach(({ snapshot }) => declineInteractions(snapshot))
  ))
  const submission = yield* session.submit([{ type: "text", text: prompt }])
  yield* Effect.raceFirst(
    submission.outcome,
    Fiber.join(observer).pipe(Effect.andThen(Effect.never))
  )
  const snapshot = yield* session.snapshot
  for (const message of snapshot.messages) {
    if (message.kind !== "agent") continue
    yield* Console.log(message.content.flatMap((block) =>
      "text" in block && typeof block.text === "string" ? [block.text] : []
    ).join(""))
  }
})

export const cli = Command.make("real-agent", {
  bin: Argument.String("bin").pipe(
    Argument.withDefault("claude-agent-acp"),
    Argument.withDescription("ACP executable path or command on PATH")
  ),
  args: Argument.String("agent-args").pipe(
    Argument.variadic(),
    Argument.withDescription("Agent-specific arguments; put flags after --")
  )
}, ({ bin, args }) => Effect.scoped(program).pipe(
  Effect.provide(clientLayer(ChildProcess.make(bin, args, { forceKillAfter: "2 seconds" })))
)).pipe(Command.withDescription("Connect to an ACP agent; ACP_INSPECT=true only inspects initialization"))

if (import.meta.main) {
  BunRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
}
```

## Command-line arguments

The example uses Effect 4's `effect/unstable/cli` for typed argument parsing, help, and validation. Run `bun real-agent.ts --help` to inspect the wrapper's usage. The first positional argument is the executable; subsequent positional arguments belong to that executable. Put agent flags after `--` so the wrapper does not interpret them as its own flags. The separator itself is not forwarded.

For example, with the tutorial's `echo-agent.ts` in the current directory:

```sh
ACP_INSPECT=true bun real-agent.ts bun -- echo-agent.ts
```

ACP does not define common launch flags. Its [stdio specification](https://agentclientprotocol.com/protocol/v2/transports) defines process communication; an individual agent defines its executable arguments. Session `cwd`, MCP server configuration, and advertised session options belong to the typed ACP APIs, not a universal set of command-line flags.

## Inspect the connection

For Claude:

```sh
ACP_INSPECT=true bun real-agent.ts ./node_modules/.bin/claude-agent-acp
```

For Codex:

```sh
ACP_INSPECT=true bun real-agent.ts ./node_modules/.bin/codex-acp
```

Check the reported agent identity and protocol version. Both listed adapter versions initialized with ACP v1 in verification. Authentication methods depend on the environment and the client capabilities. The inspection step lists what this particular connection supports; an empty list is not proof that a later prompt is authenticated.

Use v1 explicitly for these integrations. Opt into v2 for an agent whose v2 behavior you have tested; see [version negotiation](../reference/protocol.md#version-negotiation).

## Authenticate and prompt

Set `ACP_WORKSPACE` to an absolute directory that the agent may work in. It is the agent-side working directory, not a browser path. The child process inherits your application's environment.

For Claude API access, configure `ANTHROPIC_API_KEY` in the adapter process environment through your usual secret configuration before running the greeting. The adapter uses the Claude Agent SDK; see [the SDK authentication setup](https://code.claude.com/docs/en/agent-sdk/quickstart#set-your-api-key) for provider alternatives. This sample does not advertise terminal authentication, so it does not open a login terminal for you.

```sh
ACP_WORKSPACE="$PWD" bun real-agent.ts ./node_modules/.bin/claude-agent-acp
```

For Codex API-key authentication, configure `CODEX_API_KEY` (or `OPENAI_API_KEY`) through your usual environment/secret configuration, inspect the connection, and select the advertised `api-key` method:

```sh
ACP_WORKSPACE="$PWD" ACP_AUTH_METHOD=api-key bun real-agent.ts ./node_modules/.bin/codex-acp
```

The Codex adapter also supports ChatGPT authentication when it advertises `chat-gpt`; selecting it can start a browser login. Its `NO_BROWSER` setting affects that method's availability. See [Codex authentication](https://github.com/agentclientprotocol/codex-acp#readme).

The response text varies by model and account. The default prompt asks only for a greeting and the client declines tool permissions. To set a different prompt, supply `ACP_PROMPT`. For an agent that needs to edit files or run commands, implement [permission and elicitation handling](session-ui.md) before expecting a useful coding session.

## Diagnose connection failures

| Symptom | Check |
| --- | --- |
| Transport fails to open | The executable path and runtime are installed on the machine running the client. |
| Initialize times out | You launched an ACP adapter, stdout contains only ACP, and the process can finish startup. |
| Authentication required on session creation or prompt | Inspect methods, configure the provider account, then call only a method the agent advertises. |
| Unsupported capability | Read `connection.capabilities`; v1/v2 and adapters expose different operations. |
| Prompt waits for user input | Observe `snapshot.interactions`; a UI must answer or cancel pending requests. |
| Greeting works, coding tools do not | Replace the sample's decline-only policy; install v1 filesystem/terminal handlers only if your application implements them. |

The documented executable launches and initialization exchanges have been verified with both adapter versions. Provider login and model-backed responses depend on your credentials and were not exercised for this guide.
