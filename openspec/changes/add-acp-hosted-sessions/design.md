# Design

## Context

See [proposal.md](proposal.md). The foundation and session-client sibling changes must be implemented first. A transparent relay cannot restore a browser's lost request registry or reducer. The architecture therefore places the local ACP client in a retained host and uses a separate application protocol for browser commands and observations.

## Goals / Non-Goals

**Goals:** Survive browser loss while the host remains alive; preserve the local client contract remotely; make recovery boundaries, duplicate prevention, and ownership observable.

**Non-Goals:** Host-crash durability, process migration, cross-user process sharing, automatic replay of ambiguous agent commands, or simultaneous controlling clients.

## Decisions

### Ownership is above request scopes

`AcpHost` is a scoped application service instantiated once. It owns child scopes for isolated principal/workspace agent connections and their session runtimes. Attachment fibers belong to HTTP/WebSocket request scopes. Closing an attachment does not close its owning session or interrupt an already admitted host command. Run command execution in host-owned fibers; gateway handlers only admit commands or wait for outcomes.

Require an explicit host policy containing positive retention duration, interaction deadline, shutdown deadline, event count/byte bounds, transcript/terminal bounds, command capacity, and command retry duration. Validate this at layer construction. A configuration helper can document example values, but this change does not hide unbounded retention behind defaults. Start the retention timer after the last attachment disappears and cancel it atomically on successful reattachment.

Alternative: making the WebSocket route own the local client is simpler but violates the refresh requirement. Durable workflow/storage infrastructure would not preserve the subprocess and is outside the current guarantee.

### A versioned application gateway over Effect RPC

Define `AcpGateway` with public `Rpc`/`RpcGroup` declarations and Effect schemas. Use a package gateway version independent of ACP version. The first exchange checks gateway compatibility before admitting commands. Compose `RpcServer.layerProtocolWebsocket`, matching serialization, and existing `HttpRouter`; use `RpcClient` socket support in `AcpGatewayClient`. No custom ACP WebSocket profile is involved and no standard ACP compatibility is claimed for this endpoint.

Expose connection/session lifecycle commands, capability/authentication data, submissions, configuration changes, interactions, and an attachment stream. The stream begins with attachment metadata and either a snapshot or a replay boundary, followed by ordered application events. `AcpRemoteClient.layer` maps these contracts to the same `AcpClient` service as the local implementation. All mutable state remains authoritative at the host; the browser projects host events rather than interpreting ACP twice.

Preserve versioned raw update observation. General raw extension calls must pass through a typed gateway command and the same ownership/ledger rules; never expose an unrestricted second route that bypasses admission. Server-side filesystem/terminal handlers are configured on the host; a remote application cannot advertise unavailable browser capabilities accidentally.

### Snapshot, replay, and controller generations

Use distinct IDs for host epoch, hosted session, agent session, event sequence, controller generation, interaction, and command. Allocate a new unpredictable epoch for each host lifetime. Keep a bounded journal per session and a single serialization boundary for reducer state, event sequence allocation, snapshot capture, and subscriber registration.

An attachment with retained state can request events after its last applied sequence. A fresh browser requests a snapshot. A cursor behind the journal floor receives a snapshot plus resynchronization metadata; future or cross-session cursors fail validation. A mismatched host epoch returns `HostRestarted`/state-unavailable instead of fabricating continuity. Replayed and live events are deduplicated by epoch/session/sequence, never by message content. An overflowed subscriber is detached with a resync indication so it cannot stall the reader.

Allow one controlling attachment. Initial attachment claims a controller generation; reconnect can reclaim control when the previous attachment is gone. Explicit authorized takeover increments the generation and revokes the old controller. A second live attachment without takeover fails with a conflict. Validate generations at command admission and interaction resolution; commands already accepted by the host remain owned by the host through a takeover.

### Bounded duplicate prevention with server-issued command windows

A random client operation ID alone cannot distinguish a new command from an evicted old retry. Issue an owner-bound command window token containing the host epoch, logical client identity, and a server-controlled expiry. Preserve the logical client identity across refresh through the application's client storage adapter. Every mutating command carries that token and a client-generated operation ID.

Admission under the host's serialization boundary checks authorization, controller generation, token validity, canonical payload equality, and ledger capacity. Record the operation before starting its fiber. A duplicate ID in the same window returns the existing status/result; a different payload produces a conflict. Never evict unresolved operations. Retain completed outcomes until the window expires; reject new admission at capacity instead of evicting still-retryable entries. After expiry, return an expired-window error rather than executing the command, even if its ledger entry was removed. Renewing a window does not authorize automatic resubmission of a prior ambiguous command.

Return host acceptance independently of agent acceptance. The v2 agent response supplies the accepted message ID; v1 exposes its documented limitation. If the host remains alive but ACP fails after dispatch, store `outcomeUnknown`. On host restart, old tokens fail due to epoch mismatch. Neither a journal snapshot nor absence from agent replay proves that a prompt never executed. No exactly-once guarantee extends beyond this host/window lifetime.

Alternative: retrying every failed RPC, or deduplicating solely by prompt text, can cause duplicate agent work. A durable ledger would still need an agent-side idempotency contract to resolve the crash-after-send boundary.

### Pending interactions and shutdown

Pending permissions/elicitation are data in the host snapshot with one-shot resolution tracked by their runtime. Browser detach keeps them pending until the configured deadline. Incoming ACP cancellation, user resolution, session cancellation, and expiry race through one state transition; stale replies fail rather than responding twice. Disconnect never approves a request. Permission cancellation uses the permission outcome; generic request cancellation uses the applicable ACP error semantics.

Retention expiry marks the session closing before accepting further mutations, cancels foreground work, resolves outstanding interactions, and attempts supported session close. Continue handling final updates until confirmation or the shutdown deadline. Release an agent process only after its connection has no remaining session owners. If a shared connection becomes unhealthy during cleanup, report that connection failure to every affected session rather than silently claiming they remain usable.

### Application integration and privacy

Require an authorization service mapping authenticated principals to launch profiles, workspaces, and session actions. Apply it before metadata, attachment, command, and interaction lookups. Enforce explicit WebSocket origin policy. Host authentication and agent login remain separate; authentication responses do not imply broader workspace access. Default telemetry contains lifecycle identifiers, counters, and errors, not prompts, secrets, or filesystem payloads.

## Risks / Trade-offs

- Host restart loses retained state -> epoch changes and explicit recovery limitations; no blind agent prompt retries.
- Snapshot/subscribe races corrupt projections -> one atomic sequence boundary and deterministic scheduling tests.
- Command ledger can fill with long operations -> admission backpressure and explicit capacity errors, never unsafe eviction.
- Controller takeover races with permissions -> generation checks and one-shot host interaction transitions.
- In-memory transcripts and queues can grow independently -> separate count/byte/content limits with visible truncation/resync.

## Migration Plan

Apply after foundation and session client. Reuse the local/remote contract suite, then add a browser refresh integration test with a deterministic subprocess agent. Mount the gateway beside existing application routes; no transparent bridge changes are required. Disabling the gateway stops new attachments; drain/expire host sessions before shutting down. No durable data migration or production deployment is included.
