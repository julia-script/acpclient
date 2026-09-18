# Proposal

## Why

Browsers and desktop renderers cannot open an agent's stdio directly. Applications need an easily mounted, bidirectional bridge that preserves ACP while moving between WebSocket and subprocess transports.

## What Changes

- Define a documented custom ACP WebSocket profile and a browser-safe client transport.
- Add a scoped bridge that forwards complete ACP frames without rewriting method payloads or converting protocol versions.
- Expose an Effect HTTP route layer that authorizes upgrades and resolves host-controlled agent launch configuration before opening the subprocess.
- Provide connection-scoped cleanup, finite buffering, and explicit closure/error behavior.

This is a transparent ACP relay. Persistent sessions and refresh recovery belong to the separate host/gateway change. The profile does not claim compliance with the draft Streamable HTTP/WebSocket RFD.

## Capabilities

### New Capabilities

- `acp-transport-bridge`: Custom ACP WebSocket connectivity and transparent transport relay with composable HTTP mounting.

### Modified Capabilities

None. The foundation transport contract is reused unchanged.

## Impact

Depends on [add-acp-protocol-foundation](../add-acp-protocol-foundation/proposal.md). Adds `transport/WebSocket`, `AcpBridge`, `server/BridgeHttp`, and a bridge usage example. Uses Effect `Socket`, `HttpRouter`, request upgrades, and injected process services; Node/Bun server layers remain application choices.

The bridge is independently useful and does not require the high-level session client. The hosted gateway can be implemented independently of this custom ACP profile because its wire protocol is different. See [ARCHITECTURE.md](../../../ARCHITECTURE.md).
