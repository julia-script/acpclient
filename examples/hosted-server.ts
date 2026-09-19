import * as AcpConnector from "effect-acp/AcpConnector"
/** Runnable hosted recovery example: bun examples/hosted-server.ts */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Socket from "effect/unstable/socket/Socket"
import * as Host from "effect-acp/AcpHost"
import * as Gateway from "effect-acp/AcpGateway"
import * as Local from "effect-acp/AcpLocalClient"
import { AcpClient } from "effect-acp/AcpClient"
import * as Stdio from "effect-acp/transport/Stdio"
import * as GatewayHttp from "effect-acp/server/GatewayHttp"
import { exerciseRecovery } from "./hosted-client.ts"

const port = 8318
let initialized = 0
const host = Host.layer({
  policy: { retentionMs: 30_000, interactionMs: 20_000, shutdownMs: 500, retryMs: 60_000,
    events: 256, eventBytes: 4_194_304, subscriberCapacity: 64, transcriptBytes: 1_048_576,
    terminalBytes: 16_384, commands: 1024, connections: 8, sessions: 32 },
  authorize: (identity, access) => identity.principalId === "demo-user" && access.workspace === "demo"
    ? Effect.void : Effect.fail(Gateway.failure("Unauthorized")),
  open: (_identity, _workspace, profile, _options, enforced) => Effect.gen(function*() {
    if (profile !== "demo") return yield* Gateway.failure("Unauthorized")
    initialized++
    const client = yield* AcpClient
    return yield* client.connect({ versions: [2], params: { info: { name: "hosted-demo", version: "1" } }, ...enforced })
  }).pipe(Effect.provide(Local.layer.pipe(Layer.provide(AcpConnector.layer(Stdio.layer(ChildProcess.make("bun", [new URL("../test/fixtures/hosted-agent.ts", import.meta.url).pathname])))))))
})
const route = GatewayHttp.route({
  // Supply your application's cookie/session authenticator here.
  authenticate: (request) => new URL(request.url, `http://localhost:${port}`).searchParams.get("token") === "demo"
    ? Effect.succeed({ principalId: "demo-user" }) : Effect.fail(Gateway.failure("Unauthorized")),
  allowOrigin: (origin) => origin === undefined || origin === `http://localhost:${port}`
})
const server = HttpRouter.serve(HttpRouter.addAll([route]), { disableLogger: true }).pipe(
  Layer.provide(host), Layer.provide(BunServices.layer), Layer.provide(BunHttpServer.layer({ port })))
const program = exerciseRecovery(`ws://localhost:${port}/acp/gateway?token=demo`).pipe(
  Effect.tap(() => Effect.sync(() => {
    if (initialized !== 1) throw new Error(`Expected one ACP initialization, got ${initialized}`)

  })), Effect.tap(() => Effect.log("hosted recovery: permission and streaming restored; one ACP initialization")), Effect.provide(Layer.merge(server, Socket.layerWebSocketConstructorGlobal)))
Effect.runPromise(Effect.scoped(program).pipe(Effect.timeout("15 seconds"))).catch((error) => { Effect.runSync(Effect.logError(error)); process.exitCode = 1 })
