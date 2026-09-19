# Tasks

## 1. WebSocket profile

- [x] 1.1 Implement the browser-safe WebSocket adapter over the foundation transport contract and document subprotocol/framing rules; verify v1/v2 text frames, profile mismatch, binary rejection, and message-size limits.
- [x] 1.2 Make socket failure and scope release terminal without implicit reconnect; verify pending peer calls fail and no frame is resent after connection loss.

## 2. Relay and server composition

- [x] 2.1 Implement two supervised bridge pumps with ordered writes, finite buffering, and pressure deadlines; verify bidirectional requests, batches, raw extension preservation, and stalled-consumer cleanup.
- [x] 2.2 Add the mountable HttpRouter upgrade layer with authentication, origin policy, and authorized launch-profile resolution before spawn; verify denied requests never start a child process.
- [x] 2.3 Connect upgraded sockets to owned stdio connectors and idempotent cleanup; verify browser EOF, child exit, and simultaneous failures release all bridge-owned resources.

## 3. Integration and documentation

- [x] 3.1 Exercise a browser ACP driver through the real route and a deterministic stdio peer; verify prompt, reverse permission request, notification, error, and batch round trips for both enabled protocol versions.
- [x] 3.2 Add existing-server and standalone runtime composition examples plus lifecycle limitations; verify examples typecheck/run and document that refresh recovery requires the hosted gateway.
- [x] 3.3 Run bridge tests and a browser bundle/import check; verify no process/server dependency enters the client adapter and all acp-transport-bridge scenarios pass.
