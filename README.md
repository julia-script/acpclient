# effect-acp

Effect-native building blocks for the [Agent Client Protocol](https://agentclientprotocol.com) (ACP): versioned wire schemas, a bidirectional JSON-RPC peer, and in-memory and stdio transports. See [ARCHITECTURE.md](ARCHITECTURE.md) for the overall design.

```bash
bun install
bun run check   # generate:check, typecheck, tests, browser import check
```

## Modules

| Import | Contents |
| --- | --- |
| `effect-acp/AcpSchema` | JSON-RPC ids, error codes, method declarations (`request`, `notification`) |
| `effect-acp/protocol/v1`, `effect-acp/protocol/v2` | Generated baseline schemas, static types, and `agentMethods` / `clientMethods` / `protocolMethods` |
| `effect-acp/AcpError` | Typed failures |
| `effect-acp/AcpTransport`, `effect-acp/AcpConnector` | Scoped frame transport contract and the service that opens transports |
| `effect-acp/AcpConnection` | The JSON-RPC peer and incoming handler helpers |
| `effect-acp/AcpProtocol` | Version policy, `initialize`, and `connect` |
| `effect-acp/transport/InMemory`, `effect-acp/transport/Stdio` | Paired in-process transports; spawned-process transport |

Every entry point is browser-safe. Nothing imports Node or Bun APIs; `bun run check:browser` enforces this.

## Connecting to an agent over stdio

The application supplies the process runtime. `Stdio.layer` needs a `ChildProcessSpawner`, for example from `@effect/platform-node` or `@effect/platform-bun`. Without one, the program does not typecheck and fails at runtime. There is no fallback to a global process API.

```ts
const Agent = Stdio.layer(ChildProcess.make("my-agent", ["--acp"])).pipe(
  Layer.provide(NodeServices.layer)
)

const program = Effect.gen(function*() {
  const { connection, negotiated } = yield* AcpProtocol.connect({
    versions: [2, 1],
    params: { info: { name: "my-app", version: "1.0.0" }, capabilities: {} },
    handlers: (negotiated) => /* handlers for negotiated.version */ ({})
  })
  // ...
})

Effect.runPromise(Effect.scoped(program).pipe(Effect.provide(Agent)))
```

[examples/stdio-client.ts](examples/stdio-client.ts) is the complete version, including permission handling and a prompt for each version. Closing the scope fails pending requests with `AcpConnectionClosed`, stops the readers, and terminates the process.

## Protocol versions

- **v1 is the default.** ACP v2 is still a draft, so it must be enabled explicitly: `versions: [2, 1]` prefers v2 and accepts a v1 downgrade, and `[2]` accepts only v2.
- `initialize` is sent with the highest enabled version. The agent's answer selects the version, and the response is validated with that version's codec. A version outside the enabled set fails with `AcpUnsupportedVersion` and releases the transport. Nothing else is sent.
- `negotiated.advertised` records what was actually sent. After a v2 to v1 downgrade, it holds the v2 params, so no v1 client capabilities (`fs`, `terminal`) were advertised.
- A connection is initialized at most once. After a failure, open a new connection.
- Enabling v2 enables only the v2 **baseline**. Unstable features are never added to your `initialize` params.

The v1 and v2 modules are independent. For example, `V1.PromptResponse` (the turn completed, with a stop reason) and `V2.PromptResponse` (insertion acknowledged, with a message id) are different contracts.

## Handling incoming requests and notifications

```ts
AcpConnection.handlers([
  AcpConnection.onRequest(V2.clientMethods["session/request_permission"], (params) => Effect.succeed(...)),
  AcpConnection.onNotification(V2.clientMethods["session/update"], ({ update }) => ...)
], /* optional raw fallback, e.g. for `_vendor/...` extension methods */)
```

- Each incoming request runs in its own fiber, so a handler may call back into the agent without deadlocking. Fail with `AcpRemoteError` to send a specific JSON-RPC error. Invalid params produce `-32602`. Defects produce `-32603` and their details are not sent.
- Notifications are handled one at a time, in arrival order, and are never answered. A notification handler must not wait for an outgoing request's response, because reading pauses while the notification buffer is full.
- Incoming messages wait until handlers are installed. `connect` installs them right after negotiation.

## Cancellation and deadlines

| Action | Effect |
| --- | --- |
| Interrupt a `request` | Stops waiting locally. Nothing is sent. The request stays correlated until the agent answers or the connection closes. |
| `request(..., { timeout })` | Fails with `AcpTimeoutError`. The deadline covers a send blocked on backpressure as well as the wait; if it expires before sending, nothing is sent and `requestId` is `null`. This is not a remote cancellation. |
| `connection.cancelRequest(id)` | Sends `$/cancel_request`. Cancellation is confirmed only by the agent's response, typically error `-32800`. |
| Incoming `$/cancel_request` | Interrupts the handler and answers `-32800`. |
| Close the scope, or the transport ends or fails | Pending calls fail with `AcpConnectionClosed`, handler fibers are interrupted, and nothing more is read or dispatched. A failed stdio stdin write also ends the connection. |

Session cancellation (`session/cancel`) is an ordinary ACP notification and is separate from the actions above.

## Custom transports

A transport exchanges complete UTF-8 JSON text frames. Each frame holds one message or a batch array.

```ts
interface AcpTransport {
  readonly incoming: Stream.Stream<string, AcpTransportError> // ends when the remote side closes
  readonly send: (frame: string) => Effect.Effect<void, AcpTransportError> // ordered; fails with reason "Closed" once closed
}
```

Acquire the transport in a `Scope` and release its resources in finalizers, then provide it with `AcpConnector.layer(acquire)`. Framing belongs to the transport. JSON parsing, envelope validation, and error responses belong to `AcpConnection`, so a malformed frame receives a parse-error response instead of closing the connection. [examples/custom-transport.ts](examples/custom-transport.ts) adapts a web `MessagePort`. The same shape fits WebSockets, Electron IPC, and workers.

## Limits

All limits are finite. Exceeding a limit causes an explicit failure or backpressure. Messages are never dropped silently.

| Option | Default | When exceeded |
| --- | --- | --- |
| `AcpConnection` `maxPendingRequests` | 1024 | `AcpCapacityError`; the request is not sent |
| `AcpConnection` `maxIncomingRequests` | 256 | Connection terminates with `AcpConnectionClosed` |
| `AcpConnection` `notificationBuffer` | 256 | Reading pauses until handlers catch up |
| `Stdio` `maxFrameBytes` | 16 MiB | Incoming: the transport fails with `FrameTooLarge`. Outgoing: that send fails. |
| `Stdio` `writeBuffer` | 64 frames | `send` suspends |
| `Stdio` `stderr.maxBytes` | 64 KiB | Older stderr is discarded. Only the tail is kept, and stderr is always drained. |
| `InMemory` `capacity` | 64 frames | `send` suspends |

Other behavior:

- Invalid UTF-8 or a truncated final line on stdout fails the transport with `InvalidFrame`.
- Blank lines are ignored. A trailing `\r` is removed.
- The peer answers batches it receives but has no API for sending batches.

## Wire schemas and updates

`src/protocol/v{1,2}/Schema.ts` are generated from the pinned vendored schemas listed in [scripts/codegen/manifest.json](scripts/codegen/manifest.json) (paths, SHA-256, and upstream revision). Each generated module exports `provenance`.

- `bun run generate` regenerates the modules. `bun run generate:check` fails if the checked-in output has drifted.
- To update: vendor the new upstream schemas, review the diff, update the hashes in the manifest (and ARCHITECTURE.md), regenerate, and review the generated diff.
- Loading fails if an input's hash differs from the manifest. Generation fails, naming the definition, on any JSON Schema validation keyword the generator does not implement. It never silently accepts more.
- Handwritten corrections go in [scripts/codegen/overrides.ts](scripts/codegen/overrides.ts), keyed by version and definition, with a stated reason. None are needed at present.
- Decoding is identity-preserving. Unknown keys, explicit `null`s, omitted fields, and permitted unknown variants round-trip unchanged. A malformed known variant fails instead of matching the fallback.
- Validation follows JSON Schema 2020-12 semantics. `format` is treated as an annotation. The Rust SDK's lenient-deserialization hints (`x-deserialize-default-on-error`, `x-deserialize-skip-invalid-items`) are ignored, so an invalid optional field fails validation instead of being defaulted.
- Tests check the generated codecs against an independent JSON Schema validator (ajv) configured for the same dialect.
