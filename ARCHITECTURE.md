# effect-acp architecture

Status: implemented foundation, direct session client, transparent bridge, hosted gateway, and agent authoring. ACP v2 remains an explicit draft opt-in; v1 is the default.

This package provides an Effect-native API for applications that embed rich Agent Client Protocol (ACP) sessions. It prioritizes consuming existing agents, uses ACP v2 as its primary design model, and supports v1 peers through a separate compatibility adapter. Agent authoring is a secondary goal built on the same protocol foundation.

## 1. Decisions and scope

The following product decisions are established:

- Design primarily for ACP v2 while retaining v1 interoperability because v2 is still a draft.
- Offer a rich, transport-independent session API for browser, desktop, and server applications.
- Support direct agent connections and communication through an intermediate application server or desktop main process.
- Keep hosted sessions running through browser refreshes and temporary disconnects, with an explicit retention timeout.
- Use Effect Schema throughout protocol boundaries and shared application contracts.
- Reuse Effect's networking, resource management, concurrency, and service composition facilities.

The sections below record the architecture and its implementation boundaries. Public module entry points and runnable compositions are listed in README.md.

Initial scope excludes guarantees of survival across host crashes, distributed ownership, concurrent editing by multiple clients, UI components, and an agent reasoning loop. These can build on the architecture without becoming requirements of the protocol package.

ACP connects an application to an agent. MCP connects an agent to tools and resources. Passing MCP server configurations to an ACP session does not make the ACP connection an MCP connection.

## 2. Three deployment compositions

### Direct client

```text
Application
    |
AcpClient + AcpSession
    |
AcpConnection + negotiated v1/v2 adapter
    |
AcpTransport: stdio, WebSocket, or custom
    |
ACP agent
```

The application owns the connection scope. A CLI or desktop main process can spawn an agent directly; a browser can connect directly to an agent with a compatible remote transport.

### Transparent transport bridge

```text
Browser / renderer                         Server / desktop main
AcpClient + AcpSession
    |
AcpConnection <-- ACP JSON-RPC over WS --> AcpBridge <-- stdio --> Agent
```

`AcpBridge` forwards bidirectional ACP messages between transports. It preserves request IDs, notifications, errors, batches, extension payloads, and ordering within each direction. It does not translate v1 to v2 or claim ownership of an application's session model.

This is useful when a client needs access to a transport it cannot open locally. A thin bridge alone does not recover a browser's lost runtime, pending requests, or accumulated UI state after a refresh. Its initial lifecycle is connection-scoped; persistent recovery belongs to the hosted composition.

### Hosted sessions: recommended for reconnectable apps

```text
Browser / renderer                       Server / desktop main

AcpClient remote facade                  AcpHost
    |                                        |
Session snapshots, events, commands       Local AcpClient + session runtime
    |                                        |
AcpGatewayClient <-- Effect RPC / WS --> AcpGateway
                                             |
                                        AcpConnection
                                             |
                                        stdio or other ACP transport
                                             |
                                           Agent
```

The host owns the actual ACP client, negotiated connection, session state, and pending requests. Browser connections are replaceable attachments to that host.

This adds a session gateway to the original transport-bridge idea. The reason is lifecycle ownership: the server must continue processing agent messages even when the browser no longer exists. Transparency is provided at the application API level: direct and hosted implementations provide the same `AcpClient` service and session handles.

The gateway protocol is a package-owned application protocol, explicitly distinct from ACP. Effect RPC is appropriate here because both endpoints belong to this package. A standard ACP client cannot connect to a gateway endpoint unless a separate ACP-facing endpoint is provided.

Electron may use IPC or message ports for this application hop. HTTP/WebSocket is a convenient supplied adapter, not a dependency of the core session model.

## 3. Protocol status and compatibility

The vendored [v2 transport specification](repos/agent-client-protocol/docs/protocol/v2/transports.mdx) defines newline-delimited JSON-RPC over stdio and permits custom bidirectional transports. Streamable HTTP remains a draft proposal. The [HTTP/WebSocket RFD](repos/agent-client-protocol/docs/rfds/streamable-http-websocket-transport.mdx) is research input, not an adopted interoperability contract.

