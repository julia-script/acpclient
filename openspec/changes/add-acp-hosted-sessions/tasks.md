# Tasks

## 1. Host ownership and contracts

- [x] 1.1 Consume the implemented foundation/session client and define gateway schemas, independent version negotiation, host/session/epoch identities, and safe errors; verify schema round trips and unsupported gateway version rejection.
- [x] 1.2 Add AcpHost with principal/workspace-owned child scopes and validated finite resource policy; verify closing an attachment does not close its ACP owner and invalid policies fail at construction.
- [x] 1.3 Add a single-controller generation registry with explicit takeover and ownership hooks; verify unauthorized attachment, duplicate live controller, and stale-generation mutations are rejected.

## 2. Retained observations and interactions

- [x] 2.1 Implement bounded per-session event journals and sequence assignment coordinated with the session reducer; verify ordering, journal-floor movement, and explicit content truncation.
- [x] 2.2 Implement atomic snapshot/replay/live attachment with cursor validation and deduplication; verify an update racing attachment is neither lost nor applied twice and overflow forces resynchronization.
- [x] 2.3 Connect pending interactions to restored snapshots and controller generations; verify refresh during permission, duplicate resolution, takeover races, and expiry never cause automatic approval or duplicate agent replies.
- [x] 2.4 Implement detach retention timers and bounded cleanup of the final owner; verify reattach cancels expiry, one session can expire without killing another, and an unresponsive final process is released at deadline.

## 3. Command ownership and retry windows

- [x] 3.1 Implement authenticated server-issued retry windows and a bounded command ledger with canonical payload comparison; verify duplicate IDs reuse outcomes, conflicting payloads fail, and expired/old-epoch tokens never dispatch.
- [x] 3.2 Atomically admit mutations before launching host-owned execution fibers; verify RPC interruption after admission leaves the command running and ledger capacity rejects work without unsafe eviction.
- [x] 3.3 Expose host admission, agent acceptance, retained outcomes, and uncertain ACP results separately; verify response loss/agent failure never triggers automatic prompt resubmission.
- [x] 3.4 Add the client storage adapter contract for logical identity, retry token, and pre-send operation IDs; verify a simulated browser refresh recovers the same retained operation rather than inventing a new one.

## 4. Gateway and remote client

- [x] 4.1 Implement schema-backed Effect RPC handlers for lifecycle, authentication, submissions, configuration, interactions, raw extensions, and attachment streams; verify every surface checks principal/workspace/control authority and uses the same mutation admission path.
- [x] 4.2 Mount the gateway using Effect RPC WebSocket protocol layers and application-provided HttpRouter/auth/origin integration; verify denied upgrades and launch profiles cannot create unauthorized processes.
- [x] 4.3 Implement AcpGatewayClient and AcpRemoteClient with snapshot/event projection; run the session client's shared contract suite against the remote implementation for both protocol versions.
- [x] 4.4 Add lifecycle metrics/logging and safe serialized failures; verify default telemetry and gateway errors omit credential, prompt, and filesystem payload fixtures.

## 5. End-to-end recovery

- [x] 5.1 Build a browser integration fixture backed by a deterministic subprocess and explicit host policy; verify refresh during streaming and permission handling restores retained state without new ACP initialization.
- [x] 5.2 Exercise lost gateway responses, journal overflow, command-window expiry, host restart, agent crash, and concurrent takeover; verify the specified resync, conflict, and uncertain-outcome behavior.
- [x] 5.3 Document mounting, client storage, retention/retry guarantees, local/remote parity, and the distinction from raw ACP bridging; verify examples typecheck and run type, test, and browser-import checks.

Verification: `bun run check`. Coverage includes the shared local/remote v1/v2 contract suite, host authorization/controller/retry/retention tests, real process crash and shutdown tests, denied gateway upgrades, and the executable WebSocket/subprocess refresh example. The server uses the public per-upgrade WebSocket protocol primitive underlying `layerProtocolWebsocket` to bind authenticated identity to handlers.
