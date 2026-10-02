# Retain sessions on a host

Use this guide when an agent must keep working while a browser disconnects, or when users must return to a pending permission after a refresh. It assumes the client/session concepts from the [tutorial](../tutorials/first-session.md) and an application that authenticates users.

The host owns ACP connections and session runtimes. Browser clients attach to those runtimes over the package's gateway. Retention is bounded and in memory: restarting the host does not restore its sessions.

## Create one host for the server lifetime

Save this as `hosted-server.ts`. Install the packages from [the real-agent guide](real-agents.md).

<!-- example: ../examples/hosted-server.ts -->
```ts
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
import * as AcpGateway from "effect-acp/AcpGateway"
import * as AcpHost from "effect-acp/AcpHost"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as GatewayHttp from "effect-acp/server/GatewayHttp"
import * as Stdio from "effect-acp/transport/Stdio"

export const hostedServer = (command: ChildProcess.Command, port = 8318) => {
  const ClientLive = AcpLocalClient.layer.pipe(
    Layer.provide(Stdio.layer(command))
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
```

Run it with the Claude adapter:

```sh
bun hosted-server.ts ./node_modules/.bin/claude-agent-acp
```

The same command accepts `./node_modules/.bin/codex-acp`. Configure provider credentials in the host's process environment before creating sessions. For Codex API-key authentication, also start the host with `ACP_AUTH_METHOD=api-key`; the example authenticates each new connection before returning it. The host's `open` callback decides which ACP version and client handlers to use. Always apply `enforced` to the local connection: those settings give the host finite interaction/cancellation windows and bounded retained state.

The example provides one `HostLive` layer to the server, so all requests share it. Do not build a new host in each WebSocket request's scope; that would destroy the state on disconnect.

The fixed token and `demo` workspace are for loopback use. In an application, replace the handshake authenticator with your authenticated user session and make `authorize` check principal/workspace ownership on every action. Resolve server-controlled launch profiles. This example does not isolate processes or constrain filesystem paths inside a multi-user workspace; your host profile must enforce the access your application promises.

## Open or restore a browser session

Save this browser-safe module as `hosted-client.ts`:

<!-- example: ../examples/hosted-client.ts -->
```ts
import * as Effect from "effect/Effect"
import * as AcpGateway from "effect-acp/AcpGateway"
import * as AcpGatewayClient from "effect-acp/AcpGatewayClient"
import * as AcpRemoteClient from "effect-acp/AcpRemoteClient"

export const openHostedSession = (
  url: string,
  cwd: string,
  storage: AcpGatewayClient.Storage,
  saved?: AcpRemoteClient.SessionDescriptor
) => Effect.gen(function*() {
  const gateway = yield* AcpGatewayClient.connect(url, { workspace: "demo", storage })
  const remote = yield* AcpRemoteClient.make(gateway, { profile: "assistant" })
  if (saved !== undefined) {
    const session = yield* remote.attach(saved)
    return { session, descriptor: saved, gateway }
  }
  // The host's launch profile determines the actual ACP version and capabilities.
  const connection = yield* remote.connect({ versions: [1], params: {} })
  const session = yield* connection.newSession({ cwd })
  const descriptor = remote.descriptor(session)
  if (descriptor === undefined) return yield* AcpGateway.failure("NotFound")
  return { session, descriptor, gateway }
})
```

Provide `Socket.layerWebSocketConstructorGlobal` to the owning Effect in a browser. On first use, call `openHostedSession` without `saved`. Persist the returned descriptor as application state. On reconnect, call it in a new scope with that descriptor and the same gateway storage. The restore branch calls `attach`; it does not initialize ACP again, resume an agent session, or resend the previous prompt.

The returned `session` implements the same observation, submission, and interaction API as a direct session. Keep the connection scope alive while the UI is attached. Use [the session UI guide](session-ui.md) to render changes and answer pending decisions.