Ship stdio and a documented custom WebSocket transport first. Keep draft remote ACP profiles separately named and versioned if implemented. Track the eventual standard without coupling session logic to its current proposed headers or routing. HTTP transports must carry agent-initiated requests as well as updates and responses; a prompt POST with a response stream is insufficient.

The [migration guide](repos/agent-client-protocol/docs/protocol/v2/migration.mdx) distinguishes the v2 baseline schema from additional unstable features. The entire v2 surface is still draft. Make v2 enablement explicit while it remains draft; when enabled, negotiate v2 preferentially and accept supported v1 responses. Independently gate unstable features. Prefer an explicit supported-version policy over a single global protocol constant.

An initialized ACP connection speaks one negotiated version. Select a version adapter once and keep it for that connection. Validate initialization results against the selected version, including its capabilities. Unsupported versions close the connection with a typed error. Cross-version initialization payload differences need interoperability fixtures; do not assume a permissive parser or repeatedly initialize an already active connection to repair negotiation.

| Concern | v2 interpretation | v1 compatibility behavior |
| --- | --- | --- |
| Prompt response | Confirms insertion and returns agent message ID | Completes the turn and carries its stop reason |
| Foreground state | Agent reports running, requires-action, and idle states | Infer supported state transitions from prompt and interaction lifecycle; mark their provenance |
| Acceptance | Distinct acknowledgement | Report unavailable until evidence exists; never fabricate an early acknowledgement |
| Message identity | Agent-issued message IDs | Preserve supplied IDs; otherwise use local IDs with explicitly limited replay stability |
| History replay | `session/resume` with replay options | Use supported `session/load`; plain resume is separately capability-gated |
| Session operations | Session capability implies a baseline | Check individual advertised support where v1 requires it |
| Modes and configuration | Configuration options | Preserve v1 modes separately where conversion would lose semantics |
| Filesystem / execution | Client tools may be supplied through MCP | Optional v1 client handlers for filesystem and terminal methods |

Normalize useful application concepts, but retain the negotiated version, capability information, source provenance, and access to versioned payloads. Do not make a v1 connection look like a fully conforming v2 peer.

## 4. Proposed package structure

Start with one package and explicit module entry points. Separate runtime-specific dependencies through layers and imports; package splitting can follow demonstrated needs.

```text
src/
  AcpSchema.ts                 Shared IDs, content helpers, application models
  AcpError.ts                  Typed public failures
  AcpProtocol.ts               Version adapter contract and selection
  AcpTransport.ts              Context.Service for one scoped duplex connection
  AcpConnector.ts              Factories that open transport connections
  AcpConnection.ts             ACP JSON-RPC peer and request lifecycle
  AcpClient.ts                 Common application-facing service contract
  AcpLocalClient.ts            Direct implementation of AcpClient
  AcpRemoteClient.ts           Hosted implementation of AcpClient
  AcpApp.ts                    Session snapshots, capabilities, and data schemas
  AcpSessionState.ts           Pure v1/v2 state reduction
  AcpSessionError.ts           Application-level typed failures
  AcpHost.ts                   Retained connections and session ownership
  AcpBridge.ts                 Transparent transport relay
  AcpGateway.ts                Application command and event contracts
  AcpGatewayClient.ts          Typed gateway client
  AcpAgent.ts                  Agent-side handler construction and serving
  agent/
    Store.ts                   Session and transcript persistence contract
    Content.ts                 Version-neutral content blocks for handlers
  protocol/
    v1/Schema.ts               v1 wire schemas and method definitions
    v2/Schema.ts               v2 baseline wire schemas and methods
  transport/
    Stdio.ts                  Spawned process connection
    ProcessStdio.ts           Current-process connection, for served agents
    WebSocket.ts              Custom ACP WebSocket framing
    InMemory.ts               Paired transports for verification
  server/
    GatewayHttp.ts            Mount gateway routes into HttpRouter
    BridgeHttp.ts             Mount transparent ACP WebSocket bridge
  internal/
    jsonRpc.ts                Envelope validation and correlation
    capabilities.ts           Versioned capability normalization
    framing.ts                Bounded UTF-8 newline framing
```

The session runtime lives in AcpLocalClient; the journal, controller registry, and command ledger live in AcpHost. Pure contracts and reducers remain browser-safe. Node/Bun process implementations are supplied by the host application, rather than imported through the package's browser-facing entry points. Vendored repositories are references only; application imports use normal dependencies.

