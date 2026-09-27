/**
 * Transparent relay between two framed ACP transports.
 *
 * `AcpBridge` forwards complete frames between a browser/remote transport and
 * a peer (typically a spawned stdio agent) without interpreting them: request
 * IDs, method payloads, response errors, notifications, batches, and extension
 * data are preserved apart from transport delimiters. It never initializes on
 * behalf of an endpoint, rewrites protocol versions, or filters
 * agent-initiated requests.
 *
 * Each direction runs its own ordered pump with bounded buffering supplied by
 * the underlying transports' backpressure. When either side ends (EOF or
 * failure) the bridge stops the other pump and runs the caller's `release`
 * effect exactly once, so both owned transports close. A write that stays
 * blocked beyond `pressureDeadline` is treated as a stalled consumer: the
 * bridge fails explicitly and releases both sides instead of buffering without
 * bound or silently dropping a frame.
 *
 * The bridge is scoped. Closing the enclosing scope terminates both pumps and
 * completes `closed`; the bridge never reconnects or resends and never claims
 * session recovery after connection loss.
 *
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AcpTransportError } from "./AcpError.ts"
import type { Transport } from "./AcpTransport.ts"

/** Which side ended first, when a side is the trigger. */
export type BridgeSide = "browser" | "peer"

/** The bridge released its owned transports. Reported once through `closed`. */
export class AcpBridgeClosed extends Schema.TaggedError<AcpBridgeClosed>()("AcpBridgeClosed", {
  message: Schema.String,
  side: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}, { identifier: "effect-acp/AcpBridge/AcpBridgeClosed" }) {}

/** Default time a single write may stay blocked before the bridge fails. */
export const defaultPressureDeadline: Duration.Duration = Duration.seconds(10)

export interface Options {
  /** The remote/browser end. Its `incoming` frames are forwarded to `peer`. */
  readonly browser: Transport
  /** The spawned/owned end. Its `incoming` frames are forwarded to `browser`. */
  readonly peer: Transport
  /**
   * Closes both owned transports. Runs exactly once, uninterruptibly, when
   * either side ends or the deadline elapses. Must be idempotent.
   */
  readonly release: Effect.Effect<void>
  /** Maximum time a forward write may be blocked. Default 10 seconds. */
  readonly pressureDeadline?: Duration.Input | undefined
}

export interface AcpBridge {
  readonly browser: Transport
  readonly peer: Transport
  /** Completes with the reason the bridge closed and released its transports. */
  readonly closed: Effect.Effect<AcpBridgeClosed>
  /** Explicitly closes the bridge; the reason is reported through `closed`. */
  readonly terminate: (message?: string, side?: BridgeSide) => Effect.Effect<void>
}

const closedFromCause = (
  side: BridgeSide,
  cause: Cause.Cause<AcpBridgeClosed | AcpTransportError>
): AcpBridgeClosed => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause))
  if (error === undefined) return new AcpBridgeClosed({ message: `${side} transport failed`, side, cause })
  if (error._tag === "AcpBridgeClosed") return error
  return new AcpBridgeClosed({ message: `${side} transport: ${error.message}`, side, cause: error })
}

const forward = (
  side: BridgeSide,
  from: Transport,
  to: Transport,
  deadline: Duration.Input,
  finish: (reason: AcpBridgeClosed) => Effect.Effect<void>
): Effect.Effect<void> =>
  Stream.runForEach(from.incoming, (frame) =>
    Effect.timeoutOrElse(to.send(frame), {
      duration: deadline,
      orElse: () =>
        Effect.fail(new AcpBridgeClosed({
          message: `${side} made no progress within the pressure deadline`,
          side
        }))
    })
  ).pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) => finish(closedFromCause(side, cause)),
      onSuccess: () => finish(new AcpBridgeClosed({ message: `${side} closed the connection`, side }))
    })
  )

/** Opens a bridge over two transports owned by the caller. */
export const make = (options: Options): Effect.Effect<AcpBridge, never, Scope.Scope> =>
  Effect.gen(function*() {
    const scope = yield* Scope.Scope
    const deadline = options.pressureDeadline ?? defaultPressureDeadline
    const closed = yield* Deferred.make<AcpBridgeClosed>()
    const once = yield* Ref.make(false)

    const finish = (reason: AcpBridgeClosed): Effect.Effect<void> =>
      Ref.modify(once, (already): readonly [Effect.Effect<void>, boolean] =>
        already
          ? [Effect.void, already]
          : [Effect.andThen(Effect.exit(options.release), Deferred.succeed(closed, reason)), true]
      ).pipe(Effect.flatten, Effect.uninterruptible)

    const fiber = yield* Effect.raceFirst(
      forward("browser", options.browser, options.peer, deadline, finish),
      forward("peer", options.peer, options.browser, deadline, finish)
    ).pipe(Effect.forkIn(scope))

    const terminate = (reason: AcpBridgeClosed): Effect.Effect<void> =>
      Effect.uninterruptible(Effect.andThen(finish(reason), Fiber.interrupt(fiber)))

    yield* Scope.addFinalizer(
      scope,
      terminate(new AcpBridgeClosed({ message: "Bridge scope closed" }))
    )

    return {
      browser: options.browser,
      peer: options.peer,
      closed: Deferred.await(closed),
      terminate: (message?: string, side?: BridgeSide) =>
        terminate(new AcpBridgeClosed({ message: message ?? "Bridge closed", side }))
    }
  })
