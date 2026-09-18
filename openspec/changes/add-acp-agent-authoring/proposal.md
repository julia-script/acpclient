# Proposal

## Why

After applications can consume ACP agents, the same protocol foundation can reduce the work of creating agents with Effect. Agent authors need typed handlers, capability validation, lifecycle helpers, and client interactions without being tied to a model provider.

## What Changes

- Add `AcpAgent` construction from Effect handlers and injectable session storage/execution services.
- Validate advertised capabilities against installed handlers for the negotiated v1/v2 surfaces.
- Supply version-aware prompt acceptance/completion, session updates, cancellation, permissions, and elicitation helpers.
- Add an agent-side stdio serving layer using Effect's current-process stdio abstraction and a minimal deterministic example agent.

This is lower priority than the client, bridge, and hosted-session work. It does not introduce a reasoning loop, model provider integration, built-in durable storage, or agent deployment infrastructure.

## Capabilities

### New Capabilities

- `acp-agent-authoring`: Effect handler-based agent construction and v1/v2 protocol lifecycle serving.

### Modified Capabilities

None. Shared wire schemas and peer behavior remain owned by the foundation.

## Impact

Technical dependency: [add-acp-protocol-foundation](../add-acp-protocol-foundation/proposal.md). Delivery priority: after the client-facing changes; use [add-acp-session-client](../add-acp-session-client/proposal.md) for end-to-end compatibility checks when available. The authoring API itself must not depend on hosted sessions or a frontend.

Adds `AcpAgent`, handler/lifecycle helpers, an agent-side stdio adapter, fixtures, and documentation. Consumes public Effect services and the shared ACP peer. See [ARCHITECTURE.md](../../../ARCHITECTURE.md).
