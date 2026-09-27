import { failure } from "./support/failure.ts"
/**
 * WebSocket profile adapter: framing, subprotocol negotiation, binary and size
 * rejection, and terminal failure semantics. A scriptable `WebSocketLike`
 * keeps the adapter tests deterministic; the real route is exercised in
 * `bridge-http.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Deferred from "effect/Deferred"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as TestClock from "effect/testing/TestClock"
import * as Socket from "effect/unstable/socket/Socket"
import * as WebSocket from "../src/transport/WebSocket.ts"

type Listener = (event: Socket.WebSocketEvent) => void
const error = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected a failure")
  return Option.getOrUndefined(Cause.findErrorOption(exit.cause))
}

interface ScriptableSocket extends Socket.WebSocketLike {
  readyState: number
  binaryType: string
  protocol: string
  sent: Array<string | Uint8Array>
  closeInfo: { code?: number | undefined; reason?: string | undefined } | undefined
  emit(this: void, type: string, event: Socket.WebSocketEvent): void
  message(data: string | Uint8Array): void
  remoteClose(code: number, reason?: string): void
}

const scriptable = (protocol: string = WebSocket.profile) => {
  const listeners = new Map<string, Set<Listener>>()
  const ws: ScriptableSocket = {
    readyState: 1,
    protocol,
    binaryType: "arraybuffer",
    sent: [],
    closeInfo: undefined,
    addEventListener(type: string, listener: Listener, options?: { readonly once?: boolean }) {
      const set = listeners.get(type) ?? new Set<Listener>()
      listeners.set(type, set)
      const wrapped: Listener = options?.once
        ? (event) => {
          set.delete(wrapped)
          listener(event)
        }
        : listener
      set.add(wrapped)
    },
    removeEventListener(type: string, listener: Listener) {
      listeners.get(type)?.delete(listener)
    },
    close(code?: number, reason?: string) {
      ws.closeInfo = { code, reason }
      ws.readyState = 3
      emit("close", { code, reason })
    },
    send(data: string | Uint8Array) {
      ws.sent.push(data)
    },
    emit(this: void, type: string, event: Socket.WebSocketEvent) {
      for (const listener of listeners.get(type) ?? []) listener(event)
    },
    message(data: string | Uint8Array) {
      ws.emit("message", { data })
    },
    remoteClose(code: number, reason?: string) {
      ws.readyState = 3
      ws.emit("close", { code, reason })
    }
  }
  const emit = ws.emit
  return ws
}

const socketFrom = (ws: ReturnType<typeof scriptable>) => Socket.fromWebSocket(Effect.succeed(ws), {})

const collect = <E>(stream: Stream.Stream<string, E>) => Stream.runCollect(stream)

describe("WebSocket profile", () => {
  it.effect("carries one complete JSON text frame per message in both directions", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws))
      yield* transport.send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}`)
      yield* transport.send(`[{"jsonrpc":"2.0","id":2,"method":"a"},{"jsonrpc":"2.0","id":3,"method":"b"}]`)
      expect(ws.sent).toEqual([
        `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":2}}`,
        `[{"jsonrpc":"2.0","id":2,"method":"a"},{"jsonrpc":"2.0","id":3,"method":"b"}]`
      ])
      ws.message(`{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}`)
      ws.message(`{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk"}}`)
      const frames = yield* Stream.runCollect(Stream.take(transport.incoming, 2))
      expect([...frames]).toEqual([
        `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":2}}`,
        `{"jsonrpc":"2.0","method":"session/update","params":{"sessionUpdate":"agent_message_chunk"}}`
      ])
    })))

  it("only offers the documented profile and recognizes it in a handshake header", () => {
    expect(WebSocket.profile).toBe("effect-acp-jsonrpc-v1")
    expect(WebSocket.requested({ "sec-websocket-protocol": "chat, effect-acp-jsonrpc-v1" })).toBe(true)
    expect(WebSocket.requested({ "sec-websocket-protocol": "effect-acp-jsonrpc-v1, chat" })).toBe(true)
    expect(WebSocket.requested({ "sec-websocket-protocol": "chat, other" })).toBe(false)
    expect(WebSocket.requested({})).toBe(false)
  })

  it.effect("a dialled connection that did not select the profile is rejected before use", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable("chat")
      const exit = yield* Effect.exit(
        WebSocket.make("ws://example.test/acp").pipe(
          Effect.provideService(Socket.WebSocketConstructor, () => ws)
        )
      )
      expect(error(exit)).toMatchObject({ _tag: "AcpTransportError", reason: "Open" })
      expect(ws.sent).toEqual([])
    })))

  it.effect("a throwing WebSocket constructor fails as an Open transport error", () =>
    Effect.scoped(Effect.gen(function*() {
      const thrown = new TypeError("invalid WebSocket URL")
      const failure = yield* Effect.flip(WebSocket.make("ws://example.test/acp").pipe(
        Effect.provideService(Socket.WebSocketConstructor, () => { throw thrown })
      ))
      expect(failure).toMatchObject({ _tag: "AcpTransportError", reason: "Open" })
      expect(failure.cause).toBeDefined()
    })))

  it.effect("a binary frame closes with unsupported-data and fails the incoming stream", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws))
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.yieldNow
      ws.message(Uint8Array.of(1, 2, 3))
      const exit = yield* Fiber.await(fiber)
      expect(error(exit)).toMatchObject({ _tag: "AcpTransportError", reason: "InvalidFrame" })
      expect(ws.closeInfo?.code).toBe(WebSocket.unsupportedDataClose)
    })))

  it.effect("an oversized text frame closes as too-large and fails with FrameTooLarge", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws), { maxFrameBytes: 8 })
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.yieldNow
      ws.message("0123456789")
      const exit = yield* Fiber.await(fiber)
      expect(error(exit)).toMatchObject({ _tag: "AcpTransportError", reason: "FrameTooLarge" })
      expect(ws.closeInfo?.code).toBe(WebSocket.tooLargeClose)
    })))

  it.effect("a remote close ends incoming without error and later sends fail as Closed", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws))
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.yieldNow
      const before = ws.sent.length
      ws.remoteClose(1000, "done")
      const collected = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(collected) && collected.value.length).toBe(0)
      expect(yield* failure(transport.send("{}"))).toMatchObject({ _tag: "AcpTransportError", reason: "Closed" })
      expect(ws.sent.length).toBe(before)
    })))

  it.effect("scope release is terminal and a blocked send is released", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const transport = yield* Scope.provide(WebSocket.fromSocket(socketFrom(ws)), scope)
      yield* transport.send(`{"jsonrpc":"2.0","id":1}`)
      yield* Scope.close(scope, Exit.void)
      expect(yield* failure(transport.send(`{"jsonrpc":"2.0","id":2}`))).toMatchObject({ _tag: "AcpTransportError", reason: "Closed" })
      expect(ws.sent).toEqual([`{"jsonrpc":"2.0","id":1}`])
    })))

  it.effect("scope release settles an incoming consumer outside the transport scope", () =>
    Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const owner = yield* Scope.fork(yield* Scope.Scope)
      const transport = yield* Scope.provide(WebSocket.fromSocket(socketFrom(ws)), owner)
      const started = yield* Deferred.make<void>()
      const consumer = yield* Effect.forkChild(collect(Stream.tap(transport.incoming, () => Deferred.succeed(started, undefined))))

      ws.message("ready")
      yield* Deferred.await(started).pipe(Effect.timeout("1 second"))
      yield* Scope.close(owner, Exit.void)
      const exit = yield* Fiber.await(consumer).pipe(
        Effect.timeout("1 second"),
        Effect.ensuring(Fiber.interrupt(consumer))
      )
      expect(error(exit)).toMatchObject({ _tag: "AcpTransportError", reason: "Closed" })
    })))
})

it.effect("opening deadline closes a socket that never opens", () => Effect.scoped(Effect.gen(function*() {
  const ws = scriptable()
  ws.readyState = 0
  const pending = yield* Effect.forkChild(Effect.exit(WebSocket.make("ws://example.test", { openTimeout: "10 millis" }).pipe(
    Effect.provideService(Socket.WebSocketConstructor, () => ws))))
  yield* Effect.yieldNow
  yield* TestClock.adjust("10 millis")
  const result = yield* Fiber.join(pending)
  expect(error(result)).toMatchObject({ _tag: "AcpTransportError", reason: "Open" })
  expect(ws.closeInfo).toBeDefined()
})).pipe(Effect.timeout("1 second")))
