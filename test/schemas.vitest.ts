import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import { describe, expect, it } from "@effect/vitest"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as V1 from "../src/protocol/v1/Schema.ts"
import * as V2 from "../src/protocol/v2/Schema.ts"
import { oracle } from "./support/oracle.ts"

const modules = { 1: V1, 2: V2 } as const

const codecs = (version: 1 | 2): Readonly<Record<string, Schema.Codec<unknown>>> => {
  const { version: _version, provenance: _provenance, agentMethods: _agent, clientMethods: _client,
    protocolMethods: _protocol, ...schemas } = modules[version]
  return schemas
}
const codec = (version: 1 | 2, definition: string): Schema.Codec<unknown> => {
  const found = codecs(version)[definition]
  if (!found) throw new Error(`Unknown schema v${version} ${definition}`)
  return found
}

const decode = (version: 1 | 2, definition: string, value: unknown) =>
  Schema.decodeUnknownExit(codec(version, definition))(value)

/** Codec and oracle must agree; accepted values must round trip unchanged. */
const conforms = (version: 1 | 2, definition: string, value: unknown, valid: boolean) => {
  expect({ definition, value, oracle: oracle(version, definition, value) }).toEqual({ definition, value, oracle: valid })
  const decoded = decode(version, definition, value)
  expect({ definition, value, codec: Exit.isSuccess(decoded) }).toEqual({ definition, value, codec: valid })
  if (Exit.isSuccess(decoded)) {
    expect(decoded.value).toEqual(value)
    expect(Schema.encodeUnknownResult(codec(version, definition))(decoded.value)).toEqual(Result.succeed(value))
  }
}

const text = { type: "text", text: "hi" }

// [version, definition, value, valid]
const fixtures: ReadonlyArray<readonly [1 | 2, string, unknown, boolean]> = [
  // primitives, integers, numeric constraints
  [2, "SessionId", "s-1", true],
  [2, "SessionId", 1, false],
  [2, "ProtocolVersion", 2, true],
  [2, "ProtocolVersion", 65535, true],
  [2, "ProtocolVersion", 65536, false],
  [2, "ProtocolVersion", -1, false],
  [2, "ProtocolVersion", 1.5, false],
  [1, "ProtocolVersion", "1", false],
  [2, "RequestId", null, true],
  [2, "RequestId", Number.MAX_SAFE_INTEGER + 2, true],
  [2, "RequestId", 1.25, false],
  [2, "RequestId", true, false],
  [2, "ErrorCode", -32601, true],
  [2, "ErrorCode", 42, true],
  [2, "ErrorCode", "x", false],
  // string pattern
  [2, "Cost", { amount: 1.5, currency: "USD" }, true],
  [2, "Cost", { amount: 1.5, currency: "usd" }, false],
  [2, "Cost", { amount: "1", currency: "USD" }, false],
  // objects: required, optional, null, extra keys, arrays, minItems
  [2, "Implementation", { name: "a", version: "1" }, true],
  [2, "Implementation", { name: "a", version: "1", title: null, extra: { nested: [1] } }, true],
  [2, "Implementation", { name: "a" }, false],
  [2, "Implementation", { name: "a", version: 1 }, false],
  [2, "Implementation", ["a"], false],
  [2, "Implementation", { name: "a", version: "1", _meta: "no" }, false],
  [2, "UsageUpdate", { used: 1, size: 2, cost: null }, true],
  [2, "UsageUpdate", { used: -1, size: 2 }, false],
  [2, "RequestPermissionRequest", {
    sessionId: "s",
    title: "t",
    options: [{ optionId: "o", name: "Allow", kind: "allow_once" }]
  }, true],
  [2, "RequestPermissionRequest", { sessionId: "s", title: "t", options: [] }, false],
  [2, "AgentMessage", { messageId: "m", content: [text, { type: "image", data: "AA==", mimeType: "image/png" }] }, true],
  [2, "AgentMessage", { messageId: "m", content: [text, 1] }, false],
  [1, "ClientCapabilities", {}, true],
  [1, "ClientCapabilities", { fs: { readTextFile: true, writeTextFile: false }, terminal: true }, true],
  [1, "ClientCapabilities", { terminal: "yes" }, false],
  [1, "PromptResponse", { stopReason: "end_turn" }, true],
  [1, "PromptResponse", { stopReason: "paused" }, false],
  // references and records
  [2, "ElicitationSessionScope", { sessionId: "s", toolCallId: null }, true],
  [2, "ElicitationRequestScope", { requestId: 3 }, true],
  [2, "ElicitationRequestScope", { requestId: {} }, false]
]

describe("generated codecs match the source-dialect validator", () => {
  for (const [version, definition, value, valid] of fixtures) {
    it(`v${version} ${definition} ${JSON.stringify(value)} is ${valid ? "valid" : "invalid"}`, () =>
      conforms(version, definition, value, valid))
  }
})