Dependency direction:

```text
Wire schemas + errors
          |
Transport + JSON-RPC peer + protocol adapters
          |
Local client + session runtime
          |
Host + gateway server

Shared session/gateway schemas --> gateway client --> remote client
Transport + JSON-RPC peer ------> agent authoring API (later)
Transport ---------------------> transparent bridge
```

## 5. Effect services, layers, and scopes

Use `Context.Service` for injectable capabilities and `Layer` for their construction. Use ordinary scoped values for individual connections and sessions; avoid a global service instance for every session ID.

| Boundary | Effect structure | Ownership / dependencies |
| --- | --- | --- |
| Transport instance | `AcpTransport` service, provided by stdio/WebSocket/process-stdio/in-memory Layers | Frame reader and ordered writer |
| Transport factory | `AcpConnector` builds a fresh transport Layer in each caller scope | Process spawner, socket constructor, or app-provided adapter |
| ACP connection | Scoped value with typed request, notification, and handler operations | One transport, selected protocol adapter, pending-request registry |
| Application client | `AcpClient` service supplied by local or remote layer | Local connector/runtime or gateway client |
| Session handle | Value exposing Effect operations and Stream subscriptions | References an owning runtime; UI handle release does not imply remote session close |
| Session runtime | Serialized reducer plus `SubscriptionRef` and bounded event delivery | One authoritative owner per live session |
| Pending requests | `Deferred` completions plus tracked handler fibers | Connection lifetime; terminal failure resolves all pending waits |
| Host | Scoped `AcpHost` service with owned child scopes | Local connection factory, retention policy, clock, identity/authorization integration |
| Gateway | `Rpc` / `RpcGroup` contracts with schema-backed payloads and errors | Host-backed handlers and an application transport |
| HTTP integration | Route layers requiring `HttpRouter` | Existing application middleware and Node/Bun HTTP server |

Use `Layer.effect` to acquire scoped services and compose dependencies through `Layer.provide` / `Layer.provideMerge`. Cache/share the host layer once per application runtime. Creating it inside each route invocation would accidentally bind sessions to individual HTTP requests.

### Resource tree

```text
Application Scope
  |
  +-- AcpHost
  |     +-- Owned agent connection Scope
  |           +-- Process + stdout reader + stdin writer + stderr drain
  |           +-- JSON-RPC pending requests + incoming request handlers
  |           +-- Session runtime A + bounded journal + interaction registry
  |           +-- Session runtime B + bounded journal + interaction registry
  |
  +-- HTTP server
        +-- Browser attachment Scope
              +-- WebSocket + event subscription
```

A browser disconnect closes its attachment scope. It does not close the host's agent scope, interrupt accepted host commands, or cancel active agent work. Host shutdown closes owned resources and settles pending operations. A disconnected direct client has the lifecycle guarantees of its own owning application scope.

Start with isolated agent connections per application ownership boundary, such as a user and workspace. One connection may contain multiple sessions. Never terminate a shared agent process merely because one of its sessions closes. Cross-user process sharing is outside the initial design.

### Reuse of existing Effect facilities

- [`ChildProcessSpawner`](repos/effect/packages/effect/src/unstable/process/ChildProcessSpawner.ts) supplies scoped subprocess handles. Keep stdout exclusively for ACP, drain stderr independently, and observe process exit.
- [`Socket`](repos/effect/packages/effect/src/unstable/socket/Socket.ts) supplies scoped readers/writers and WebSocket construction. HTTP server requests can be upgraded to sockets.
- [`HttpRouter`](repos/effect/packages/effect/src/unstable/http/HttpRouter.ts) supplies route layers and `serve`. `toWebHandler` supports web-standard HTTP integration; WebSocket upgrades and subprocesses still require a capable host runtime.
- [`RpcServer`](repos/effect/packages/effect/src/unstable/rpc/RpcServer.ts) supplies `layerProtocolWebsocket`; [`RpcClient`](repos/effect/packages/effect/src/unstable/rpc/RpcClient.ts) supplies socket protocols. Use these for the package-owned gateway, with a matching serialization layer on both ends.
- [`HttpApiBuilder`](repos/effect/packages/effect/src/unstable/httpapi/HttpApiBuilder.ts) can supply schema-backed management endpoints when HTTP/OpenAPI integration is useful. Avoid duplicating every streaming gateway operation as REST without a consumer need.
- [`McpSchema`](repos/effect/packages/effect/src/unstable/ai/McpSchema.ts) demonstrates schema-backed method declarations. [`McpServer`](repos/effect/packages/effect/src/unstable/ai/McpServer.ts) demonstrates composition of protocol runtime, serialization, and transport layers.

