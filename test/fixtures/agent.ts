import * as Schema from "effect/Schema"
import * as Effect from "effect/Effect"
import * as Deferred from "effect/Deferred"
import * as Config from "effect/Config"
import * as Option from "effect/Option"
/**
 * Independent scripted ACP agent. Uses raw JSON with Effect-managed waits; it
 * does not import the library, so it checks the library's wire behavior rather
 * than agreeing with it by construction.
 *
 * In-process: `createAgent(options, emit)` returns a line handler.
 * Subprocess: `bun test/fixtures/agent.ts <version> <mode>` speaks stdio.
 *   mode "normal"      answer as described below
 *   mode "unsupported" answer initialize with protocolVersion 99
 *   mode "no-read"     never read stdin
 *
 * Methods (besides initialize/session/new/session/prompt):
 *   _fixture/malformed   send malformed JSON, an unknown method, and a mixed batch;
 *                        answer with the client's replies
 *   _fixture/transcript  answer with every line received so far
 *   _fixture/slow        never answer; `$/cancel_request` answers -32800
 *   _fixture/stderr      write `params.bytes` to stderr, then answer
 *   _fixture/crash       exit(3) without answering
 */
export interface AgentOptions {
  readonly version: 1 | 2
  readonly mode?: "normal" | "unsupported" | "no-read" | "ignore-close"
  readonly stderr?: (text: string) => void
  readonly exit?: (code: number) => void
}

const RequestId = Schema.Union([Schema.String, Schema.Finite, Schema.Null])
type RequestId = typeof RequestId.Type
const Message = Schema.Struct({ jsonrpc: Schema.optionalKey(Schema.Literal("2.0")), id: Schema.optionalKey(RequestId), method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown), result: Schema.optionalKey(Schema.Unknown), error: Schema.optionalKey(Schema.Unknown),
  batch: Schema.optionalKey(Schema.Array(Schema.Unknown)) })
type Message = typeof Message.Type
const Frame = Schema.fromJsonString(Schema.Union([Message, Schema.Array(Message)]))
const SessionParams = Schema.Struct({ sessionId: Schema.String })
const PermissionResult = Schema.Struct({ outcome: Schema.optionalKey(Schema.Struct({ optionId: Schema.optionalKey(Schema.String) })) })


