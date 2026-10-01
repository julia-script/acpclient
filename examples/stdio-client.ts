import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Option from "effect/Option"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as AcpConnector from "effect-acp/AcpConnector"
/**
 * Spawn an ACP agent over stdio, prefer v2 while accepting v1, and prompt it.
 *
 *   bun examples/stdio-client.ts [agent command...]
 *
 * Defaults to the repository's fixture agent.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { AcpConnection, AcpProtocol, Stdio, V1, V2 } from "effect-acp"

// The process runtime is supplied here, by the application.
const agentLayer = (command: ChildProcess.Command) => AcpConnector.layer(Stdio.layer(command, {
  maxFrameBytes: 8 * 1024 * 1024,
  stderr: { maxBytes: 16 * 1024 }
})).pipe(Layer.provide(NodeServices.layer))

// Answer permission requests in whichever version was negotiated.
const allow = { outcome: { outcome: "selected" as const, optionId: "allow" } }
const handlers = (negotiated: AcpProtocol.Negotiated) =>
  negotiated.version === 2
    ? AcpConnection.handlers([
      AcpConnection.onRequest(V2.clientMethods["session/request_permission"], () => Effect.succeed(allow)),
      AcpConnection.onNotification(V2.clientMethods["session/update"], ({ update }) =>
        Effect.log(`update: ${update.sessionUpdate}`))
    ])
    : AcpConnection.handlers([
      AcpConnection.onRequest(V1.clientMethods["session/request_permission"], () => Effect.succeed(allow)),
      AcpConnection.onNotification(V1.clientMethods["session/update"], ({ update }) =>
        Effect.log(`update: ${update.sessionUpdate}`))
    ])

const program = Effect.gen(function*() {
  const { connection, negotiated } = yield* AcpProtocol.connect({
    versions: [2, 1], // v2 is a draft: opt in explicitly
    params: { info: { name: "example-client", version: "0.1.0" }, capabilities: {} },
    timeout: "10 seconds",
    handlers
  })
  yield* Effect.log(`negotiated ACP v${negotiated.version}`)
  const prompt = [{ type: "text" as const, text: "Hello" }]
  if (negotiated.version === 2) {
    const { sessionId } = yield* connection.request(V2.agentMethods["session/new"], { cwd: process.cwd() })
    const { messageId } = yield* connection.request(V2.agentMethods["session/prompt"], { sessionId, prompt })
    yield* Effect.log(`prompt accepted as ${messageId}`)
  } else {
    const { sessionId } = yield* connection.request(V1.agentMethods["session/new"], { cwd: process.cwd(), mcpServers: [] })
    const { stopReason } = yield* connection.request(V1.agentMethods["session/prompt"], { sessionId, prompt })
    yield* Effect.log(`turn ended: ${stopReason}`)
  }
})

// Closing the scope settles pending requests and terminates the agent.
export const cli = Command.make("stdio-client", {
  bin: Argument.String("bin").pipe(Argument.optional),
  args: Argument.String("agent-args").pipe(
    Argument.variadic(),
    Argument.withDescription("Agent-specific arguments; put flags after --")
  )
}, ({ bin, args }) => {
  const command = Option.isSome(bin)
    ? ChildProcess.make(bin.value, args)
    : ChildProcess.make("bun", [new URL("../test/fixtures/agent.ts", import.meta.url).pathname, "2"])
  return Effect.scoped(program).pipe(Effect.provide(agentLayer(command)))
})

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(NodeServices.layer)))
}
