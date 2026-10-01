import * as Schema from "effect/Schema"
/**
 * ACP over a spawned process's standard input and output.
 *
 * Messages are UTF-8 JSON frames delimited by `\n`. Stdout carries only ACP;
 * stderr is drained independently into a bounded tail. The process runtime is
 * injected through `ChildProcessSpawner` (e.g. from `@effect/platform-node` or
 * `@effect/platform-bun`); importing this module starts nothing.
 *
 */
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import type * as PlatformError from "effect/PlatformError"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner, type ExitCode } from "effect/process/ChildProcessSpawner"
import { AcpTransportError } from "../AcpError.ts"
import { AcpTransport, type Transport } from "../AcpTransport.ts"
import * as Framing from "../internal/framing.ts"

export interface Options {
  /** Largest frame accepted or sent, in bytes, excluding the delimiter. Default 16 MiB. */
  readonly maxFrameBytes?: number | undefined
  /** Frames queued for stdin before `send` suspends. Default 64. */
  readonly writeBuffer?: number | undefined
  readonly stderr?: {
    /** Bytes of stderr retained as the diagnostic tail. Default 64 KiB. */
    readonly maxBytes?: number | undefined
    /** Observes each stderr chunk; must not block for long. */
    readonly onChunk?: ((chunk: Uint8Array) => Effect.Effect<void>) | undefined
  } | undefined
}

export interface StdioTransport extends Transport {
  readonly pid: number
  /** Completes when the process exits. */
  readonly exitCode: Effect.Effect<ExitCode, PlatformError.PlatformError>
  /** The retained stderr tail, decoded leniently. */
  readonly stderr: Effect.Effect<string>
}

const closed = new AcpTransportError({ reason: "Closed", message: "Process stdin is closed" })

/**
 * Spawns `command` in the current scope. Closing the scope fails blocked and
 * later writes, stops the readers, and terminates the process.
 */
export const make = Effect.fnUntraced(function*(command: ChildProcess.Command, options: Options = {}) {
  const scope = yield* Scope.Scope
  const maxFrameBytes = options.maxFrameBytes ?? 16 * 1024 * 1024
  const spawner = yield* ChildProcessSpawner
  const handle = yield* spawner.spawn(command).pipe(
    Effect.mapError((cause) => new AcpTransportError({ reason: "Open", message: cause.message, cause }))
  )

  // A single writer fiber keeps frames ordered and whole. It is not
  // interrupted on scope close: interrupting the stdin sink mid-write detaches
  // its error listener, and killing the child then raises an uncaught EPIPE.
  // It ends when the queue is shut down or the child's stdin fails; a failure
  // before the owner closes the transport is terminal for `incoming` too.
  let closing = false
  const writerFailed = yield* Deferred.make<never, AcpTransportError>()
  const writes = yield* Queue.bounded<Uint8Array, Cause.Done>(options.writeBuffer ?? 64)
  yield* Stream.fromQueue(writes).pipe(
    Stream.run(handle.stdin),
    Effect.exit,
    Effect.flatMap((exit) =>
      Effect.andThen(
        Queue.shutdown(writes),
        closing ? Effect.void : Deferred.fail(
          writerFailed,
          new AcpTransportError({
            reason: "Write",
            message: "Process stdin failed",
            cause: Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
          })
        )
      )
    ),
    Effect.forkDetach
  )

  const maxStderr = options.stderr?.maxBytes ?? 64 * 1024
  const onChunk = options.stderr?.onChunk
  const tail: Array<Uint8Array> = []
  let tailBytes = 0
  yield* handle.stderr.pipe(
    Stream.runForEach((chunk) => {
      tail.push(chunk.slice())
      tailBytes += chunk.length
      while (tailBytes > maxStderr) {
        const excess = tailBytes - maxStderr
        const first = tail[0]!
        if (first.length <= excess) {
          tail.shift()
          tailBytes -= first.length
        } else {
          tail[0] = first.subarray(excess)
          tailBytes -= excess
        }
      }
      return onChunk ? onChunk(chunk) : Effect.void
    }),
    Effect.ignore,
    Effect.forkScoped
  )

  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => {
      closing = true
      return Queue.shutdown(writes)
    })
  )

  const incoming = Stream.suspend(() => {
    const decoder = Framing.makeDecoder(maxFrameBytes)
    return handle.stdout.pipe(
      Stream.mapError((cause) => new AcpTransportError({ reason: "Read", message: cause.message, cause })),
      Stream.flatMap((chunk) => {
        const { frames, error } = decoder.push(chunk)
        const decoded = Stream.fromIterable(frames)
        return error ? Stream.concat(decoded, Stream.fail(error)) : decoded
      }),
      Stream.concat(Stream.suspend(() => {
        const error = decoder.end()
        return error ? Stream.fail(error) : Stream.empty
      })),
      Stream.interruptWhen(Deferred.await(writerFailed))
    )
  })

  const transport: StdioTransport = {
    pid: handle.pid,
    exitCode: handle.exitCode,
    stderr: Effect.sync(() => {
      const bytes = new Uint8Array(tailBytes)
      let offset = 0
      for (const part of tail) {
        bytes.set(part, offset)
        offset += part.length
      }
      return new TextDecoder().decode(bytes)
    }),
    incoming,
    send: (frame) => {
      const bytes = Framing.encode(frame, maxFrameBytes)
      if (Schema.is(AcpTransportError)(bytes)) return Effect.fail(bytes)
      return Effect.flatMap(Queue.offer(writes, bytes), (accepted) => accepted ? Effect.void : Effect.fail(closed))
    }
  }
  return transport
})

/** A scoped subprocess implementation of AcpTransport. */
export const layer = (
  command: ChildProcess.Command,
  options?: Options
): Layer.Layer<AcpTransport, AcpTransportError, ChildProcessSpawner> =>
  Layer.effect(AcpTransport, make(command, options))
