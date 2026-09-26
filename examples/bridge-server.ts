import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as Schema from "effect/Schema"
/**
 * Mount the ACP bridge on an existing HTTP server, then drive it with the
 * browser-safe WebSocket client: the browser never spawns anything itself, it
 * names a launch profile the server is willing to start.
 *
 *   bun examples/bridge-server.ts
 *
 * The client half of this file is the code a browser would run verbatim; only
 * the `WebSocketConstructor` differs (browsers supply the global). The server
 * half never trusts a browser-supplied command: `resolveLaunch` maps a profile
 * NAME onto a command the host already permits, so an arbitrary executable in
 * the query string is rejected before any process is created.
 *
 * Lifecycle limitation: the bridge is connection-scoped. When the socket drops,
 * the spawned agent is terminated and its session is gone; there is no
 * reconnect and no replay. Surviving a page refresh needs the hosted gateway,
 * which keeps the agent alive independently of one browser connection.
 */
import * as BunHttpServer from "@effect/platform-bun/BunHttpServer"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as Socket from "effect/unstable/socket/Socket"
import { AcpProtocol, V1, V2 } from "effect-acp"
import * as BridgeHttp from "effect-acp/server"
import * as WebSocket from "effect-acp/transport/WebSocket"

export const resolveLaunchProfile = <A>(profiles: Readonly<Record<string, A>>, profile: string | undefined): A | undefined =>
  profile !== undefined && Object.hasOwn(profiles, profile) ? profiles[profile] : undefined

const run = (version: 1 | 2) => {
  const port = 8317
  const agentPath = new URL("../test/fixtures/agent.ts", import.meta.url).pathname

  /** Commands this host is willing to start, keyed by the name a browser may ask for. */
  const launchProfiles: Record<string, ChildProcess.Command> = {
    demo: ChildProcess.make("bun", [agentPath, String(version)])
  }

  const bridge = BridgeHttp.route<{ readonly id: string }>({
    path: "/acp",
    // Browsers cannot set headers on a WebSocket handshake, so a real deployment
    // authenticates from the session cookie the handshake already carries. This
    // demo accepts a token in the query string to stay runnable without one.
    authenticate: (request) => {
      const token = new URL(request.url, `http://localhost:${port}`).searchParams.get("token")
      return token === "demo-token"
        ? Effect.succeed({ id: "demo-user" })
        : Effect.fail(new BridgeHttp.Rejected({ message: "missing or invalid token" }))
    },
    allowOrigin: (origin) => origin === undefined || origin === `http://localhost:${port}`,
    // The browser selects a profile name, never a command line.
    resolveLaunch: (_principal, selection) => {
      const command = resolveLaunchProfile(launchProfiles, selection.profile)
      return command === undefined
        ? Effect.fail(new BridgeHttp.Rejected({ message: `unknown launch profile ${selection.profile}` }))
        : Effect.succeed(command)
    }
  })

  // Mounted alongside whatever else the application already serves.
  // `disableLogger` keeps this demo's output readable: the browser hanging up is
  // a normal end of a bridged connection, not a server error.
  const Server = HttpRouter.serve(HttpRouter.addAll([bridge]), { disableLogger: true }).pipe(
    Layer.provide(BunServices.layer),
    Layer.provide(BunHttpServer.layer({ port }))
  )

  /** The browser side: dial the route and speak ACP over the socket. */
  const client = Effect.gen(function*() {
    const { connection, negotiated } = yield* AcpProtocol.connect({
      ...(version === 2
        ? { versions: [2] as const, params: { info: { name: "browser-client", version: "0.1.0" }, capabilities: {} } }
        : { versions: [1] as const, params: {} }),
      handlers: () => ({
        request: (method, params) => {
          if (method === "session/request_permission") return Effect.succeed({ outcome: { outcome: "selected", optionId: "allow" } })
          if (method === "_fixture/echo") return Effect.succeed(params)
          return undefined
        },
        notification: () => Effect.void
      }),
      timeout: "10 seconds"
    })
    yield* Effect.log(`bridged ACP v${negotiated.version}`)

    const { sessionId } = negotiated.version === 2
      ? yield* connection.request(V2.agentMethods["session/new"], { cwd: process.cwd() })
      : yield* connection.request(V1.agentMethods["session/new"], { cwd: process.cwd(), mcpServers: [] })
    const prompt = { sessionId, prompt: [{ type: "text" as const, text: "Hello through the bridge" }] }
    const result = version === 2
      ? yield* connection.request(V2.agentMethods["session/prompt"], prompt)
      : yield* connection.request(V1.agentMethods["session/prompt"], prompt)
    if (result._meta?.optionId !== "allow") return yield* Effect.die("Reverse permission did not complete")
    yield* Effect.log("messageId" in result ? `bridged prompt accepted as ${result.messageId}` : `bridged turn completed: ${result.stopReason}`)
    const malformed = yield* connection.requestRaw("_fixture/malformed", {}).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({
      parse: Schema.Struct({ error: Schema.Struct({ code: Schema.Finite }) }),
      unknown: Schema.Struct({ error: Schema.Struct({ code: Schema.Finite }) }),
      batch: Schema.Struct({ batch: Schema.Array(Schema.Struct({
        id: Schema.Union([Schema.String, Schema.Finite, Schema.Null]),
        result: Schema.optionalKey(Schema.Struct({ ok: Schema.Boolean }))
      })) })
    }))))
    if (malformed.parse.error.code !== -32700 || malformed.unknown.error.code !== -32601 || !malformed.batch.batch.some((message) => message.id === "b-1" && message.result?.ok)) return yield* Effect.die("Bridge error/batch round trip failed")
    yield* Effect.log("reverse permission, notifications, errors and batches relayed")
  }).pipe(
    Effect.provide(
      AcpConnector.layer(WebSocket.layer(`ws://localhost:${port}/acp?profile=demo&token=demo-token`)).pipe(
        // Browsers provide this global themselves.
        Layer.provide(Socket.layerWebSocketConstructorGlobal)
      )
    )
  )

  const program = Effect.gen(function*() {
    yield* Effect.log(`bridge listening on http://localhost:${port}/acp`)
    // Scoped to the client: this demo exits once the round trip is done, where a
    // real server would stay up serving further connections.
    yield* Effect.scoped(client)
  }).pipe(Effect.provide(Server))

  return Effect.scoped(program)
}

export const cli = Command.make("bridge-server", {
  version: Argument.Literals("acp-version", ["1", "2"]).pipe(Argument.withDefault("2"))
}, ({ version }) => run(version === "1" ? 1 : 2))

if (import.meta.main) {
  BunRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer)))
}
