import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Agent from "../../src/AcpAgent.ts"
import * as Store from "../../src/agent/Store.ts"
let id = 0
const next = () => String(++id)
const agent = Agent.make({
  info: { name: "hosted-fixture", version: "1" }, versions: [2, 1], list: true,
  session: { create: () => Effect.sync(() => ({ sessionId: next() })), close: () => Effect.void, resume: () => Effect.void },
  prompt: {
    insert: () => Effect.sync(() => ({ messageId: next() })),
    execute: ({ emit, client }) => Effect.gen(function*() {
      const selected = yield* client.requestPermission({ title: "Continue streaming?", options: [{ optionId: "allow", kind: "allow_once", name: "Allow" }] })
      if (selected !== "allow") return "refusal"
      const messageId = next()
      for (let n = 0; n < 20; n++) {
        yield* emit.agentChunk(messageId, { type: "text", text: `${n} ` })
        yield* Effect.sleep("10 millis")
      }
      return "end_turn"
    })
  }
})
if (import.meta.main) {
  Effect.runFork(Effect.scoped(Effect.flatMap(agent, Agent.serveStdio)).pipe(Effect.provide(Layer.mergeAll(Store.layer, BunServices.layer))))
}
