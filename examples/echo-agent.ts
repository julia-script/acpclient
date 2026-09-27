/**
 * A deterministic ACP agent served over this process's stdio.
 *
 *   bun examples/echo-agent.ts
 *
 * No model, no credentials, no network: it echoes the prompt back, asks for
 * permission once, and can be cancelled. Run it under `examples/stdio-client.ts`
 * (pass this file as the agent command) or any ACP client.
 *
 * Note what does *not* appear below: framing, version negotiation, capability
 * advertisement, or update encoding. Diagnostics go to stderr, because stdout
 * carries only ACP frames.
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as AcpAgent from "effect-acp/AcpAgent"
import * as Store from "effect-acp/agent/Store"

let counter = 0
const nextId = (prefix: string) => `${prefix}-${++counter}`

const agent = AcpAgent.make({
  info: { name: "echo-agent", version: "0.1.0" },
  versions: [2, 1],
  list: true,
  session: {
    create: ({ cwd }) => Effect.as(Effect.logDebug(`new session in ${cwd}`), { sessionId: nextId("session") }),
    resume: () => Effect.void,
    delete: () => Effect.void,
    cancel: ({ sessionId }) => Effect.logDebug(`cancelled ${sessionId}`)
  },
  prompt: {
    // Insertion is what a v2 client's `session/prompt` response reports.
    insert: () => Effect.succeed({ messageId: nextId("msg") }),
    execute: ({ client, emit, prompt }) =>
      Effect.gen(function*() {
        const messageId = nextId("msg")
        const text = prompt.map((block) => "text" in block && typeof block.text === "string" ? block.text : "").join(" ").trim()

        // A real agent would ask before acting; this one asks before echoing.
        const choice = yield* client.requestPermission({
          title: `Echo ${text}?`,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }
          ]
        })
        if (choice !== "allow") return "refusal"

        yield* emit.thoughtChunk(nextId("thought"), { type: "text", text: "echoing" })
        // Chunks stream; a client accumulates them under `messageId`.
        for (const word of text.split(/\s+/).filter((word) => word !== "")) {
          yield* emit.agentChunk(messageId, { type: "text", text: `${word} ` })
        }
        return "end_turn"
      })
  }
})

// The author supplies storage and process I/O; the agent supplies the protocol.
if (import.meta.main) {
  BunRuntime.runMain(Effect.scoped(Effect.flatMap(agent, AcpAgent.serveStdio)).pipe(
    Effect.provide(Layer.mergeAll(Store.layer, BunServices.layer))
  ))
}
