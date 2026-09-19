# Build a session UI

Use this guide to render an `AcpSession`, handle user decisions, and stop a turn. It assumes you already have a connected session from the [tutorial](../tutorials/first-session.md), [bridge](browser-bridge.md), or [hosted client](hosted-sessions.md).

## Keep the owner alive

Keep the scope that opened the connection alive for the application's session lifetime. Fork UI observation inside that scope. For a component-based UI, run the owning Effect in your application's runtime and interrupt it when that owner is disposed. A render subscription can have a shorter lifetime than the connection. Closing a direct connection's scope releases its transport and child process.

## Render from an atomic observation

Use `session.observe` to obtain the current snapshot and all subsequent changes at one boundary. Reading `snapshot` and subscribing to `changes` separately can miss an update between the two calls.

Save this browser-safe helper as `watch-session.ts`:

<!-- example: ../examples/watch-session.ts -->
```ts
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
```

Run `watchSession(session, render)` as a child fiber while the UI is mounted. Have `render` update your framework's state from the supplied snapshot. Each change contains a full projected snapshot; replace the displayed state instead of appending the snapshot's entire transcript again.

Render `messages`, `toolCalls`, `plans`, and `terminals` according to your interface. Inspect `truncated` to show that retained history is incomplete. Use `foreground` for running/idle state and `submissions` for individual prompt status. Preserve non-text content blocks for an appropriate renderer; the text-only tutorial deliberately ignores them.

The helper reacquires an observation after `AcpSubscriptionOverflow`. It propagates other failures, so the owning application can show a disconnected or expired-session state. A UI that repeatedly overflows should reduce rendering work or increase the bounded observer capacity.

## Present pending interactions

Select entries in `snapshot.interactions` whose `status` is `pending`. Branch on `kind`:

- **Permission:** display the supplied tool-call information and option labels from the interaction's request. On a user click, pass that offered option's actual `optionId` to `choosePermission`. On dismissal, call `declinePermission`.
- **Elicitation:** render the requested form or URL flow, then call `resolveInteraction` with `_tag: "accept"` and any form `content`, `_tag: "decline"`, or `_tag: "cancel"` as appropriate. The accepted content type is `AcpApp.ElicitationContent`.

Use the interaction's `interactionId`, not the agent's tool-call ID, to resolve it. Do not manufacture an `allow` option or choose the first option automatically. An invalid option is rejected while the interaction remains available for a valid answer.

Disable a decision control while its Effect is running. If resolution fails with `AcpInteractionAlreadyResolved` or `AcpInteractionExpired`, discard that stale control and render the latest snapshot. Propagate transport, gateway, and other failures to the owning UI rather than treating every failure as a successful decision.

## Submit and stop a turn

Call `session.submit` with content blocks. It returns a `Submission` after dispatch. Keep rendering while you await `submission.outcome`; the agent may need a user decision during that wait. A second concurrent foreground prompt fails with `AcpSessionBusy`.

For v2, `submission.accepted` yields the agent's inserted message ID. For v1, it fails with `AcpCapabilityUnsupported`; use `outcome` to await completion on both versions.

For a Stop button, run `session.cancel`. Interrupting the fiber waiting on `outcome` only stops that wait. If cancellation fails with `AcpCancellationUnconfirmed`, show that the agent may still be working and continue observing. Do not immediately submit another prompt as if cancellation had succeeded.

## Dispose the right resource

Dispose an observation when its view unmounts. Use `session.release` to release local routing or detach a hosted handle. Use `close` or `delete` only for the corresponding agent operation, when advertised. For sessions that must outlive the browser's connection scope, use [hosted sessions](hosted-sessions.md).

Exact defaults and errors are in the [client reference](../reference/client.md).
