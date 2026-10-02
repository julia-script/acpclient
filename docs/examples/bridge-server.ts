import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/http/HttpRouter"
import * as ChildProcess from "effect/process/ChildProcess"
import * as BridgeHttp from "effect-acp/server/BridgeHttp"

export const bridgeServer = (command: ChildProcess.Command, port = 8317) => {
  const route = BridgeHttp.route({
    authenticate: (request) =>
      new URL(request.url, `http://localhost:${port}`).searchParams.get("token") === "local-demo"
        ? Effect.succeed({ id: "local-user" })
        : Effect.fail(new BridgeHttp.Rejected({ message: "Invalid demo token" })),
    allowOrigin: (origin) => origin === undefined || origin === "http://localhost:5173",
    resolveLaunch: (_principal, selection) => selection.profile === "assistant"
      ? Effect.succeed(command)
      : Effect.fail(new BridgeHttp.Rejected({ message: "Unknown profile" }))
  })
  return HttpRouter.serve(HttpRouter.addAll([route])).pipe(
    Layer.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port }))
  )
}

export const cli = Command.make("bridge-server", {
  bin: Argument.String("bin").pipe(
    Argument.withDefault("claude-agent-acp"),
    Argument.withDescription("Server-controlled ACP executable path or command on PATH")
  ),
  args: Argument.String("agent-args").pipe(
    Argument.variadic(),
    Argument.withDescription("Agent-specific arguments; put flags after --")
  )
}, ({ bin, args }) => Layer.launch(bridgeServer(
  ChildProcess.make(bin, args, { forceKillAfter: "2 seconds" })
))).pipe(Command.withDescription("Run the loopback ACP bridge example"))

if (import.meta.main) {
  BunRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
}
