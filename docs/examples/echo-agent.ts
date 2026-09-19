import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as AcpAgent from "effect-acp/AcpAgent"
import * as Store from "effect-acp/agent/Store"

const counter = Ref.makeUnsafe(0)
const nextId = (prefix: string) => Ref.updateAndGet(counter, (n) => n + 1).pipe(
  Effect.map((n) => `${prefix}-${n}`)
)

export const agent = AcpAgent.make({
  info: { name: "echo-agent", version: "1.0.0" },
  versions: [2, 1],
  session: {
    create: () => nextId("session").pipe(Effect.map((sessionId) => ({ sessionId })))
  },
  prompt: {
    insert: () => nextId("message").pipe(Effect.map((messageId) => ({ messageId }))),
    execute: ({ emit, prompt }): Effect.Effect<AcpAgent.StopReason, AcpAgent.HandlerError> => Effect.gen(function*() {
      const messageId = yield* nextId("reply")
      const text = prompt.flatMap((block) =>
        "text" in block && typeof block.text === "string" ? [block.text] : []
      ).join(" ")
      yield* emit.agentChunk(messageId, { type: "text", text: "Echo: " })
      yield* emit.agentChunk(messageId, { type: "text", text })
    }).pipe(Effect.as("end_turn"))
  }
})

if (import.meta.main) {
  BunRuntime.runMain(Effect.scoped(AcpAgent.serveStdio(agent)).pipe(
    Effect.provide(Layer.mergeAll(Store.layer, BunServices.layer))
  ))
}
