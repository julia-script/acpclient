/**
 * Independent scripted ACP agent. Uses only JSON and plain callbacks; it does
 * not import the library, so it checks the library's wire behavior rather than
 * agreeing with it by construction.
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
  readonly mode?: "normal" | "unsupported" | "no-read"
  readonly stderr?: (text: string) => void
  readonly exit?: (code: number) => void
}

type Message = Record<string, any>

export const createAgent = (options: AgentOptions, emit: (line: string) => void) => {
  const { version } = options
  const received: Array<string> = []
  const waiting = new Map<unknown, (message: Message) => void>()
  const slow = new Set<unknown>()
  let nextId = 0
  const send = (message: unknown) => emit(JSON.stringify(message))
  const respond = (id: unknown, result: unknown) => send({ jsonrpc: "2.0", id, result })
  const expectReply = (id: unknown) => new Promise<Message>((resolve) => waiting.set(id, resolve))

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

  const handle = async (message: Message) => {
    if (!("method" in message)) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
      return
    }
    const { id, method, params } = message
    switch (method) {
      case "initialize":
        if (options.mode === "unsupported") return respond(id, { protocolVersion: 99 })
        return respond(
          id,
          version === 1
            ? { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] }
            : { protocolVersion: 2, info: { name: "fixture-agent", version: "1.0.0" }, capabilities: { session: {} } }
        )
      case "session/new":
        return respond(id, { sessionId: "sess-1" })
      case "session/prompt": {
        send({ jsonrpc: "2.0", method: "session/update", params: update(params.sessionId) })
        // Deliberately reuse the client's request id for the reverse request.
        const reply = expectReply(id)
        send({ jsonrpc: "2.0", id, method: "session/request_permission", params: permission(params.sessionId) })
        const answer = await reply
        const optionId = answer.result?.outcome?.optionId ?? "none"
        if (version === 1) return respond(id, { stopReason: "end_turn", _meta: { optionId } })
        respond(id, { messageId: "m-1", _meta: { optionId } })
        return send({
          jsonrpc: "2.0",
          method: "session/update",
          params: { sessionId: params.sessionId, update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" } }
        })
      }
      case "_fixture/malformed": {
        const parse = expectReply(null)
        emit("{not json")
        const parseReply = await parse
        const unknown = expectReply("u-1")
        send({ jsonrpc: "2.0", id: "u-1", method: "_fixture/unknown", params: {} })
        const unknownReply = await unknown
        const notificationId = `n-${nextId++}`
        const batch = expectReply("b-1")
        send([
          { jsonrpc: "2.0", id: "b-1", method: "_fixture/echo", params: { ok: true } },
          { jsonrpc: "2.0", method: "_fixture/note", params: { id: notificationId } },
          { jsonrpc: "2.0", id: 5 } // neither request nor response
        ])
        const batchReply = await batch
        return respond(id, { parse: parseReply, unknown: unknownReply, batch: batchReply })
      }
      case "_fixture/transcript":
        return respond(id, { lines: received.slice() })
      case "_fixture/slow":
        slow.add(id)
        return
      case "$/cancel_request":
        if (slow.delete(params?.requestId)) {
          send({ jsonrpc: "2.0", id: params.requestId, error: { code: -32800, message: "Request cancelled" } })
        }
        return
      case "_fixture/stderr":
        options.stderr?.("x".repeat(params.bytes))
        return respond(id, { wrote: params.bytes })
      case "_fixture/crash":
        return options.exit?.(3)
      default:
        if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } })
    }
  }

  return (line: string) => {
    received.push(line)
    const value = JSON.parse(line)
    // A batch reply is routed as one message keyed by its first request id.
    if (Array.isArray(value)) {
      const request = value.find((e: Message) => e.id === "b-1")
      if (request) waiting.get("b-1")?.({ id: "b-1", batch: value })
      waiting.delete("b-1")
      return
    }
    void handle(value)
  }
}

if (import.meta.main) {
  const [versionArg, mode = "normal"] = process.argv.slice(2)
  if (process.env.ACP_FIXTURE_PIDFILE) await Bun.write(process.env.ACP_FIXTURE_PIDFILE, String(process.pid))
  const onLine = createAgent({
    version: versionArg === "2" ? 2 : 1,
    mode: mode as AgentOptions["mode"],
    stderr: (text) => process.stderr.write(text),
    exit: (code) => process.exit(code)
  }, (line) => process.stdout.write(line + "\n"))
  if (mode === "no-read") {
    setInterval(() => {}, 1 << 30)
  } else {
    const { createInterface } = await import("node:readline")
    for await (const line of createInterface({ input: process.stdin })) {
      if (line.trim() !== "") onLine(line)
    }
  }
}
