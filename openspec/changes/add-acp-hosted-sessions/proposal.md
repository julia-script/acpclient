# Proposal

## Why

A browser refresh destroys its ACP runtime even if a relay keeps the agent process alive. Applications need a host-owned client that continues processing messages and restores session state, command outcomes, and pending interactions after reattachment.

## What Changes

- Add an in-memory `AcpHost` that owns agent connections and sessions independently of browser attachment scopes, with explicit bounded retention.
- Add atomic snapshot/live attachment, bounded event replay, host epochs, and controller generations.
- Add a package-owned, schema-backed Effect RPC gateway over WebSocket and a remote implementation of the same `AcpClient` API.
- Deduplicate retained mutating commands and separate host acceptance from ACP agent acceptance; preserve ambiguous outcomes after failures.
- Enforce application-provided ownership checks, restore pending interactions once, and perform bounded cleanup when retention expires.

Host-crash durability, distributed hosts, multiple simultaneous controllers, automatic prompt retries after ambiguous ACP outcomes, and a public standard ACP gateway are outside scope.

## Capabilities

### New Capabilities

- `acp-hosted-lifecycle`: Host-owned session retention, reattachment, replay, interaction ownership, and cleanup.
- `acp-hosted-gateway`: Versioned application commands/events, duplicate prevention, remote client parity, and HTTP integration.

### Modified Capabilities

None. The local client's service contract is consumed, and the new remote implementation must preserve its supported behaviors.

## Impact

Depends on [add-acp-protocol-foundation](../add-acp-protocol-foundation/proposal.md) and [add-acp-session-client](../add-acp-session-client/proposal.md). Adds `AcpHost`, gateway contracts/client/server, `AcpRemoteClient`, HTTP route integration, event journal, and submission ledger. Effect RPC handles only the application hop; ACP transport remains owned by the local client.

Does not depend on [the transparent bridge](../add-acp-transport-bridge/proposal.md). Both are deployment options described in [ARCHITECTURE.md](../../../ARCHITECTURE.md). Consumers supply authentication, principal/workspace authorization, launch profiles, and retention/resource policy.
