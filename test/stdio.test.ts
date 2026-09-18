import * as BunServices from "@effect/platform-bun/BunServices"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Scope from "effect/Scope"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AcpConnection from "../src/AcpConnection.ts"
import * as AcpProtocol from "../src/AcpProtocol.ts"
import * as Framing from "../src/internal/framing.ts"
import * as Stdio from "../src/transport/Stdio.ts"
import { processGone, stdioCommand } from "./support/compositions.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope | BunServices.BunServices>) =>
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunServices.layer)))

const bytes = (s: string) => new TextEncoder().encode(s)
const pidfile = () => join(mkdtempSync(join(tmpdir(), "acp-stdio-")), "pid")

describe("newline framing", () => {
  test("a multibyte character and the delimiter split across reads yield one intact frame", () => {
    const decoder = Framing.makeDecoder(1024)
    const input = bytes(`{"text":"héllo 😀"}\n`)
    const frames: Array<string> = []
    for (const byte of input) frames.push(...decoder.push(Uint8Array.of(byte)).frames)
    expect(frames).toEqual([`{"text":"héllo 😀"}`])
    expect(decoder.end()).toBeUndefined()
  })

  test("multiple frames per read stay ordered and partial lines are completed later", () => {
    const decoder = Framing.makeDecoder(1024)
    expect(decoder.push(bytes(`{"a":1}\n{"b":2}\r\n\n{"c":`))).toEqual({ frames: [`{"a":1}`, `{"b":2}`] })
    expect(decoder.push(bytes(`3}\n`))).toEqual({ frames: [`{"c":3}`] })
  })

  test("an oversized partial frame fails after the complete frames before it", () => {
    const decoder = Framing.makeDecoder(10)
    const result = decoder.push(bytes(`{"a":1}\n{"b":2}\n{"long":"xxxxxxxx`))
    expect(result.frames).toEqual([`{"a":1}`, `{"b":2}`])
    expect(result.error).toMatchObject({ _tag: "AcpTransportError", reason: "FrameTooLarge" })
    const across = Framing.makeDecoder(10)
    expect(across.push(bytes("123456")).error).toBeUndefined()
    expect(across.push(bytes("78901")).error).toMatchObject({ reason: "FrameTooLarge" })
  })

  test("invalid UTF-8 and truncated input are explicit framing failures", () => {
    expect(Framing.makeDecoder(10).push(Uint8Array.of(0xff, 10)).error).toMatchObject({ reason: "InvalidFrame" })
    const truncated = Framing.makeDecoder(10)
    truncated.push(bytes(`{"a"`))
    expect(truncated.end()).toMatchObject({ reason: "InvalidFrame" })
  })

  test("encoding appends one delimiter and rejects embedded newlines and oversized frames", () => {
    expect(Framing.encode(`{"a":"é"}`, 100)).toEqual(bytes(`{"a":"é"}\n`))
    expect(Framing.encode("a\nb", 100)).toMatchObject({ reason: "InvalidFrame" })
    expect(Framing.encode("x".repeat(11), 10)).toMatchObject({ reason: "FrameTooLarge" })
  })
})

describe("spawned stdio", () => {
  test("heavy stderr neither blocks nor contaminates protocol frames; the captured tail is bounded", () =>
    run(Effect.gen(function*() {
      const transport = yield* Stdio.make(stdioCommand({ version: 1 }, pidfile()), { stderr: { maxBytes: 4096 } })
      const connection = yield* AcpConnection.make(transport, { handlers: {} })
      yield* AcpProtocol.initialize(connection, {
        params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }
      })
      const pending = yield* connection.send("_fixture/stderr", { bytes: 4 * 1024 * 1024 })
      expect(yield* pending.response).toEqual({ wrote: 4 * 1024 * 1024 })
      const tail = yield* transport.stderr
      expect(tail.length).toBeLessThanOrEqual(4096)
      expect(tail).toMatch(/^x+$/)
    })), 20_000)

  test("a crashing agent reports its exit and closes the connection", () =>
    run(Effect.gen(function*() {
      const pid = pidfile()
      const transport = yield* Stdio.make(stdioCommand({ version: 1 }, pid))
      const connection = yield* AcpConnection.make(transport, { handlers: {} })
      const pending = yield* connection.send("_fixture/slow", {})
      yield* connection.send("_fixture/crash", {})
      expect(yield* Effect.flip(pending.response)).toMatchObject({ _tag: "AcpConnectionClosed" })
      expect<number>(yield* transport.exitCode).toBe(3)
      yield* processGone(pid)
    })), 20_000)

  test("closing the scope releases writers blocked on a child that never reads, and the child", () =>
    run(Effect.gen(function*() {
      const pid = pidfile()
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const transport = yield* Scope.provide(
        Stdio.make(stdioCommand({ version: 1, mode: "no-read" }, pid), { writeBuffer: 1 }),
        scope
      )
      const frame = JSON.stringify({ jsonrpc: "2.0", method: "_fill", params: { data: "x".repeat(256 * 1024) } })
      let sent = 0
      const writer = yield* Effect.forkChild(Effect.forever(Effect.andThen(transport.send(frame), Effect.sync(() => sent++))))
      // Wait until writes stop making progress: the pipe and write buffer are full.
      let last = -1
      while (sent !== last) {
        last = sent
        yield* Effect.sleep("200 millis")
      }
      yield* Scope.close(scope, Exit.void)
      const exit = yield* Fiber.await(writer)
      expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("Closed")
      yield* processGone(pid)
    })), 20_000)

  test("a stdin write failure terminates the connection while stdout stays open", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      // A child whose stdin is gone but whose stdout never closes: only the
      // write failure can end the connection.
      const epipe = PlatformError.systemError({ _tag: "Unknown", module: "test", method: "write", description: "EPIPE" })
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          stdin: Sink.forEach(() => Effect.fail(epipe)),
          stdout: Stream.never,
          stderr: Stream.never,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
          unref: Effect.succeed(Effect.void)
        }))
      )
      const transport = yield* Stdio.make(ChildProcess.make("agent")).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
      )
      const connection = yield* AcpConnection.make(transport, { handlers: {} })
      const accepted = yield* connection.send("_fixture/slow", {})
      expect(yield* Effect.flip(accepted.response)).toMatchObject({ _tag: "AcpConnectionClosed" })
      expect((yield* connection.closed)._tag).toBe("AcpConnectionClosed")
      expect(yield* Effect.flip(transport.send("{}"))).toMatchObject({ reason: "Closed" })
    }))), 5_000)

  test("the Node platform adapter composes the same way", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const { negotiated } = yield* AcpProtocol.connect({ versions: [2, 1], params: { info: { name: "n", version: "0" }, capabilities: {} } })
        .pipe(Effect.provide(Stdio.layer(stdioCommand({ version: 2 }, pidfile())).pipe(Layer.provide(NodeServices.layer))))
      expect(negotiated.version).toBe(2)
    }))), 20_000)

  test("construction requires an injected process runtime", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(Stdio.make(stdioCommand({ version: 1 }, pidfile()))) as Effect.Effect<unknown, unknown>
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(String(Exit.isFailure(exit) && exit.cause)).toContain("ChildProcessSpawner")
  })
})
