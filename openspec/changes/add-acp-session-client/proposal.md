# Proposal

## Why

Applications need usable sessions, observable state, and user interactions rather than a collection of JSON-RPC methods. ACP v2 and v1 have different prompt and replay semantics that applications should not have to reimplement individually.

## What Changes

- Add the common `AcpClient` service, a local implementation, and session handles with Effect operations and Stream observations.
- Interpret v2 messages, tool calls, plans, display terminals, configuration, commands, usage, and permission/elicitation interactions into immutable session state.
- Add v1 compatibility with explicit capability and provenance differences, including opt-in filesystem and terminal handlers.
- Separate prompt submission, agent acceptance, session completion, observer release, and cancellation.
- Bound retained content and subscriber delivery, reporting truncation and resynchronization rather than silently losing required deltas.

This change provides direct sessions. Server retention, browser reattachment, gateway commands, and UI components are outside its scope.

## Capabilities

### New Capabilities

- `acp-session-client`: Transport-independent application session API, version-aware state, and user interaction lifecycle.

### Modified Capabilities

None. This consumes the foundation contracts without changing their requirements.

## Impact

Depends on [add-acp-protocol-foundation](../add-acp-protocol-foundation/proposal.md) being implemented before this change. Adds `AcpClient`, `AcpLocalClient`, `AcpSession`, application schemas, session reducer/runtime, and v1 client handlers. Uses Effect scopes, streams, deferred values, and observable state; no frontend framework dependency is introduced.

This defines the common service implemented remotely by [add-acp-hosted-sessions](../add-acp-hosted-sessions/proposal.md). State and runtime ownership follow [ARCHITECTURE.md](../../../ARCHITECTURE.md).