Effect's [`RpcSerialization`](repos/effect/packages/effect/src/unstable/rpc/RpcSerialization.ts) JSON-RPC mode also encodes Effect control messages and streaming conventions. Do not pass it unchanged to external ACP peers. The ACP boundary needs a deliberately ACP-compatible peer/codec, whether implemented directly with Effect primitives or by adapting public RPC facilities after a compatibility spike. No imports from Effect's internal MCP implementation.

## 6. Schemas and transport contracts

Keep three schema families distinct:

1. **ACP wire schemas:** separate v1 and v2 models matching upstream JSON schemas and method semantics.
2. **Application schemas:** session snapshots, events, submissions, capabilities, and pending interactions.
3. **Gateway schemas:** commands, attachment cursors, host identities, typed failures, and protocol version negotiation for this package's application hop.

Generate or systematically derive static Effect wire schema definitions from pinned upstream inputs. The generator choice remains open; generated TypeScript types alone are insufficient. Keep version-specific generated surfaces separate even when some reusable content types are identical. Application models and their conversion rules remain deliberate library design.

Schema requirements:

- Preserve omitted, explicit `null`, and concrete values wherever the protocol uses patch semantics. Do not apply defaults that erase the distinction.
- Validate known variants strictly. An invalid known variant must not succeed through a generic unknown-variant fallback.
- Accept and preserve unknown variants only where the upstream schema allows them; retain raw payloads and `_meta` through forwarding, storage, and replay.
- Keep JSON-RPC IDs, agent session/message IDs, local UI IDs, gateway command IDs, and host event sequence numbers distinct.
- Share schema-defined errors across gateway endpoints; keep local causes and secrets out of serialized failures.
- Check schema conformance and codec round trips against the pinned upstream fixtures and representative extension payloads.

`AcpTransport` is the injected service for a single scoped connection. Its implementations are `transport/Stdio.layer`, `transport/WebSocket.layer`, `transport/ProcessStdio.layer`, and `transport/InMemory.layer`. `AcpConnection.make` consumes that service; `AcpConnection.layer` exposes the JSON-RPC connection as a service. `AcpConnector.layer(transportLayer)` is a separate, lazy factory for applications opening multiple connections, building the transport Layer freshly inside each caller scope.

The transport service exchanges framed JSON messages, including batch arrays, bidirectionally. It owns frame decoding/encoding, ordered writes, closure, and transport errors. `AcpConnection` owns envelope validation, method dispatch, request/response correlation, and ACP errors. Per-method schemas belong to protocol adapters. Invalid JSON must remain distinguishable from an invalid JSON-RPC envelope so the peer can produce the appropriate error response when the transport remains usable.

Stdio framing must tolerate arbitrary byte boundaries, including split UTF-8 and split lines. Configure maximum frame sizes and bounded buffering. A WebSocket adapter has its own documented frame policy. A raw bridge can validate envelopes without reconstructing method payloads and thereby discarding unknown data.

## 7. Session API and event processing

The application API covers initialization/authentication, new/list/resume/close/delete where supported, prompt submission, cancellation, configuration, observations, and interaction responses. Unsupported operations produce typed capability errors rather than optimistic calls that hide version differences.

A session exposes:

- An immutable snapshot of messages, tool calls, plans, display terminals, configuration, commands, usage, and pending interactions.
- A state stream suitable for application rendering.
- An ordered event stream for consumers that need transitions or raw versioned updates.
- Effect operations to submit prompts, cancel foreground work, change configuration, and resolve interactions.
- Connection/attachment state distinct from foreground agent state.

Process incoming updates through one ordered reducer per session. Do not let asynchronous rendering or a permission dialog block the connection reader. Incoming requests are dispatched to tracked fibers; messages for other sessions and request responses continue to flow.

