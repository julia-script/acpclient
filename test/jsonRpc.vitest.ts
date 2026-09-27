import { describe, expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Json from "../src/internal/json.ts"
import * as JsonRpc from "../src/internal/jsonRpc.ts"

describe("JSON-RPC envelope schemas", () => {
  it("preserves null IDs, structured params, absent params, and null results", () => {
    expect(JsonRpc.classify({ jsonrpc: "2.0", id: null, method: "test", params: null }))
      .toEqual({ _tag: "Request", id: null, method: "test", params: null })
    expect(JsonRpc.classify({ jsonrpc: "2.0", method: "test", params: [1] }))
      .toEqual({ _tag: "Notification", method: "test", params: [1] })
    expect(JsonRpc.classify({ jsonrpc: "2.0", method: "test" }))
      .toEqual({ _tag: "Notification", method: "test", params: undefined })
    expect(JsonRpc.classify({ jsonrpc: "2.0", id: "r", result: null }))
      .toEqual({ _tag: "Response", id: "r", result: null })
    expect(JsonRpc.classify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "failed", data: null } }))
      .toMatchObject({ _tag: "ErrorResponse", error: { code: -1, message: "failed", data: null } })
  })

  it("rejects invalid requests while keeping malformed responses distinguishable", () => {
    for (const value of [null, [], { jsonrpc: "1.0", method: "test" },
      { jsonrpc: "2.0", method: 1 }, { jsonrpc: "2.0", method: "test", params: false },
      { jsonrpc: "2.0", method: "test", id: 1.5 }]) {
      expect(JsonRpc.classify(value)._tag).toBe("Invalid")
    }
    for (const value of [
      { jsonrpc: "1.0", id: 1, result: null },
      { jsonrpc: "2.0", result: 1 },
      { jsonrpc: "2.0", id: 1, result: 1, error: { code: -1, message: "failed" } },
      { jsonrpc: "2.0", id: 1, error: { code: 1.5, message: "failed" } },
      { jsonrpc: "2.0", id: 1, error: { code: 1, message: false } }
    ]) expect(JsonRpc.classify(value)._tag).toBe("InvalidResponse")
  })

  it("JSON failures remain Results instead of escaping as exceptions", () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(Result.isFailure(Json.decodeResult("{broken"))).toBe(true)
    expect(Result.isFailure(Json.encodeResult(circular))).toBe(true)
    expect(Result.isFailure(Json.encodeResult(1n))).toBe(true)
  })
})
