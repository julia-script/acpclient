# Design

## Context

See [proposal.md](proposal.md). The foundation supplies transport, schemas, and a duplex peer, but currently exists only as a sibling proposal. Implement it first. ACP v2 acknowledges prompt insertion separately from foreground completion and uses patch/upsert semantics; v1 retains turn-long prompt requests and optional lifecycle capabilities.

## Goals / Non-Goals

**Goals:** One application-facing service usable by direct and later hosted clients, with explicit ownership, loss reporting, and honest version compatibility.

**Non-Goals:** Binding session lifetime to a renderer, persisting history, implementing a browser gateway, or pretending v1 supplies all v2 guarantees.

## Decisions

### Service factory and scoped handles

`AcpClient` is a `Context.Service` that opens scoped agent connections and exposes supported session operations. `AcpLocalClient.layer` implements it over `AcpConnector`. Session handles reference an owning runtime and expose commands, immutable snapshots, and streams; releasing an observation handle never sends close/delete/cancel implicitly. A caller can put the owning connection in a host scope later without changing protocol code.

Alternative: a process-global singleton for each session makes independent connections and tests collide. A prompt-only stream also cannot represent background updates or restored permissions.

### Submission and foreground state are separate models

`submit` records a locally unique submission ID, registers response correlation, and dispatches the prompt from the connection/session owner scope. Its returned submission handle exposes observable dispatch/acceptance/outcome state. V2 acceptance contains the agent message ID; v1 exposes acceptance as unavailable and reports turn completion when the prompt response arrives. Interrupting a caller's observation does not silently cancel a dispatched prompt.

Foreground state is session-scoped with agent-reported or inferred provenance. Use an explicit unknown/unobserved state until evidence exists. Atomically allow one library-driven foreground submission at a time; reject an additional submission with a typed busy error instead of silently queueing it. Do not offer per-prompt completion promises based solely on v2 idle notifications. An optional exclusive prompt-and-wait helper is deferred.

### Ordered reducers and snapshot subscriptions

Use one serialized reducer per session and `SubscriptionRef` for immutable snapshots. Register event delivery before publishing the associated snapshot boundary; do not reconstruct initial state by racing a getter against a new subscription. Track messages, tool calls, plans, display terminal bytes, configuration, commands, usage, and interactions. Register session routing during new/resume so updates delivered before their RPC response are retained; keep bounded provisional routing and fail explicitly if its limit is exceeded.

V2 reducers preserve omitted/null/value distinctions, replace full-content updates, append chunks in order, and decode terminal chunk bytes independently. V1 uses its own reducer adapter and local IDs where agent IDs are absent. Preserve versioned raw updates and extension payloads alongside interpreted data; unknown supported fallback variants are observable without corrupting known state.

Bound event subscribers and retained content separately. Overflow ends an incremental subscription with a resynchronization error; consumers can acquire a new snapshot/stream boundary. Content eviction adds truncation metadata. Slow observers never backpressure the protocol reader indefinitely. Use explicit resource-limit configuration with documented finite defaults established in implementation tests.

### Capabilities and interactions

Normalize capability queries while exposing the negotiated source data. Operations check supported methods/content before dispatch. Provide authentication operations and descriptors without inventing UI login flows; advertised terminal authentication requires an installed callback capable of reproducing the agent invocation. Provide v1 modes and execution handlers as explicit compatibility surfaces. Validate outbound MCP configuration using the negotiated version.

Permission and elicitation requests become schema-backed pending interactions keyed by local IDs and resolved through atomic one-shot operations. Their handler fibers wait on deferred results outside the connection reader. A configured deadline, incoming request cancellation, or session cancellation settles the pending interaction using its versioned protocol outcome. Preserve late update handling until cancellation confirmation; a deadline produces an explicit unconfirmed cancellation result rather than a false success.

Alternative: exposing arbitrary deferred values or callbacks directly in snapshots would prevent later gateway serialization. Keep snapshots as data and response functions on handles.

## Risks / Trade-offs

- Optional v1 message IDs make replay matching incomplete -> expose local identity provenance and replace/rebuild replay views rather than matching by text.
- Agent updates can precede RPC responses -> install routing and correlation before dispatch and test both arrival orders.
- Snapshot size can grow without event traffic -> enforce content limits independently of event queues and retain truncation markers.
- Multiple capabilities imply substantial surface area -> organize fixture coverage by update and operation family, with explicit unsupported-operation cases.

## Migration Plan

Apply after the foundation and add only new public contracts/runtime modules. Demonstrate a CLI session using injected process layers and a shared contract test suite that the future remote client can reuse. No persisted state migration is required. Downstream hosted work must consume the reviewed service contract rather than fork the reducer.
