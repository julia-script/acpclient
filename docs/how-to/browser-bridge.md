# Add a WebSocket bridge to a stdio agent

Use a bridge when a browser or Electron renderer needs an agent running on an application server or main process. The browser uses the same session client API; the transport service changes to WebSocket. This guide assumes an existing browser application at `http://localhost:5173` and a Bun backend.

A bridged agent belongs to one WebSocket connection. Use [hosted sessions](hosted-sessions.md) when a page refresh must preserve work.

## Mount the server route

Install the library, matching Effect/Bun platform packages, and your adapter as in [the real-agent guide](real-agents.md). Save this as `bridge-server.ts`:

<!-- example: ../examples/bridge-server.ts -->
```ts
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
```

Start it with an installed adapter:

```sh
bun bridge-server.ts ./node_modules/.bin/claude-agent-acp
```

Or select Codex on the server:

```sh
bun bridge-server.ts ./node_modules/.bin/codex-acp
```

Configure the adapter's provider credentials on the server before prompting. When using the Codex API-key method, pass `"api-key"` as the optional third argument to `greetThroughBridge` below; it calls ACP authenticate before creating a session. To exercise the bridge without an account, save the tutorial's `echo-agent.ts` in the same directory and run:

```sh
bun bridge-server.ts bun -- echo-agent.ts
```

The server accepts only the profile name `assistant`. Browser input never selects an executable or command arguments. The route checks the WebSocket subprotocol, origin, authentication, and launch profile before spawning the agent.

This is a loopback development server with a fixed demo token in the URL. When mounting the route in your application, replace `authenticate` with your session-cookie authenticator, set `allowOrigin` to the application's allowed origins, and map each authorized profile to a server-controlled command. Browser WebSockets cannot set an arbitrary Authorization header; use the application's handshake authentication mechanism. Do not deploy the demo token as authentication.

## Provide the browser transport

Save this as `browser-client.ts` in your browser application. It imports no Bun or Node runtime modules.

<!-- example: ../examples/browser-client.ts -->
```ts
import * as Effect from "effect/Effect"
import { AcpClient } from "effect-acp/AcpClient"
import * as Layer from "effect/Layer"
import * as Socket from "effect/socket/Socket"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as WebSocket from "effect-acp/transport/WebSocket"

export const browserClient = (url: string) => AcpLocalClient.layer.pipe(
  Layer.provide(WebSocket.layer(url)),
  Layer.provide(Socket.layerWebSocketConstructorGlobal)
)


// A complete one-turn operation. For a chat UI, keep its connection scope open
// for the lifetime of the view and use session.observe to render updates.
export const greetThroughBridge = (url: string, cwd: string, authMethod?: string) => Effect.scoped(
  Effect.gen(function*() {
    const client = yield* AcpClient
    const connection = yield* client.connect({
      versions: [1],
      params: { clientInfo: { name: "browser-app", version: "1.0.0" } },
      timeout: "30 seconds",
      interactionTimeout: "30 seconds"
    })
    if (authMethod !== undefined) yield* connection.authenticate(authMethod)
    const session = yield* connection.newSession({ cwd })
    const submission = yield* session.submit([{
      type: "text", text: "Reply with a short greeting. Do not use tools."
    }])
    yield* submission.outcome
    return yield* session.snapshot
  })
).pipe(Effect.provide(browserClient(url)))
```

Call the exported `greetThroughBridge` Effect from your application's runtime with URL `ws://localhost:8317/acp?profile=assistant&token=local-demo` and an absolute workspace path on the **server**. It returns a session snapshot after one greeting and closes that connection. Against the echo agent, its agent message reads `Echo: Reply with a short greeting. Do not use tools.`

For a chat UI, provide the exported `browserClient(url)` layer to the long-lived Effect that owns your `AcpClient` connection. Open sessions there and use [the session UI guide](session-ui.md) for observation and permissions. A bridge transports reverse agent requests as well as ordinary client requests; permission handling still belongs in the client UI. This one-turn sample sets a finite interaction timeout and provides no permission controls.

## Handle disconnects

On socket failure, end the connection's UI state. A new socket launches a fresh agent. Neither the transport nor the bridge replays prompts or restores the previous session. The host/gateway path provides that different ownership model.

The WebSocket wire profile is package-owned (`effect-acp-jsonrpc-v1`), with one JSON text message per frame. It is not an implementation of a proposed ACP HTTP transport. See [transport reference](../reference/transports.md) for bounds and service dependencies.

The server entry point uses Effect CLI. Use `--help` for wrapper usage and place agent-specific flags after `--`; the host does not interpret those flags.
