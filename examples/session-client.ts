import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as Option from "effect/Option"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as V1 from "effect-acp/protocol/v1"
import * as Schema from "effect/Schema"
import * as V2 from "effect-acp/protocol/v2"
/**
 * Drive an agent through the session client instead of raw JSON-RPC.
 *
 *   bun examples/session-client.ts [agent command...]
 *
 * Compare this with `stdio-client.ts`, which does the same work over
 * `AcpConnection`. There, the application branches on the negotiated version
 * for every call, tracks its own transcript from update notifications, and
 * answers permission requests inline on the connection reader. Here the
 * session client does all of that: one code path, an immutable snapshot, and
 * interactions that are data you resolve when you are ready.
 *
 * What the example demonstrates, and what is worth copying:
 *
 * - **Ownership.** The connection and every session under it belong to the
 *   scope opened here. Releasing the observation below does not close,
 *   delete, or cancel anything; only the matching command does.
 * - **Honest versions.** `submission.accepted` resolves with the agent's
 *   message id on v2 and fails with a capability error on v1, which has no
 *   insertion acknowledgement. Waiting for the end of the turn is
 *   `submission.outcome` on both.
 * - **Interactions.** A permission request becomes a pending entry in the
 *   snapshot. Answering it is a command on the handle, so a real UI can
 *   render it, take its time, and resolve it from anywhere — meanwhile other
 *   updates keep arriving.
 * - **Draft opt-in.** v2 is a draft, so `versions: [2, 1]` opts into it while
 *   still accepting a v1 agent.
 *
 * v1 limitations this example makes visible: no prompt acceptance, no
 * agent-reported session state (a running v1 session is marked `inferred`),
 * and replayed messages without agent ids carry `local` provenance and are
 * never matched against submissions by their content.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { AcpClient, AcpLocalClient, Stdio } from "effect-acp"

// The application supplies the process runtime; the library imports none.
const agentLayer = (command: ChildProcess.Command) => AcpLocalClient.layer.pipe(
  Layer.provide(
    AcpConnector.layer(Stdio.layer(command, {
      maxFrameBytes: 8 * 1024 * 1024,
      stderr: { maxBytes: 16 * 1024 }
    }))
  ),
  Layer.provide(NodeServices.layer)
)

const program = Effect.gen(function*() {
  const client = yield* AcpClient.AcpClient
  const connection = yield* client.connect({
    versions: [2, 1], // v2 is a draft: opt in explicitly
    params: { info: { name: "session-example", version: "0.1.0" }, capabilities: {} },
    timeout: "10 seconds"
    // Opt-in v1 filesystem/terminal handlers would go here as `v1Handlers`.
    // Nothing is advertised to a v1 agent that is not installed.
  })

  const version = connection.capabilities.version
  yield* Effect.log(`negotiated ACP v${version}`)

  const session = yield* connection.newSession({ cwd: process.cwd() })

  // Take the snapshot and the change stream together: acquiring them
  // separately could drop an update applied between the two calls.
  const observed = yield* session.observe
  yield* Effect.forkChild(
    observed.changes.pipe(
      Stream.runForEach(({ snapshot }) =>
        Effect.gen(function*() {
          // Answer any permission request as soon as it appears. A real UI
          // would render these and resolve them on a click instead.
          for (const interaction of Object.values(snapshot.interactions)) {
            if (interaction.status !== "pending" || interaction.kind !== "permission") continue
            const request = interaction.version === 1
              ? yield* Schema.decodeUnknownEffect(V1.RequestPermissionRequest)(interaction.request)
              : yield* Schema.decodeUnknownEffect(V2.RequestPermissionRequest)(interaction.request)
            const options = request.options
            const choice = options[0]?.optionId
            if (choice === undefined) continue
            yield* Effect.log(`allowing: ${interaction.interactionId}`)
            // Exactly one resolution is accepted; a duplicate is rejected.
            yield* Effect.ignore(session.resolveInteraction(interaction.interactionId, {
              _tag: "selected",
              optionId: choice
            }))
          }
        })
      ),
      // The observer is bounded: if this consumer fell far enough behind it
      // would fail here rather than stall the protocol reader.
      Effect.catchTag("AcpSubscriptionOverflow", (error) => Effect.log(`observer must resync: ${error.message}`))
    )
  )

  const submission = yield* session.submit([{ type: "text", text: "Hello" }])

  if (version === 2) {
    // v2 acknowledges insertion separately from finishing the turn.
    yield* Effect.log(`prompt accepted as ${yield* submission.accepted}`)
  } else {
    yield* Effect.log("prompt dispatched (v1 has no acceptance to report)")
  }

  // On v2 this waits for the idle state update; on v1, for the prompt
  // response. Interrupting this wait would not cancel the prompt.
  yield* submission.outcome
  const snapshot = yield* session.snapshot
  yield* Effect.log("turn ended", snapshot.foreground)

  const transcript = snapshot.messages
    .map((message) =>
      `${message.kind}(${message.provenance._tag}): ${
        message.content.map((block) => "text" in block ? block.text : block.type).join("")
      }`
    )
  yield* Effect.log(`transcript:\n  ${transcript.join("\n  ")}`)
})

// Closing the scope releases the session runtimes and terminates the agent.
export const cli = Command.make("session-client", {
  bin: Argument.String("bin").pipe(Argument.optional),
  args: Argument.String("agent-args").pipe(
    Argument.variadic(),
    Argument.withDescription("Agent-specific arguments; put flags after --")
  )
}, ({ bin, args }) => {
  const command = Option.isSome(bin)
    ? ChildProcess.make(bin.value, args)
    : ChildProcess.make("bun", [new URL("../test/fixtures/agent.ts", import.meta.url).pathname, "2"])
  return Effect.scoped(program).pipe(Effect.provide(agentLayer(command)))
})

if (import.meta.main) {
  NodeRuntime.runMain(Command.run(cli, { version: "1.0.0" }).pipe(Effect.provide(NodeServices.layer)))
}
