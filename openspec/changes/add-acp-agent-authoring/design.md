# Design

## Context

See [proposal.md](proposal.md). The reusable foundation provides versioned codecs, request routing, and transport contracts. Agent-side stdio differs from the client's spawned-process transport: an agent serves the current process's stdin/stdout. Effect exposes a public `Stdio` service, also used by its MCP server composition.

## Goals / Non-Goals

**Goals:** Let authors implement typed Effect handlers while the library enforces wire/lifecycle rules and shares the same codecs as client connections.

**Non-Goals:** A model loop, bundled tools, persistent database, hosted deployment, or dependency on the high-level client runtime.

## Decisions

### Declarative handlers with validated capabilities

`AcpAgent` constructs an agent from version policy, implementation metadata, handler groups, and injectable storage/execution services. Use ordinary Effect environments for application dependencies. Validate required handler groups before serving: a v2 session capability requires its complete baseline; nonempty authentication methods require login/logout. Optional capabilities require their corresponding handlers and supported content codecs. Advertise only the surfaces available in each negotiated version.

Alternative: accepting a capability JSON blob independently of handlers lets agents advertise behavior they cannot provide. Inferring all capabilities automatically is also insufficient because supported content and workspace policy require explicit author input. Validate both together.

### Explicit insertion and processing phases

Prompt handling separates inserting a user message from executing foreground work. The author supplies an insertion operation returning the canonical message identity and accepted content; only its successful completion permits a v2 acknowledgement. A separate scoped execution operation reports updates and terminal foreground state. V1 adapts the same execution to its turn-long response. Do not acknowledge merely because work was queued, and do not terminate processing when the v2 request fiber finishes.

Use per-session owned execution scopes, serialized update emission, and typed lifecycle helpers. Retained history belongs to the injected store; v2 replay uses agent-owned IDs and replacement/reset semantics. A supplied in-memory example store is illustrative and advertises only guarantees it implements. The library cannot assert retention for an arbitrary store.

### Bidirectional client calls and cancellation

Expose typed permission and elicitation helpers over the shared duplex peer. Validate the negotiated client capability before optional calls. Track request lifetimes separately from session work. Session cancellation interrupts owned execution, drains final updates, resolves outstanding interaction waits, and emits the negotiated completion signal. Generic request cancellation must not silently substitute for session cancellation after v2 acceptance.

### Agent stdio and examples

Add a current-process `Stdio` adapter with the foundation's newline framing. Reserve stdout for protocol frames and direct diagnostics to stderr. Provide `AcpAgent.layerStdio` plus lower-level serving over any supplied transport. A deterministic example agent inserts a message, emits output, requests permission, and supports cancellation/resume without a real model or credentials.

Alternative: reusing the spawned-process connector inside an agent would spawn another process and reverse ownership. Keep transport endpoint construction distinct while reusing framing and peer logic.

## Risks / Trade-offs

- Author handlers can violate insertion/retention semantics -> separate phases, validate outputs, and provide conformance fixtures; document obligations the runtime cannot infer.
- V1/v2 completion differs -> explicit adapters and independent client transcripts, not a shared unversioned prompt response type.
- Handler defects can leak details -> map defects to safe protocol errors and emit detailed causes only through configured local telemetry.

## Migration Plan

Implement after the higher-priority client-facing work, consuming the established foundation. Add a separate public entry point so client consumers do not load server helpers. Verify the example over stdio with the local client and an independent protocol driver. No model credentials, network deployment, or durable-store migration is required.
