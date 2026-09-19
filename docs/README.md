# effect-acp documentation

Build agent sessions into a TypeScript application using Effect services, schemas, streams, and scopes. Connect to an ACP agent directly, reach a server-side agent from a browser, or let a host retain sessions while clients disconnect. ACP connects an application to an agent; MCP servers are tools the agent may use within those sessions.

These docs assume TypeScript and basic Effect: `Effect.gen`, services, layers, and scopes. Examples import the published `effect-acp` package and use Effect **4.0.0-rc.115**. They are not Effect 3 examples. The terminal examples use Bun; the browser modules use web APIs and injected services.

## Start here

[Run your first agent session](tutorials/first-session.md) guides you through a complete exchange with a small local agent. It needs no provider account or API key. If you're evaluating the library's deployment model, read [Connections, sessions, and ownership](explanation/ownership.md).

## Build an application

| Goal | Guide |
| --- | --- |
| Connect to Claude or Codex | [Use real ACP agents](how-to/real-agents.md) |
| Render streaming sessions and answer permissions | [Build a session UI](how-to/session-ui.md) |
| Reach a stdio agent from a browser | [Add a WebSocket bridge](how-to/browser-bridge.md) |
| Keep work across disconnects and page refreshes | [Retain sessions on a host](how-to/hosted-sessions.md) |
| Expose your own agent over ACP | [Write an ACP agent](how-to/write-agent.md) |

## Look up behavior

The [client reference](reference/client.md) covers connection and session handles, version differences, limits, and failures. The [transport reference](reference/transports.md) lists implementations of the transport service and the HTTP bridge contract. The [hosting reference](reference/hosting.md) describes retention, storage, and retry policy. The [protocol reference](reference/protocol.md) covers schema-backed method calls and protocol compatibility. The [agent reference](reference/agent.md) covers authoring handlers and serving them.

## Contribute

The [development guide](development.md) describes repository checks. [ARCHITECTURE.md](../ARCHITECTURE.md) records the broader design; these user docs describe the available APIs and their current guarantees.
