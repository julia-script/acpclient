import * as Layer from "effect/Layer"
/**
 * Paired in-memory transports for tests and in-process composition.
 */
import type * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import { AcpTransportError } from "../AcpError.ts"
import { AcpTransport, type Transport } from "../AcpTransport.ts"

/**
 * Per-direction frame capacity for a paired in-memory transport.
 *
 * @category configuration
 */
export interface Options {
  /**
   * Frames buffered per direction before `send` suspends. Default 64.
   */
  readonly capacity?: number | undefined
}

const closed = new AcpTransportError({ reason: "Closed", message: "In-memory transport is closed" })

/**
 * Creates two connected ends. Each end is acquired in its own scope; closing one ends the other's
 * `incoming` after buffered frames and fails further writes in both directions, including writers
 * blocked on backpressure.
 *
 * @category constructors
 */
export const make = (options?: Options): Effect.Effect<{
  readonly left: Effect.Effect<Transport, never, Scope.Scope>
  readonly right: Effect.Effect<Transport, never, Scope.Scope>
}> =>
  Effect.gen(function*() {
    const capacity = options?.capacity ?? 64
    const leftToRight = yield* Queue.bounded<string, Cause.Done>(capacity)
    const rightToLeft = yield* Queue.bounded<string, Cause.Done>(capacity)
    const end = (outgoing: Queue.Queue<string, Cause.Done>, incoming: Queue.Queue<string, Cause.Done>) =>
      Effect.acquireRelease(
        Effect.succeed<Transport>({
          incoming: Stream.fromQueue(incoming),
          send: (frame) =>
            Effect.flatMap(Queue.offer(outgoing, frame), (accepted) => accepted ? Effect.void : Effect.fail(closed))
        }),
        () => Effect.andThen(Queue.end(outgoing), Queue.shutdown(incoming))
      )
    return { left: end(leftToRight, rightToLeft), right: end(rightToLeft, leftToRight) }
  })

/**
 * Both ends of a pair owned by the current scope.
 *
 * @category constructors
 */
export const makePair = (options?: Options): Effect.Effect<readonly [Transport, Transport], never, Scope.Scope> =>
  Effect.flatMap(make(options), ({ left, right }) => Effect.all([left, right]))

/**
 * Acquires one endpoint from a pair as the same service used by live adapters.
 *
 * @category layers
 */
export const layer = (endpoint: Effect.Effect<Transport, never, Scope.Scope>): Layer.Layer<AcpTransport> =>
  Layer.effect(AcpTransport, endpoint)