The [v2 prompt lifecycle](repos/agent-client-protocol/docs/protocol/v2/prompt-lifecycle.mdx) requires separating submission, acceptance, and session foreground completion. A submission gets a local operation identity; a successful v2 response supplies the agent's message ID. Updates may arrive before the response. Reconcile using request correlation and agent IDs, never prompt content or assumed arrival order.

Completion belongs to session foreground state. A convenience prompt-and-wait operation may be added with documented exclusive-use semantics; it must not imply that every idle transition is attributable to one prompt when concurrent or agent-initiated work is possible. Initially serialize library-driven prompt submission while a session is busy unless the negotiated behavior explicitly supports more.

Apply upserts and chunks according to the negotiated version. Full content replaces accumulated content, omitted fields preserve it, and explicit clearing removes it where specified. Replay uses those same semantics. Terminal output is byte data with its own snapshot/chunk rules; do not coerce it into ordinary text messages or expose display terminals as execution handles.

Maintain protocol processing independently of observers. State subscriptions are not a substitute for an event journal, and `PubSub` alone is not reconnect storage. Use bounded subscriber delivery with an explicit overflow/resynchronization signal. A slow UI must not block the agent indefinitely or silently lose deltas needed to reconstruct state. Apply explicit limits to retained transcript/terminal content as well as event count and bytes; expose truncation in snapshots.

## 8. Hosted reconnect and command ownership

### Guarantee boundary

The initial host retains sessions in memory across browser refreshes and temporary network loss. Retention lasts for a configured interval after the last attachment disappears. Active work may continue during that interval, subject to pending user interactions and the host's resource policy.

This is not host-crash durability. Restarting the server creates a new host epoch and may lose live-only agent messages and operation outcomes. A future persistent store cannot restore a dead process or recover an ambiguous agent-side side effect by itself.

### Attachment protocol

Each host-owned session has an application handle, a host epoch, and a monotonically increasing event sequence. These are application protocol fields, not ACP fields or agent replay cursors.

1. Authorize an attachment to an existing host/session handle.
2. If its epoch and cursor are retained, replay subsequent host events and transition to live delivery without a gap.
3. Otherwise return a fresh snapshot with its exact sequence boundary, then deliver events after that boundary. Snapshot acquisition and subscription registration must be coordinated atomically with the reducer.
4. Restore outstanding submissions and pending interactions from the host, including outcomes the disconnected browser never observed.

A refreshed browser generally needs a snapshot because its accumulated state is gone. A temporary network reconnect may use its last cursor. If the host is alive, reattachment does not send ACP `initialize` or `session/resume` again: the original ACP connection remains active.

Agent reconnection is a different operation. After an agent connection is lost, negotiate a new connection and use available ACP resume/load capabilities. [ACP replay](repos/agent-client-protocol/docs/protocol/v2/session-setup.mdx) covers retained agent history; it cannot prove that an unanswered submission was never accepted or reconstruct every live-only message. Report uncertain outcomes and incomplete recovery explicitly.

### Commands and duplicate prevention

Gateway mutating commands carry client-generated operation IDs scoped to their owner and host epoch. The host atomically records a command before starting it; retries with the same ID attach to that operation or retrieve its outcome instead of forwarding another ACP request. Reject reuse with a different payload. Retain outcomes and deduplication records for a documented retry window; retries outside that window require reconciliation rather than silent execution.

Acceptance by the host means the host owns the operation. It is distinct from ACP v2 acceptance by the agent. Disconnecting or interrupting a gateway request must not interrupt an already accepted host operation. Command execution fibers therefore belong to host scopes, and browser RPC fibers only wait for or observe them.

Do not automatically retry a prompt whose ACP result is unknown. The host ledger prevents duplicate forwarding only within its retained lifetime; it does not provide exactly-once execution across host crashes or agent failures. Persist an operation ID client-side before sending if recovery across a refresh is desired.

### Pending interactions and retention expiry

Permissions and elicitation are host-owned pending interactions with stable application IDs and exactly one accepted resolution. Keep agent request IDs private to the owning connection. Reattachment returns current interactions; expired, cancelled, or already answered prompts reject stale replies.

On browser detach, keep an interaction pending for a configured bounded period. Never turn disconnection into automatic approval. On deadline or retention expiry, resolve using the applicable protocol cancellation response. For session cancellation, respond to pending permission requests with their cancelled outcome and continue processing updates until cancellation is confirmed or a deadline/failure ends the wait.

