# Proposal

## Why

The repository is currently a Bun starter with Effect 4 and no ACP implementation. A schema-backed, bidirectional protocol foundation is needed before applications can reliably consume agents or expose them through additional transports.

## What Changes

- Introduce separate pinned ACP v1 and v2 Effect wire schemas, typed errors, and method definitions; require explicit v2 enablement while it remains draft.
- Add scoped transport/connector contracts and an ACP-compatible JSON-RPC peer with bidirectional requests, notifications, batches, cancellation, and version negotiation.
- Provide in-memory and spawned-process stdio transports with bounded framing, independent stderr handling, and deterministic cleanup.
- Establish browser-safe module entry points and verification tooling for the new library.

Rich session state, WebSocket bridging, hosted recovery, and agent handler construction belong to dependent proposals. No draft Streamable HTTP profile is included.

## Capabilities

### New Capabilities

- `acp-wire-schemas`: Versioned runtime codecs, protocol definitions, extension preservation, and reproducible upstream provenance.
- `acp-protocol-peer`: Typed duplex ACP communication, negotiation, correlation, cancellation, and lifecycle failures.
- `acp-stdio-transport`: Runtime-injected scoped subprocess communication using ACP newline framing.

### Modified Capabilities

None; the project has no existing durable specifications.

## Impact

Adds `AcpSchema`, `AcpError`, `AcpProtocol`, `AcpTransport`, `AcpConnector`, `AcpConnection`, versioned schema/adapter modules, transport modules, generation tooling, and tests. Uses the installed Effect `4.0.0-rc.115`; runtime platform implementations are injected through public Effect services. Vendored ACP and Effect sources remain read-only.

This is the first implementation dependency. It unlocks [the session client](../add-acp-session-client/proposal.md), [transport bridging](../add-acp-transport-bridge/proposal.md), and eventually [agent authoring](../add-acp-agent-authoring/proposal.md). [Hosted sessions](../add-acp-hosted-sessions/proposal.md) follow the session client. Agent authoring remains lower priority than the client-facing changes. See [ARCHITECTURE.md](../../../ARCHITECTURE.md).