## Verify a reconnect without provider credentials

Save the tutorial's [echo agent](../examples/echo-agent.ts), `hosted-server.ts`, and `hosted-client.ts` in one directory. Start the host in one terminal:

```sh
bun hosted-server.ts bun -- echo-agent.ts
```

Save the following as `hosted-reconnect.ts` and run it from another terminal with `bun hosted-reconnect.ts`:

<!-- example: ../examples/hosted-reconnect.ts -->
```ts
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Socket from "effect/socket/Socket"
import * as AcpGatewayClient from "effect-acp/AcpGatewayClient"
import { openHostedSession } from "./hosted-client.ts"

const storage = AcpGatewayClient.memoryStorage()
const url = "ws://localhost:8318/acp/gateway?token=local-demo"
const program = Effect.gen(function*() {
  const descriptor = yield* Effect.scoped(Effect.gen(function*() {
    const opened = yield* openHostedSession(url, process.cwd(), storage)
    const submission = yield* opened.session.submit([{ type: "text", text: "Hello ACP" }])
    yield* submission.outcome
    return opened.descriptor
  })) // Detach and close the socket; the host retains the session.
  yield* Effect.scoped(Effect.gen(function*() {
    const restored = yield* openHostedSession(url, process.cwd(), storage, descriptor)
    const snapshot = yield* restored.session.snapshot
    yield* Console.log("Restored turn state:", snapshot.foreground.state)
    yield* Console.log("Retained messages:", snapshot.messages.length)
  }))
})

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.provide(Socket.layerWebSocketConstructorGlobal)))
}
```

The program opens one session, finishes a prompt, closes the first socket, and attaches through a second socket. With this echo agent, it prints:

```text
Restored turn state: idle
Retained messages: 1
```

The count is one because this v1 echo agent streams its reply but does not echo the user's prompt as a transcript update. The submission remains separately represented in `snapshot.submissions`.

## Persist across a page refresh

`memoryStorage()` lasts only as long as that JavaScript object. For a page refresh, provide your application's durable implementation of `AcpGatewayClient.Storage` and persist the session descriptor separately. Store structured values without losing their types, and complete each save before reporting success. The gateway saves operation admission data before sending it.

Validate a descriptor loaded from application storage with `AcpGateway.SessionDescriptor` using `Schema.decodeUnknownEffect`. Treat failed validation as invalid saved state instead of asserting the shape. The gateway validates its own saved admissions and snapshots when loading them.

`Storage.save` has a typed error channel. The built-in `memoryStorage()` reports an uncloneable value as `AcpGateway.GatewayError` with code `Invalid`; a durable adapter can declare its own `Storage<SaveError>` type, which the gateway client's operations preserve. Integrate your application's persistence policy explicitly; a throwing JSON/localStorage wrapper is not reliable recovery storage. If persistence cannot be made available, keep the UI in an error state instead of claiming the operation is safely saved. See the [storage contract](../reference/hosting.md#storage) for the exact interface.

## Reconcile interrupted operations

Use `gateway.pendingOperations` to enumerate retained operation IDs after reconnecting. `gateway.retry(id)` first looks up the original operation and uses its original admission window; it does not create an unrelated prompt. Inspect the returned operation status and error before updating UI state. Once your application no longer needs recovery data for an operation, `forget(id)` removes its client-side record.

Do not translate `OutcomeUnknown` into an automatic fresh `submit`. The agent might already have acted. Present the retained state and let the application reconcile before explicitly starting new work.

Handle `HostRestarted`, `NotFound`, and `WindowExpired` as distinct recovery failures. For another active controller, ordinary attach fails with `Conflict`; request `attach(descriptor, true)` only for an explicit authorized takeover. See [hosting reference](../reference/hosting.md) for the full recovery boundaries.

The server entry point uses Effect CLI. Use `--help` for wrapper usage and place agent-specific flags after `--`; the host does not interpret those flags.