On final retention expiry, stop accepting new work, cancel active work as appropriate, resolve pending interactions, close supported sessions, and release an agent process only when its ownership scope has no remaining users. Exact timeouts and whether particular workloads receive a longer retention policy remain configurable proposal decisions.

Start with one controlling attachment per session; reconnect replaces or reclaims that attachment through an explicit ownership generation. Read-only observation can be added separately. Old attachments must not resolve interactions after control moves to a new one.

## 9. Cancellation, errors, and host integration

Keep these operations separate:

| Action | Meaning |
| --- | --- |
| Stop observing / detach | Release a UI subscription or browser attachment |
| Interrupt a local wait | Stop waiting; do not infer that remote work stopped |
| `$/cancel_request` | Request cancellation of a specific ACP request |
| `session/cancel` | Cancel active session work; keep handling final updates |
| Close session | Release an active session according to negotiated support |
| Delete session | Delete agent history where supported |
| Close owned connection | Fail outstanding requests and release transport resources |

Expose typed failures for transport closure, malformed protocol data, unsupported versions/capabilities, remote ACP errors, authentication requirements, interaction expiry, missing retained state, and ambiguous submission outcomes. Transport retry policy must not automatically retry non-idempotent application commands. See the separate ACP [request cancellation](repos/agent-client-protocol/docs/protocol/v2/cancellation.mdx) and session cancellation rules.

Mount gateway and bridge routes into existing Effect servers. Let applications supply authentication and principal/workspace authorization. Bind every session lookup, cursor, operation ID, and interaction response to that ownership context. Browser WebSocket endpoints need an explicit origin policy in addition to authentication. Resolve process launch options and workspace access through host configuration; a generic public gateway must not treat arbitrary browser-supplied executable paths as authorized commands.

For v1 execution capabilities, advertise only installed handlers. Hosted filesystem and terminal handlers should normally execute at the host/workspace boundary so they remain available while the UI is absent. Editor-specific resources require an explicit attachment-dependent handler policy. In v2, tools exposed via MCP are a separate integration, not an implicit ACP transport feature.

Instrument connection/session lifetimes, pending request counts, replay gaps, queue limits, and reconnect attempts using Effect logging and tracing. Avoid logging prompt bodies, credentials, filesystem contents, or permission payloads by default. Keep app authentication separate from ACP agent authentication.

## 10. Agent authoring

`AcpAgent` reuses the wire schemas, duplex peer, error mapping, transport layers, and cancellation machinery. Authors provide Effect handlers and services for authentication, session storage, and prompts; application dependencies flow through the ordinary Effect environment (`AcpAgent.make<R>`), and the agent discharges them once per served connection.

Capabilities are derived from the installed handler surface and validated at construction, so an agent cannot advertise a baseline method it does not implement: advertising sessions requires `session.create`, `prompt.insert`, and `prompt.execute`; a non-empty `auth.methods` list requires both `auth.login` and `auth.logout`. `make` throws `AcpAgentConfigError` rather than failing at the first connection.

Prompting has two phases because the versions disagree about when a prompt is answered. `prompt.insert` records the user message and yields its canonical `messageId`; only its success produces a v2 `session/prompt` response. `prompt.execute` then runs the foreground turn in a scope owned by the *session*, not the request fiber, so v2 processing continues after acknowledgement. V1 keeps its turn-long response and reports the stop reason there, while v2 reports completion as an idle `state_update` after final updates have been emitted.

`Emit` maps typed updates onto the negotiated version — chunks drop `messageId` on v1, and full-message replacement is refused there rather than inventing a wire shape. Replay reads the injected `Store`: a retained replacement resets the client's accumulated content before chunks are appended, preserving the original message identity. Retention guarantees belong to the supplied store, not the library; `Store.layer` is an in-memory reference implementation.

Client interactions (`requestPermission`, `elicit`) run as ordinary outgoing requests, so a waiting handler never blocks unrelated traffic. An elicitation mode the client did not advertise is rejected before anything is sent. Session cancellation interrupts owned execution, letting its finalizers drain final updates before the cancelled completion signal.

Handler failures map to their typed code; defects are logged locally and reported as a bare `Internal error`, so causes never reach the client.

