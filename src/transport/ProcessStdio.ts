import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
/**
 * ACP over the *current* process's standard input and output, for agents that are launched by a
 * client.
 *
 * **Details**
 *
 * This is the mirror image of `transport/Stdio`, which spawns a child: here
 * the process itself is the agent, so stdin carries incoming frames and
 * stdout carries outgoing ones. Stdout is reserved for ACP; write diagnostics
 * to stderr or a logger instead.
 *
 * The process I/O is injected through Effect's `Stdio` service (e.g. from
 * `@effect/platform-bun` or `@effect/platform-node`); importing this module
 * touches no global handles.
 */
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Queue from "effect/Queue"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import { AcpTransportError } from "../AcpError.ts"
import { AcpTransport, type Transport } from "../AcpTransport.ts"
import * as Framing from "../internal/framing.ts"

/**
 * Frame size and stdout write buffering for an agent using the current process.
 *
 * @category configuration
 */
export interface Options {
  /**
   * Largest frame accepted or sent, in bytes, excluding the delimiter. Default 16 MiB.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Frames queued for stdout before `send` suspends. Default 64.
   */
  readonly writeBuffer?: number | undefined
}

const closed = new AcpTransportError({ reason: "Closed", message: "Process stdout is closed" })

/**
 * A transport over this process's stdin/stdout, owned by the current scope.
 *
 * **Details**
 *
 * Closing the scope stops the writer and fails blocked and later writes; the
 * process handles themselves belong to the `Stdio` service.
 *
 * @category constructors
 */
export const make = Effect.fnUntraced(function*(options: Options = {}) {
  const stdio = yield* Stdio.Stdio
  const maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024

  // One writer fiber keeps frames ordered and whole, matching the child-process
  // transport. `endOnDone: false` keeps stdout open for the host process.
  const failed = yield* Deferred.make<never, AcpTransportError>()
  const writes = yield* Queue.bounded<Uint8Array, Cause.Done>(options.writeBuffer ?? 64)
  yield* Stream.fromQueue(writes).pipe(
    Stream.run(stdio.stdout({ endOnDone: false })),
    Effect.ensuring(Queue.shutdown(writes)),
    Effect.catchCause((cause) => Deferred.fail(failed, new AcpTransportError({ reason: "Write", message: "Process stdout failed", cause: Cause.squash(cause) }))),
    Effect.forkScoped
  )
  yield* Effect.addFinalizer(() => Queue.shutdown(writes))

  const incoming = Stream.suspend(() => {
    const decoder = Framing.makeDecoder(maxFrameBytes)
    return stdio.stdin.pipe(
      Stream.mapError((cause) => new AcpTransportError({ reason: "Read", message: cause.message, cause })),
      Stream.flatMap((chunk) => {
        const { error, frames } = decoder.push(chunk)
        const decoded = Stream.fromIterable(frames)
        return error ? Stream.concat(decoded, Stream.fail(error)) : decoded
      }),
      Stream.concat(Stream.suspend(() => {
        const error = decoder.end()
        return error ? Stream.fail(error) : Stream.empty
      })),
      Stream.interruptWhen(Deferred.await(failed))
    )
  })

  const transport: Transport = {
    incoming,
    send: (frame) => {
      const bytes = Framing.encode(frame, maxFrameBytes)
      if (Schema.is(AcpTransportError)(bytes)) return Effect.fail(bytes)
      return Effect.flatMap(Queue.offer(writes, bytes), (accepted) => accepted ? Effect.void : Effect.fail(closed))
    }
  }
  return transport
})

/**
 * Writes a diagnostic line to stderr, keeping stdout free of non-protocol output.
 *
 * @category running
 */
export const diagnostic = (message: string): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.flatMap(Effect.service(Stdio.Stdio), (stdio) =>
    Stream.make(`${message}\n`).pipe(
      Stream.run(stdio.stderr({ endOnDone: false })),
      Effect.ignore
    ))

/**
 * Process stdin/stdout implementation of AcpTransport.
 *
 * @category layers
 */
export const layer = (options?: Options): Layer.Layer<AcpTransport, never, Stdio.Stdio> =>
  Layer.effect(AcpTransport, make(options))
