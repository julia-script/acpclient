import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
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
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as Stdio from "effect-acp/transport/Stdio"
import * as ChildProcess from "effect/process/ChildProcess"

const clientLayer = (command: ChildProcess.Command) => AcpLocalClient.layer.pipe(
  Layer.provide(Stdio.layer(
    command
  )),
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