`transport/ProcessStdio` serves the current process's stdin/stdout through Effect's injected `Stdio` service — the mirror of the spawning `transport/Stdio`. Stdout carries only ACP frames; use `ProcessStdio.diagnostic` or a logger for anything else. `AcpAgent.serveStdio` and `AcpAgent.layerStdio` compose it. Storage and model/tool orchestration stay injectable: ACP conformance requires no particular model provider or reasoning loop, and hosting an existing stdio agent does not depend on this module. See `examples/echo-agent.ts`.

## 11. Verification gates

Implementation should demonstrate these behaviors before claiming the corresponding capability:

- Both protocol versions negotiate with representative independent peers; v2 baseline and unstable features stay distinct.
- Split byte/line framing, invalid JSON, invalid envelopes, mixed batches, notifications, and bidirectional request IDs behave correctly.
- Unknown extension payloads round-trip without relaxing validation of malformed known variants.
- Direct and hosted clients expose equivalent supported session behavior with explicit capability/provenance differences.
- Prompt updates arriving before acknowledgements reconcile correctly; completion and cancellation follow the negotiated lifecycle.
- A browser refresh during output loses no retained state and does not terminate the agent; refresh during permission handling restores the interaction once.
- Snapshot plus live subscription has no race; reconnect after journal overflow reports resynchronization; duplicate delivery does not append content twice.
- Retrying a retained gateway operation does not send a second ACP prompt; host/agent failures surface uncertain outcomes honestly.
- Slow observers, transcript limits, process stderr volume, and disconnected clients cannot create unbounded memory growth or stall unrelated protocol handling.
- Retention expiry and shutdown release scopes, processes, queues, and waits; closing one session does not kill unrelated sessions.
- Ownership checks reject access through another principal's session handle, event cursor, operation ID, or stale control attachment.

Use paired in-memory transports, deterministic Effect concurrency/clock tests, protocol fixtures, and real subprocess/browser integration checks where needed. The tests exercise local/remote shared contracts, deterministic ownership/retry/overflow failures, and real WebSocket/subprocess recovery. `bun run check` also verifies schema generation, types, and browser imports.

## 12. Decisions and reference snapshot

The implemented proposals resolve the following choices:

1. AcpClient/AcpSession handles distinguish v1 turn completion, v2 insertion acknowledgement, and session foreground state.
2. Version-pinned generated schemas are checked against the vendored JSON Schema inputs.
3. ACP uses its own schema-aware JSON-RPC peer; the hosted application protocol uses Effect RPC.
4. Gateway v1 uses server-issued retry windows, generation-based control, bounded snapshot journals, and an explicit host policy with no hidden unbounded retention defaults.
5. In-memory, spawned stdio, current-process stdio, and custom WebSocket adapters are implemented with injected runtimes.
6. Draft Streamable HTTP remains outside these proposals. The implemented bridge profile is explicitly package-owned.

The gateway mounts using the public `makeProtocolWithHttpEffectWebsocket` primitive underlying `layerProtocolWebsocket`; per-upgrade handlers capture authenticated identity. The client builds its protocol layer in the socket owner's scope and disables transport retries. Client root imports do not pull in AcpHost, agent authoring, or server routes.

Research baseline: 2026-09-18, local Effect `4.0.0-rc.115`, and the vendored ACP docs/schema files referenced above. Schema SHA-256 values at review time:

```text
schema/v1/schema.json
3c17bd6385d90cf672d8a661fddc359d73422cf8b8ce6865213d25cfd4c0eca7

schema/v2/schema.json
3df13661962bf9ed3162a3e50d75fab3d768247995bfb1754b0d844ae139ce4c
```

The schemas live under [repos/agent-client-protocol/schema](repos/agent-client-protocol/schema). The [extensibility rules](repos/agent-client-protocol/docs/protocol/v2/extensibility.mdx), [v1 session lifecycle](repos/agent-client-protocol/docs/protocol/v1/session-setup.mdx), and [v2 initialization rules](repos/agent-client-protocol/docs/protocol/v2/initialization.mdx) are additional normative inputs. When draft prose, examples, and schemas disagree, record the discrepancy and resolve it through version-pinned fixtures or upstream clarification rather than silently inventing behavior.
