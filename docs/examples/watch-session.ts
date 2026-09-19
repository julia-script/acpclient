import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Stream from "effect/Stream"
import type { SessionSnapshot } from "effect-acp/AcpApp"
import type { AcpSession } from "effect-acp/AcpClient"

export const watchSession = <R>(
  session: AcpSession,
  render: (snapshot: SessionSnapshot) => Effect.Effect<void, never, R>
) => Effect.gen(function*() {
  while (true) {
    const result = yield* Effect.scoped(Effect.gen(function*() {
      const observed = yield* session.observe
      yield* render(observed.snapshot)
      yield* observed.changes.pipe(Stream.runForEach(({ snapshot }) => render(snapshot)))
    })).pipe(Effect.result)
    if (Result.isSuccess(result)) return
    if (result.failure._tag !== "AcpSubscriptionOverflow") return yield* result.failure
    // Reacquire both the snapshot and its following stream after falling behind.
  }
})

export const choosePermission = (session: AcpSession, interactionId: string, optionId: string) =>
  session.resolveInteraction(interactionId, { _tag: "selected", optionId })

export const declinePermission = (session: AcpSession, interactionId: string) =>
  session.resolveInteraction(interactionId, { _tag: "cancelled" })