export const createAgent = (options: AgentOptions, emit: (line: string) => void) => {
  const { version } = options
  const received: Array<string> = []
  const waiting = new Map<RequestId | undefined, Deferred.Deferred<Message>>()
  const slow = new Set<RequestId | undefined>()
  let nextId = 0
  const send = (message: unknown) => Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(message).pipe(Effect.map(emit))
  const respond = (id: RequestId | undefined, result: unknown) => send({ jsonrpc: "2.0", id, result })
  const expectReply = (id: RequestId | undefined) => {
    const reply = Deferred.makeUnsafe<Message>()
    waiting.set(id, reply)
    return Deferred.await(reply)
  }

  const update = (sessionId: string) =>
    version === 1
      ? { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "thinking" } } }
      : { sessionId, update: { sessionUpdate: "agent_message_chunk", messageId: "m-1", content: { type: "text", text: "thinking" } } }

  const permission = (sessionId: string) =>
    version === 1
      ? {
        sessionId,
        toolCall: { toolCallId: "t-1", title: "Edit file" },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
      }
      : { sessionId, title: "Edit file", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] }

  const handle = (message: Message) => Effect.gen(function*() {
    if (!("method" in message)) {
      const reply = waiting.get(message.id)
      if (reply) yield* Deferred.succeed(reply, message)
      waiting.delete(message.id)
      return
    }
    const { id, method, params } = message
    switch (method) {
      case "initialize":
        if (options.mode === "unsupported") return yield* respond(id, { protocolVersion: 99 })
        return yield* respond(
          id,
          version === 1
            ? { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }
            : { protocolVersion: 2, info: { name: "fixture-agent", version: "1.0.0" }, capabilities: { session: {} } }
        )
      case "session/close":
        if (options.mode === "ignore-close") return
        return yield* send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
      case "session/new":
        return yield* respond(id, { sessionId: "sess-1" })
      case "session/prompt": {
        const { sessionId } = yield* Schema.decodeUnknownEffect(SessionParams)(params)
        yield* send({ jsonrpc: "2.0", method: "session/update", params: update(sessionId) })
        // Deliberately reuse the client's request id for the reverse request.
        const reply = expectReply(id)
        yield* send({ jsonrpc: "2.0", id, method: "session/request_permission", params: permission(sessionId) })
        const answer = yield* reply
        const result = yield* Schema.decodeUnknownEffect(PermissionResult)(answer.result)
        const optionId = result.outcome?.optionId ?? "none"
        if (version === 1) return yield* respond(id, { stopReason: "end_turn", _meta: { optionId } })
        yield* respond(id, { messageId: "m-1", _meta: { optionId } })
        return yield* send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } }
        })
      }
      case "_fixture/malformed": {
        const parse = expectReply(null)
        emit("{not json")
        const parseReply = yield* parse
        const unknown = expectReply("u-1")
        yield* send({ jsonrpc: "2.0", id: "u-1", method: "_fixture/unknown", params: {} })
        const unknownReply = yield* unknown
        const notificationId = `n-${nextId++}`
        const batch = expectReply("b-1")
        yield* send([
          { jsonrpc: "2.0", id: "b-1", method: "_fixture/echo", params: { ok: true } },
          { jsonrpc: "2.0", method: "_fixture/note", params: { id: notificationId } },
          { jsonrpc: "2.0", id: 5 } // neither request nor response
        ])
        const batchReply = yield* batch
        return yield* respond(id, { parse: parseReply, unknown: unknownReply, batch: batchReply })
      }
      case "_fixture/transcript":
        return yield* respond(id, { lines: received.slice() })
      case "_fixture/slow":
        slow.add(id)
        return
      case "$/cancel_request": {
        const { requestId } = yield* Schema.decodeUnknownEffect(Schema.Struct({ requestId: RequestId }))(params)
        if (slow.delete(requestId)) yield* send({ jsonrpc: "2.0", id: requestId, error: { code: -32800, message: "Request cancelled" } })
        return
      }
      case "_fixture/stderr": {
        const { bytes } = yield* Schema.decodeUnknownEffect(Schema.Struct({ bytes: Schema.Int }))(params)
        options.stderr?.("x".repeat(bytes))
        return yield* respond(id, { wrote: bytes })
      }
      case "_fixture/crash":
        return options.exit?.(3)
      default:
        if (id !== undefined) yield* send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
    }
  })

  return (line: string) => {
    received.push(line)
    Effect.runFork(Effect.gen(function*() {
      const value = yield* Schema.decodeEffect(Frame)(line)
      // A batch reply is routed as one message keyed by its first request id.
      if (Array.isArray(value)) {
        const request = value.find((entry) => entry.id === "b-1")
        const reply = waiting.get("b-1")
        if (request && reply) yield* Deferred.succeed(reply, { id: "b-1", batch: value })
        waiting.delete("b-1")
        return
      }
      const message = yield* Schema.decodeUnknownEffect(Message)(value)
      yield* handle(message)
    }))
  }
}

if (import.meta.main) {
  const [versionArg, mode = "normal"] = process.argv.slice(2)
  const pidfile = await Effect.runPromise(Config.option(Config.String("ACP_FIXTURE_PIDFILE")))
  if (Option.isSome(pidfile)) await Bun.write(pidfile.value, String(process.pid))
  const onLine = createAgent({
    version: versionArg === "2" ? 2 : 1,
    mode: await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Literals(["normal", "unsupported", "no-read", "ignore-close"]))(mode)),
    stderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code)
  }, (line) => process.stdout.write(line + "\n"))
  if (mode === "no-read") {
    await Effect.runPromise(Effect.never)
  } else {
    const { createInterface } = await import("node:readline")
    for await (const line of createInterface({ input: process.stdin })) {
      if (line.trim() !== "") onLine(line)
    }
  }
}