describe("unions, intersections, and fallback variants", () => {
  const cases: ReadonlyArray<readonly [1 | 2, string, unknown, boolean]> = [
    // known variants
    [2, "ContentBlock", text, true],
    [1, "ContentBlock", text, true],
    // malformed known variants must not match the fallback
    [2, "ContentBlock", { type: "text" }, false],
    [2, "ContentBlock", { type: "text", text: 1 }, false],
    [2, "ContentBlock", { type: "image", data: "AA==" }, false],
    [2, "ToolCallContent", { type: "diff", path: 1 }, false],
    [2, "SessionUpdate", { sessionUpdate: "agent_message_chunk", messageId: "m" }, false],
    [2, "StateUpdate", { state: "idle", stopReason: 7 }, false],
    // permitted unknown variants keep nested raw data and metadata
    [2, "ContentBlock", { type: "hologram", payload: { raw: [1, { deep: null }] }, _meta: { vendor: { x: 1 } } }, true],
    [2, "SessionUpdate", { sessionUpdate: "future_update", data: { a: [1, 2] }, _meta: { k: "v" } }, true],
    [2, "ToolCallContent", { type: "future", anything: true }, true],
    // v1 unions are closed
    [1, "ContentBlock", { type: "hologram" }, false],
    [1, "SessionUpdate", { sessionUpdate: "future_update" }, false],
    // oneOf
    [1, "StopReason", "cancelled", true],
    [1, "StopReason", "other", false],
    [2, "ElicitationSchemaType", "object", true],
    [2, "ElicitationSchemaType", "array", false],
    // object intersected with a union with a negated fallback
    [2, "CreateElicitationRequest", {
      message: "m",
      mode: "url",
      elicitationId: "e",
      url: "https://x",
      sessionId: "s"
    }, true],
    [2, "CreateElicitationRequest", { message: "m", mode: "url", elicitationId: "e", sessionId: "s" }, false],
    [2, "CreateElicitationRequest", { message: "m", mode: "future", sessionId: "s", extra: [1] }, true],
    [2, "CreateElicitationRequest", { message: "m", mode: "future" }, false],
    [2, "CreateElicitationRequest", { mode: "future", sessionId: "s" }, false]
  ]
  for (const [version, definition, value, valid] of cases) {
    it(`v${version} ${definition} ${JSON.stringify(value)} is ${valid ? "valid" : "invalid"}`, () =>
      conforms(version, definition, value, valid))
  }

  it("a malformed known variant reports the variant's own failure", () => {
    const exit = decode(2, "ContentBlock", { type: "text", text: 1 })
    expect(Exit.isFailure(exit)).toBe(true)
  })
})

describe("patch semantics", () => {
  it("omitted, null, and concrete values stay distinct through a round trip", () => {
    const updates = [
      { sessionUpdate: "tool_call_update", toolCallId: "t" },
      { sessionUpdate: "tool_call_update", toolCallId: "t", content: null, title: null },
      { sessionUpdate: "tool_call_update", toolCallId: "t", content: [{ type: "content", content: text }], title: "x" }
    ]
    for (const update of updates) {
      const result = Schema.decodeResult(V2.SessionUpdate)(update)
      expect(result).toEqual(Result.succeed(update))
      if (Result.isSuccess(result)) expect(Schema.encodeUnknownResult(V2.SessionUpdate)(result.success)).toEqual(Result.succeed(update))
    }
    for (const u of updates) expect(oracle(2, "SessionUpdate", u)).toBe(true)
  })
})

describe("versioned contracts", () => {
  it("v1 completion and v2 insertion acknowledgement are distinct contracts", () => {
    const v1 = { stopReason: "end_turn" } satisfies V1.PromptResponse
    const v2 = { messageId: "m-1" } satisfies V2.PromptResponse
    expect(Schema.decodeResult(V1.PromptResponse)(v1)).toEqual(Result.succeed(v1))
    expect(Schema.decodeResult(V2.PromptResponse)(v2)).toEqual(Result.succeed(v2))
    expect(Exit.isFailure(Schema.decodeUnknownExit(V1.PromptResponse)(v2))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(V2.PromptResponse)(v1))).toBe(true)
    expect(V1.agentMethods["session/prompt"].result).toBe(V1.PromptResponse)
    expect(V2.agentMethods["session/prompt"].result).toBe(V2.PromptResponse)
  })

  it.live("method maps cover the upstream method metadata", () => Effect.gen(function*() {
    for (const [version, module] of [[1, V1], [2, V2]] as const) {
      const meta = yield* Effect.promise(() => Bun.file(`repos/agent-client-protocol/schema/v${version}/meta.json`).text()).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Schema.Struct({
          agentMethods: Schema.Record(Schema.String, Schema.String),
          clientMethods: Schema.Record(Schema.String, Schema.String)
        }))))
      )
      expect(Object.keys(module.agentMethods).sort()).toEqual(Object.values(meta.agentMethods).sort())
      expect(Object.keys(module.clientMethods).sort()).toEqual(Object.values(meta.clientMethods).sort())
      expect(Object.keys(module.protocolMethods)).toEqual(["$/cancel_request"])
      expect(module.provenance.version).toBe(version)
    }
    expect(V2.agentMethods["session/cancel"]._tag).toBe("Notification")
    expect(V2.clientMethods["session/request_permission"]._tag).toBe("Request")
  }))
})
