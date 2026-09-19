# effect-acp

Effect-native clients and agent authoring for the [Agent Client Protocol](https://agentclientprotocol.com). Add agent sessions to an application with schema-validated messages, streaming snapshots, permission handling, and scoped resource ownership.

```sh
bun add effect-acp effect@4.0.0-rc.115
```

Examples use Effect 4.0.0-rc.115. Terminal applications also install the matching `@effect/platform-bun` or `@effect/platform-node` package. ACP v1 is the default; the v2 draft is an explicit opt-in.

[Start with a complete agent session](docs/tutorials/first-session.md), or [connect to Claude or Codex](docs/how-to/real-agents.md).

| What you need | Read |
| --- | --- |
| Streaming chat, tools, and permission controls | [Session UI guide](docs/how-to/session-ui.md) |
| Browser → server → stdio agent | [WebSocket bridge](docs/how-to/browser-bridge.md) |
| Sessions retained across browser disconnects | [Hosted sessions](docs/how-to/hosted-sessions.md) |
| Your own ACP agent | [Agent authoring](docs/how-to/write-agent.md) |
| Exact API behavior and defaults | [Client reference](docs/reference/client.md) |
| How the Effect services and lifetimes fit together | [Ownership explanation](docs/explanation/ownership.md) |

The transports are implementations of `AcpTransport`; `AcpConnector` acquires a fresh scoped instance for each connection. Applications use `AcpClient` and session handles. A bridge relays ACP for one socket lifetime; a host retains session state independently of that socket, within configured in-memory limits.

See the [documentation index](docs/README.md) for all guides and reference pages. Contributors can use the [development guide](docs/development.md), [architecture](ARCHITECTURE.md), and [type audit](TYPE_AUDIT.md).
