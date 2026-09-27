# Transport and bridge reference

Scope: `AcpTransport`, `AcpConnector`, transport implementations, and `server/BridgeHttp`. Protocol version negotiation and JSON-RPC dispatch sit above these services.

## Common contract

`AcpTransport.AcpTransport` is the Effect service for one live transport. Its value has `incoming: Stream<string, AcpTransportError>` and `send(frame): Effect<void, AcpTransportError>`. A frame is a complete JSON text document without its stream delimiter. The JSON-RPC peer interprets the document; the transport owns framing and I/O.

`AcpConnector.layer(transportLayer)` provides a scoped factory. Each acquisition builds a fresh transport layer, so opening two connections does not reuse one process or socket through layer memoization. The factory captures dependencies such as `ChildProcessSpawner`; construction alone does not start a process.

`AcpTransport.layer(acquire)` retains the acquisition Effect's error and service types. `WebSocket.make` and `WebSocket.layer` also accept a URL Effect and retain its error and service types; their socket I/O errors remain `AcpTransportError`. A connector's later `connect` call has the fixed `AcpTransportError` contract, so supply a transport layer with that error type when using `AcpConnector.layer`.

## Implementations

| Module under `effect-acp/transport/` | Service constructor | Required platform service | Lifetime |
| --- | --- | --- | --- |
| `Stdio` | `layer(command, options?)` | `ChildProcessSpawner` | Spawned child's stdin/stdout; scope closes the transport and terminates the process. |
| `ProcessStdio` | `layer(options?)` | Effect `Stdio` | Current process's stdin/stdout; stream handles belong to the injected service. |
| `WebSocket` | `layer(url, options?)` | `Socket.WebSocketConstructor` | One socket, with no implicit reconnect or resend. |
| `InMemory` | `layer(endpoint)` | None | One acquired endpoint from a paired in-memory transport. |

The adapters also expose scoped `make` constructors for direct composition. `InMemory.make(options?)` creates `left`/`right` endpoint acquisition Effects; `makePair` acquires both. `WebSocket.fromSocket` adapts an Effect that acquires an already-upgraded `Socket`.

Bun and Node runtime packages provide process services. Browser composition uses `Socket.layerWebSocketConstructorGlobal`. Importing these transport modules starts no I/O and imports no platform runtime.

## Launch configuration

`Stdio.layer` takes an Effect `ChildProcess.Command`, which already describes an executable, its argument vector, environment, and process policy. ACP v1 and v2 do not prescribe agent launch flags. A generic argument vector therefore has the type `ReadonlyArray<string>`; named options require an agent-specific contract.

The [ACP registry format](https://github.com/agentclientprotocol/registry/blob/main/FORMAT.md) describes binary/package distributions and their launch arguments, including `cmd`, `args`, and `env` for binary entries. This is distribution metadata, not a shared vocabulary of agent flags. Registry resolution and agent-specific option builders can produce a process command above the transport service. The package does not currently include a registry resolver or typed per-agent launch builders.

## Stdio options

Both stdio directions use newline-delimited UTF-8 JSON. Stdout is reserved for protocol frames; diagnostics belong on stderr.

| Option | Default | Applies to |
| --- | --- | --- |
| `maxFrameBytes` | 16 MiB, excluding delimiter | `Stdio`, `ProcessStdio` |
| `writeBuffer` | 64 queued frames | `Stdio`, `ProcessStdio` |
| `stderr.maxBytes` | 64 KiB | `Stdio` diagnostic tail |
| `stderr.onChunk` | Absent | `Stdio`; callback must not block for long |

`Stdio.make` additionally returns `pid`, `exitCode`, and an Effect named `stderr` that reads the retained diagnostic tail. Process termination policy is configured on the Effect `ChildProcess.Command`, including `forceKillAfter` where appropriate. A successful `send` reflects transport acceptance, not an ACP acknowledgement.

## WebSocket profile

The adapter negotiates **`effect-acp-jsonrpc-v1`**. This version labels framing independently of ACP v1/v2. Each WebSocket message carries one UTF-8 JSON text frame without a newline delimiter. Binary messages fail with close code 1003; oversized text frames fail with 1009.

| Option | Default/behavior |
| --- | --- |
| `maxFrameBytes` | 16 MiB, inbound and outbound |
| `buffer` | 64 inbound frames |
| `openTimeout` | Forwarded to Effect's socket implementation |
| `highWaterMark` | Forwarded to Effect's socket implementation |

The profile is package-owned. Neither it nor the hosted gateway claims conformance to an ACP draft HTTP transport. No general ACP HTTP transport adapter is exported by this package.

## BridgeHttp.route

`route(options)` creates an Effect HTTP upgrade route; default path is `/acp`. The route requires application-provided authentication, origin policy, and a launch resolver. Checks happen before socket upgrade and process creation.

| Option | Contract/default |
| --- | --- |
| `path` | Absolute route path; `/acp` |
| `authenticate(request)` | Effect returning the application's principal or `BridgeHttp.Rejected` |
| `allowOrigin(origin)` | Required predicate; absent Origin is passed as `undefined` |
| `resolveLaunch(principal, selection)` | Returns an authorized `ChildProcess.Command` or rejection |
| `maxFrameBytes` | 16 MiB on each hop |
| `buffer` | 64 frames on the socket hop |
| `pressureDeadline` | 10 seconds for a blocked forwarding write |
| `stderr.maxBytes` | Forwarded diagnostic-tail bound for spawned process |

`selection` has an optional `profile` and the remaining URL search parameters in `params`. Duplicate parameter values may be arrays. `Rejected` has `message`, optional HTTP `status`, and optional `reason`; its error tag is `BridgeHttpRejected`.

The relay preserves JSON-RPC IDs, batches, extensions, error responses, and reverse requests. Socket loss ends the child-process ownership. There is no bridge-level retained session, reconnect, or replay. The [bridge guide](../how-to/browser-bridge.md) supplies a complete server/browser composition.
