import { expect, it } from "@effect/vitest"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { AcpTransportError } from "../src/AcpError.ts"
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
