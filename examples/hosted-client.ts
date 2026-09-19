/** Browser-safe half of the hosted example. Replace memoryStorage with durable app storage. */
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import type { AcpSession } from "effect-acp/AcpClient"
import * as GC from "effect-acp/AcpGatewayClient"
import * as Remote from "effect-acp/AcpRemoteClient"

const waitFor = (session: AcpSession, predicate: (snapshot: import("effect-acp/AcpApp").SessionSnapshot) => boolean) => Effect.scoped(Effect.gen(function*() {
  const observed = yield* session.observe
  if (predicate(observed.snapshot)) return observed.snapshot
  const head = yield* Stream.runHead(observed.changes.pipe(Stream.filter((event) => predicate(event.snapshot))))
  if (head._tag === "None") return yield* Effect.die("Session ended before expected state")
  return head.value.snapshot
}))
export const exerciseRecovery = (url: string) => Effect.gen(function*() {
  const storage = GC.memoryStorage()
  const create = Effect.gen(function*() {
    yield* Effect.log("connecting gateway")
    const gateway = yield* GC.connect(url, { workspace: "demo", storage })
    yield* Effect.log("gateway hello done")
    return yield* Remote.make(gateway, { profile: "demo" })
  })
  const descriptor = yield* Effect.scoped(Effect.gen(function*() {
    const client = yield* create
    const connection = yield* client.connect({ versions: [2], params: { info: { name: "browser", version: "1" } } })
    yield* Effect.log("opened ACP connection")
    const session = yield* connection.newSession({ cwd: "/tmp" })
    yield* Effect.log("created ACP session")
    const submission = yield* session.submit([{ type: "text", text: "stream" }])
    yield* submission.accepted
    yield* waitFor(session, (snapshot) => Object.values(snapshot.interactions).some((i) => i.status === "pending"))
    return client.descriptor(session)!
  })) // socket closes here; the host keeps the ACP session and permission alive
  yield* Effect.scoped(Effect.gen(function*() {
    const client = yield* create
    const session = yield* client.attach(descriptor)
    const snapshot = yield* session.snapshot
    const permission = Object.values(snapshot.interactions).find((i) => i.status === "pending")!
    yield* session.resolveInteraction(permission.interactionId, { _tag: "selected", optionId: "allow" })
    yield* waitFor(session, (state) => state.messages.some((m) => m.kind === "agent"))
  })) // refresh again while output is still streaming
  yield* Effect.scoped(Effect.gen(function*() {
    const client = yield* create
    const session = yield* client.attach(descriptor)
    const state = yield* waitFor(session, (state) => state.foreground.state === "idle")
    const output = state.messages.filter((m) => m.kind === "agent").flatMap((m) => m.content).map((b) => b.type === "text" && "text" in b ? b.text : "").join("")
    if (output !== Array.from({ length: 20 }, (_, n) => `${n} `).join("")) return yield* Effect.die("Lost or duplicated streaming output")
  }))
})
