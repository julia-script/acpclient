import * as Result from "effect/Result"
import type * as Schema from "effect/Schema"
import * as Json from "../../src/internal/json.ts"
/**
 * Raw scripted peer over an `Transport`: sends literal JSON text and parses
 * received frames independently of `AcpConnection`.
 */
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import type * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AcpTransportError } from "../../src/AcpError.ts"
import type { Transport } from "../../src/AcpTransport.ts"

export interface Driver {
  /** Sends a value as JSON, or a string verbatim. */
  readonly send: (message: unknown) => Effect.Effect<void, AcpTransportError | Schema.SchemaError>
  /** Next received frame, parsed. Fails if none arrives within 2s. */
  readonly next: Effect.Effect<Schema.Json, Schema.SchemaError>
  /** Resolves to `none` if no frame arrives within `ms`. */
  readonly poll: (ms?: number) => Effect.Effect<Option.Option<Schema.Json>, Schema.SchemaError>
  /** Every frame received so far, raw. */
  readonly received: ReadonlyArray<string>
  /** Completes when the other side closes the transport. */
  readonly closed: Effect.Effect<void>
}

export const driver = (transport: Transport): Effect.Effect<Driver, never, Scope.Scope> =>
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
    const take = Effect.flatMap(Queue.take(frames), Json.decode)
    return {
      received,
      closed: Deferred.await(closed),
      send: (message) => typeof message === "string" ? transport.send(message) : Json.encode(message).pipe(Effect.flatMap(transport.send)),
      next: Effect.timeoutOrElse(take, { duration: "2 seconds", orElse: () => Effect.die("no frame received within 2s") }),
      poll: (ms = 50) => Effect.timeoutOption(take, `${ms} millis`)
    }
  })

/** Asserts a frame is a plain JSON-RPC 2.0 message (or batch) with only standard members. */
export const isStandardFrame = (frame: string): boolean => {
  const decoded = Json.decodeResult(frame)
  if (Result.isFailure(decoded)) return false
  const value = decoded.success
  const entries = Array.isArray(value) ? value : [value]
  const allowed = new Set(["jsonrpc", "id", "method", "params", "result", "error"])
  return entries.length > 0 && entries.every((e) =>
    typeof e === "object" && e !== null && "jsonrpc" in e && e.jsonrpc === "2.0" && Object.keys(e).every((k) => allowed.has(k)) &&
    ("method" in e && typeof e.method === "string" ? !e.method.startsWith("@effect") : true)
  )
}
