import { expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { AcpRemoteError, AcpTransportError } from "../src/AcpError.ts"
import { GatewayError } from "../src/AcpGateway.ts"
import { AcpHistoryUnavailable } from "../src/AcpSessionError.ts"

it("namespaces error schemas without changing public names or wire tags", () => {
  const transport = new AcpTransportError({ reason: "Open", message: "unavailable" })
  const history = new AcpHistoryUnavailable({ sessionId: "session-1", operation: "replay" })
  const gateway = new GatewayError({ code: "Closed", message: "Closed" })

  for (const [error, schema, identifier] of [
    [transport, AcpTransportError, "effect-acp/AcpError/AcpTransportError"],
    [history, AcpHistoryUnavailable, "effect-acp/AcpSessionError/AcpHistoryUnavailable"],
    [gateway, GatewayError, "effect-acp/AcpGateway/GatewayError"]
  ] as const) {
    expect(schema.ast.annotations?.identifier).toBe(identifier)
    expect(error.name).toBe(error._tag)
  }
  expect(String(gateway)).toBe("AcpGatewayError: Closed")

  expect(Schema.encodeResult(AcpTransportError)(transport)).toEqual(Result.succeed({
    _tag: "AcpTransportError", reason: "Open", message: "unavailable"
  }))
  expect(Schema.encodeResult(AcpHistoryUnavailable)(history)).toEqual(Result.succeed({
    _tag: "AcpHistoryUnavailable", sessionId: "session-1", operation: "replay"
  }))
  expect(Schema.encodeResult(GatewayError)(gateway)).toEqual(Result.succeed({
    _tag: "AcpGatewayError", code: "Closed", message: "Closed"
  }))
})

it("keeps error definitions distinct when schemas are combined", () => {
  const document = Schema.toJsonSchemaDocument(Schema.Union([AcpTransportError, AcpRemoteError]))
  expect(document.schema).toEqual({
    anyOf: [
      { $ref: "#/$defs/effect-acp~1AcpError~1AcpTransportErrorEncoded" },
      { $ref: "#/$defs/effect-acp~1AcpError~1AcpRemoteErrorEncoded" }
    ]
  })
  expect(Object.keys(document.definitions)).toEqual([
    "effect-acp/AcpError/AcpTransportErrorEncoded",
    "effect-acp/AcpError/AcpRemoteErrorEncoded"
  ])
})
