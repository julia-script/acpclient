/**
 * Raw scripted peer over an `AcpTransport`: sends literal JSON text and parses
 * received frames independently of `AcpConnection`.
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AcpTransport } from "../../src/AcpTransport.ts"

export interface Driver {
  /** Sends a value as JSON, or a string verbatim. */
  readonly send: (message: unknown) => Effect.Effect<void, unknown>
  /** Next received frame, parsed. Fails if none arrives within 2s. */
  readonly next: Effect.Effect<any, unknown>
  /** Resolves to `none` if no frame arrives within `ms`. */
  readonly poll: (ms?: number) => Effect.Effect<Option.Option<any>, unknown>
  /** Every frame received so far, raw. */
  readonly received: ReadonlyArray<string>
  /** Completes when the other side closes the transport. */
  readonly closed: Effect.Effect<void>
}

export const driver = (transport: AcpTransport): Effect.Effect<Driver, never, Scope.Scope> =>
  Effect.gen(function*() {
    const received: Array<string> = []
    const frames = yield* Queue.unbounded<string>()
    const closed = yield* Deferred.make<void>()
    yield* transport.incoming.pipe(
      Stream.runForEach((frame) => Effect.andThen(Effect.sync(() => received.push(frame)), Queue.offer(frames, frame))),
      Effect.ignore,
      Effect.andThen(Deferred.succeed(closed, undefined)),
      Effect.forkScoped
    )
    const take = Effect.map(Queue.take(frames), (frame) => JSON.parse(frame))
    return {
      received,
      closed: Deferred.await(closed),
      send: (message) => transport.send(typeof message === "string" ? message : JSON.stringify(message)),
      next: Effect.timeoutOrElse(take, { duration: "2 seconds", orElse: () => Effect.die("no frame received within 2s") }),
      poll: (ms = 50) => Effect.timeoutOption(take, `${ms} millis`)
    }
  })

/** Asserts a frame is a plain JSON-RPC 2.0 message (or batch) with only standard members. */
export const isStandardFrame = (frame: string): boolean => {
  const value = JSON.parse(frame)
  const entries = Array.isArray(value) ? value : [value]
  const allowed = new Set(["jsonrpc", "id", "method", "params", "result", "error"])
  return entries.length > 0 && entries.every((e) =>
    typeof e === "object" && e !== null && e.jsonrpc === "2.0" && Object.keys(e).every((k) => allowed.has(k)) &&
    (typeof e.method === "string" ? !e.method.startsWith("@effect") : true)
  )
}
