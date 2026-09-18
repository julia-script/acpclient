# Design

## Context

See [proposal.md](proposal.md). The foundation's framing and scoped connector contracts are prerequisites. Effect provides browser-capable WebSocket construction, HTTP request upgrades, and injected subprocess services. ACP's standard remote transport is still draft; a custom profile must document its framing and lifecycle independently.

## Goals / Non-Goals

**Goals:** Preserve ACP messages across a browser-to-host-to-stdio path with minimal mounting code and strict resource ownership.

**Non-Goals:** Session persistence, version translation, client state reconstruction, managed permissions, HTTP/SSE fallback, or the hosted application gateway.

## Decisions

### A named custom WebSocket profile

Use the WebSocket subprotocol `effect-acp-jsonrpc-v1`, where the suffix versions framing rather than ACP. Each text message contains one complete UTF-8 JSON-RPC envelope or batch; the stdio newline delimiter is not part of the WebSocket message. Require the selected subprotocol, reject binary frames with an unsupported-data close, and close on oversized frames. Pass complete text frames to the peer or bridge so invalid JSON can reach the actual ACP endpoint for a standard parse-error response.

Alternative: declaring the unfinished remote transport RFD implemented would couple interoperability promises to unresolved lifecycle/routing rules. Native WebSocket reconnect is also insufficient to recover an ACP connection; this adapter never silently reconnects or resends messages.

### A relay below protocol interpretation

`AcpBridge` connects two framed transports with supervised, ordered pumps, preserving payload text apart from transport delimiters. It does not initialize, authenticate, rewrite IDs, inspect session methods, or project versioned schemas. Both directions remain active while requests are pending. Batches and unknown extensions therefore retain the same meaning at either endpoint.

Use bounded buffering and await writes. Sustained pressure beyond a configured deadline closes the bridge with a transport failure instead of allocating an unbounded queue or dropping a frame. Failure or EOF of either side closes the bridge scope and the owned counterpart exactly once. Shared externally owned processes are not accepted by the convenience spawned-process route.

### Mountable HTTP route layer

`server/BridgeHttp` adds an upgrade route to an application-provided `HttpRouter`. The application supplies authentication, an origin policy, and a launch-profile resolver. Resolve authorization and the permitted command/workspace before spawning; do not let arbitrary browser payloads select executable paths or environment secrets. Use current application middleware rather than install a separate authentication framework.

`transport/WebSocket` remains browser-safe and depends on Effect's socket constructor; Node/Bun HTTP and process implementations are injected at the server boundary. Include separate composition examples for mounting an existing server and running a standalone Bun/Node server. IPC adapters can implement the framing contract later without changing ACP session code.

## Risks / Trade-offs

- Connection-scoped cleanup ends active work on disconnect -> document this profile and direct consumers needing refresh survival to hosted sessions.
- A slow side can block delivery -> finite queues, write deadlines, frame limits, and tests with a stalled consumer.
- Forwarded data is untrusted -> keep authorization at the route boundary and parsing at ACP endpoints; never interpret stdout as logs.

## Migration Plan

Apply after the foundation. Add the new transport and route entry points without changing existing stdio behavior. Verify a browser permission round trip through the real route and a subprocess peer. Rollback removes the route/layer configuration; clients receive connection errors and no session recovery is promised.
