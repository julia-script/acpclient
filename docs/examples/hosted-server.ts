import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Config from "effect/Config"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as ChildProcess from "effect/process/ChildProcess"
import { AcpClient } from "effect-acp/AcpClient"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as AcpGateway from "effect-acp/AcpGateway"
import * as AcpHost from "effect-acp/AcpHost"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as GatewayHttp from "effect-acp/server/GatewayHttp"
import * as Stdio from "effect-acp/transport/Stdio"

export const hostedServer = (command: ChildProcess.Command, port = 8318) => {
  const ClientLive = AcpLocalClient.layer.pipe(
    Layer.provide(AcpConnector.layer(Stdio.layer(command)))
  )
  const HostLive = AcpHost.layer({
    policy: {
      retentionMs: 300_000, interactionMs: 60_000, shutdownMs: 3_000, retryMs: 600_000,
      events: 256, eventBytes: 4_194_304, subscriberCapacity: 64,
      transcriptBytes: 1_048_576, terminalBytes: 32_768,
      commands: 1024, connections: 8, sessions: 32
    },
    authorize: (identity, access) =>
      identity.principalId === "local-user" && access.workspace === "demo"
        ? Effect.void
        : Effect.fail(AcpGateway.failure("Unauthorized")),
    open: (_identity, _workspace, profile, _options, enforced) => Effect.gen(function*() {
      if (profile !== "assistant") return yield* AcpGateway.failure("Unauthorized")
      const client = yield* AcpClient
      const connection = yield* client.connect({
        versions: [1],
        params: { clientInfo: { name: "hosted-app", version: "1.0.0" } },
        timeout: "30 seconds",
        ...enforced
      })
      const authMethod = yield* Config.option(Config.String("ACP_AUTH_METHOD"))
      if (Option.isSome(authMethod)) yield* connection.authenticate(authMethod.value)
      return connection
    }).pipe(Effect.provide(ClientLive))
  })
  const route = GatewayHttp.route({
    authenticate: (request) =>
      new URL(request.url, `http://localhost:${port}`).searchParams.get("token") === "local-demo"
        ? Effect.succeed({ principalId: "local-user" })
        : Effect.fail(AcpGateway.failure("Unauthorized")),
    allowOrigin: (origin) => origin === undefined || origin === "http://localhost:5173"
  })
  return HttpRouter.serve(HttpRouter.addAll([route])).pipe(
    Layer.provide(HostLive),
    Layer.provide(BunServices.layer),
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port }))
  )
}

export const cli = Command.make("hosted-server", {
  bin: Argument.String("bin").pipe(
    Argument.withDefault("claude-agent-acp"),
    Argument.withDescription("Server-controlled ACP executable path or command on PATH")
  ),
  args: Argument.String("agent-args").pipe(
    Argument.variadic(),
    Argument.withDescription("Agent-specific arguments; put flags after --")
  )
}, ({ bin, args }) => Layer.launch(hostedServer(
  ChildProcess.make(bin, args, { forceKillAfter: "2 seconds" })
))).pipe(Command.withDescription("Run the loopback ACP session host example"))

if (import.meta.main) {
  BunRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
}
