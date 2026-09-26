import * as Json from "../src/internal/json.ts"
/**
 * WebSocket profile adapter: framing, subprotocol negotiation, binary and size
 * rejection, and terminal failure semantics. A scriptable `WebSocketLike`
 * keeps the adapter tests deterministic; the real route is exercised in
 * `bridge-http.test.ts`.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Socket from "effect/unstable/socket/Socket"
import * as WebSocket from "../src/transport/WebSocket.ts"

type Listener = (event: Socket.WebSocketEvent) => void

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
  test("carries one complete JSON text frame per message in both directions", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
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
    }))))

  test("only offers the documented profile and recognizes it in a handshake header", () => {
    expect(WebSocket.profile).toBe("effect-acp-jsonrpc-v1")
    expect(WebSocket.requested({ "sec-websocket-protocol": "chat, effect-acp-jsonrpc-v1" })).toBe(true)
    expect(WebSocket.requested({ "sec-websocket-protocol": "effect-acp-jsonrpc-v1, chat" })).toBe(true)
    expect(WebSocket.requested({ "sec-websocket-protocol": "chat, other" })).toBe(false)
    expect(WebSocket.requested({})).toBe(false)
  })

  test("a dialled connection that did not select the profile is rejected before use", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ws = scriptable("chat")
      const exit = yield* Effect.exit(
        WebSocket.make("ws://example.test/acp").pipe(
          Effect.provideService(Socket.WebSocketConstructor, () => ws)
        )
      )
      expect(Exit.isFailure(exit) && (yield* Json.encode(exit.cause))).toContain('"reason":"Open"')
      expect(ws.sent).toEqual([])
    }))))

  test("a throwing WebSocket constructor fails as an Open transport error", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const thrown = new TypeError("invalid WebSocket URL")
      const failure = yield* Effect.flip(WebSocket.make("ws://example.test/acp").pipe(
        Effect.provideService(Socket.WebSocketConstructor, () => { throw thrown })
      ))
      expect(failure).toMatchObject({ _tag: "AcpTransportError", reason: "Open" })
      expect(failure.cause).toBeDefined()
    }))))

  test("a binary frame closes with unsupported-data and fails the incoming stream", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws))
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.sleep("10 millis")
      ws.message(Uint8Array.of(1, 2, 3))
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && (yield* Json.encode(exit.cause))).toContain("InvalidFrame")
      expect(ws.closeInfo?.code).toBe(WebSocket.unsupportedDataClose)
    }))))

  test("an oversized text frame closes as too-large and fails with FrameTooLarge", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws), { maxFrameBytes: 8 })
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.sleep("10 millis")
      ws.message("0123456789")
      const exit = yield* Fiber.await(fiber)
      expect(Exit.isFailure(exit) && (yield* Json.encode(exit.cause))).toContain("FrameTooLarge")
      expect(ws.closeInfo?.code).toBe(WebSocket.tooLargeClose)
    }))))

  test("a remote close ends incoming without error and later sends fail as Closed", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const transport = yield* WebSocket.fromSocket(socketFrom(ws))
      const fiber = yield* Effect.forkChild(collect(transport.incoming))
      yield* Effect.sleep("10 millis")
      const before = ws.sent.length
      ws.remoteClose(1000, "done")
      const collected = yield* Fiber.await(fiber)
      expect(Exit.isSuccess(collected) && collected.value.length).toBe(0)
      const exit = yield* Effect.exit(transport.send("{}"))
      expect(Exit.isFailure(exit) && (yield* Json.encode(exit.cause))).toContain("Closed")
      expect(ws.sent.length).toBe(before)
    }))))

  test("scope release is terminal and a blocked send is released", () =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const ws = scriptable()
      const scope = yield* Scope.fork(yield* Scope.Scope)
      const transport = yield* Scope.provide(WebSocket.fromSocket(socketFrom(ws)), scope)
      yield* transport.send(`{"jsonrpc":"2.0","id":1}`)
      yield* Scope.close(scope, Exit.void)
      const exit = yield* Effect.exit(transport.send(`{"jsonrpc":"2.0","id":2}`))
      expect(Exit.isFailure(exit) && (yield* Json.encode(exit.cause))).toContain("Closed")
      expect(ws.sent).toEqual([`{"jsonrpc":"2.0","id":1}`])
    }))))
})

test("opening deadline closes a socket that never opens", () => Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const ws = scriptable()
  ws.readyState = 0
  const result = yield* Effect.exit(WebSocket.make("ws://example.test", { openTimeout: "10 millis" }).pipe(
    Effect.provideService(Socket.WebSocketConstructor, () => ws)))
  expect(Exit.isFailure(result)).toBe(true)
  expect(ws.closeInfo).toBeDefined()
})).pipe(Effect.timeout("1 second"))))
