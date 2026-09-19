# Write an ACP agent

Use `AcpAgent` when you want an ACP client to drive your agent. This guide assumes you can already implement the agent's model/tool loop with Effect. The library supplies protocol dispatch, version-aware output, and session execution ownership; you supply that loop.

## Start with a working stdio agent

Use [the tutorial's echo agent](../examples/echo-agent.ts) as `echo-agent.ts`. Install `effect-acp`, `effect@4.0.0-rc.115`, and `@effect/platform-bun@4.0.0-rc.115`. Run it through the tutorial client or configure an ACP client to launch `bun echo-agent.ts`.

Keep stdout reserved for ACP frames. `AcpAgent.serveStdio` provides the stdio transport and routes Effect logging to stderr. Use Effect logging or `ProcessStdio.diagnostic` for diagnostics; `console.log` or direct stdout output would corrupt the protocol.

## Supply the three core handlers

Implement `session.create`, `prompt.insert`, and `prompt.execute`:

1. `session.create` validates the requested workspace and returns a session ID unique within your agent's storage domain. The framework records the session through `Store`.
2. `prompt.insert` records the user message in your conversation model and returns its canonical message ID. On v2, this is the acknowledgement sent to the client. Do not return an ID for work you have only queued for later insertion.
3. `prompt.execute` runs the turn, emits output, and returns a stop reason. Keep each streamed message's ID stable across its chunks. The framework emits the version-appropriate foreground completion after execution ends.

Replace the echo implementation inside `execute` with your model service. Obtain that service with `yield*` and provide its layer at the serving boundary alongside `Store.layer` and the platform layer. Handler environment requirements flow through `serve`; you do not need to capture a runtime or cast an effect to remove dependencies.

For text streaming, call `emit.agentChunk(messageId, block)` for each chunk. On v1 the wire representation omits the message ID; on v2 it preserves it. Use `emit.message` only when a v2 full replacement is intended. For other update kinds, construct a value validated by the negotiated version's schemas before passing it to `emit.raw`.

## Ask before running a protected tool

Call `client.requestPermission` from the execution handler with the tool-call information and the options your agent supports. It yields the selected option ID, or `null` when cancelled. Branch on that result before performing the action. Continue serving the connection while waiting; the helper's request does not block other incoming protocol traffic.

For v2 structured questions, use `client.elicit` with a mode the client advertises. Unsupported modes fail before a request is sent. Keep interaction state in the execution flow rather than auto-approving when no user is present.

## Preserve cancellation and failure behavior

Put tool resources in scopes and attach finalizers where they are acquired. Session cancellation interrupts the owned execution and lets finalizers finish before reporting completion. Avoid converting interruption into success or retrying it as a failed model request.

Map expected domain failures to `AcpAgentError`; the `unknownSession` and `authRequired` helpers cover common protocol conditions. Construction errors are separate: `AcpAgent.make` throws `AcpAgentConfigError` for an inconsistent handler/capability configuration. A turn execution failure is logged generically and completed as a refusal; defects in request handling become an internal-error response without their internal cause.

## Add persistence and capabilities deliberately

`Store.layer` is an in-memory implementation. A session that outlives your process needs an application store plus explicit resume/list/replay behavior. Supplying a durable store alone does not prove every update is durable: emitted output currently ignores failures from its best-effort retention write. Account for this in your persistence design.

Install optional handlers only when your agent implements their behavior. Keep advertised authentication and session capabilities consistent with the handlers; `make` validates the configuration before serving. The [agent reference](../reference/agent.md) lists these surfaces and their version constraints.
