/**
 * Paired in-memory transports for tests and in-process composition.
 *
 * @since 0.1.0
 */
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AcpTransportError } from "../AcpError.ts"
import type { AcpTransport } from "../AcpTransport.ts"

export interface Options {
  /** Frames buffered per direction before `send` suspends. Default 64. */
  readonly capacity?: number | undefined
}

const closed = new AcpTransportError({ reason: "Closed", message: "In-memory transport is closed" })

/**
 * Creates two connected ends. Each end is acquired in its own scope; closing
 * one ends the other's `incoming` after buffered frames and fails further
 * writes in both directions, including writers blocked on backpressure.
 */
export const make = (options?: Options): Effect.Effect<{
  readonly left: Effect.Effect<AcpTransport, never, Scope.Scope>
  readonly right: Effect.Effect<AcpTransport, never, Scope.Scope>
}> =>
  Effect.gen(function*() {
    const capacity = options?.capacity ?? 64
    const leftToRight = yield* Queue.bounded<string, Cause.Done>(capacity)
    const rightToLeft = yield* Queue.bounded<string, Cause.Done>(capacity)
    const end = (outgoing: Queue.Queue<string, Cause.Done>, incoming: Queue.Queue<string, Cause.Done>) =>
      Effect.acquireRelease(
        Effect.succeed<AcpTransport>({
          incoming: Stream.fromQueue(incoming),
          send: (frame) =>
            Effect.flatMap(Queue.offer(outgoing, frame), (accepted) => accepted ? Effect.void : Effect.fail(closed))
        }),
        () => Effect.andThen(Queue.end(outgoing), Queue.shutdown(incoming))
      )
    return { left: end(leftToRight, rightToLeft), right: end(rightToLeft, leftToRight) }
  })

/** Both ends of a pair owned by the current scope. */
export const makePair = (options?: Options): Effect.Effect<readonly [AcpTransport, AcpTransport], never, Scope.Scope> =>
  Effect.flatMap(make(options), ({ left, right }) => Effect.all([left, right]))
