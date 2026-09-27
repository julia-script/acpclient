import { describe, expect, it } from "tstyche"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as AcpConnection from "../src/AcpConnection.ts"
import type { AcpConnectionClosed, AcpProtocolError, AcpRequestError, AcpTimeoutError } from "../src/AcpError.ts"
import * as AcpSchema from "../src/AcpSchema.ts"

const Params = Schema.Struct({ value: Schema.FiniteFromString })
const transformed = AcpSchema.request("test/convert", Params, Schema.FiniteFromString)
const notice = AcpSchema.notification("test/notice", Params)
const identity = AcpSchema.request("test/identity", Schema.Finite, Schema.Finite)
declare const connection: AcpConnection.Service

describe("method codec contracts", () => {
  it("keeps decoded params and results distinct from their encoded forms", () => {
    expect(transformed.params).type.toBeAssignableTo<Schema.Codec<{ readonly value: number }, { readonly value: string }>>()
    expect(transformed.result).type.toBeAssignableTo<Schema.Codec<number, string>>()
    expect(notice.params).type.toBeAssignableTo<Schema.Codec<{ readonly value: number }, { readonly value: string }>>()
    expect({ value: 0 }).type.toBeAssignableTo<AcpSchema.Params<typeof transformed>>()
    expect({ value: "0" }).type.not.toBeAssignableTo<AcpSchema.Params<typeof transformed>>()
    expect(0).type.toBeAssignableTo<AcpSchema.Result<typeof transformed>>()
    expect(connection.request(transformed, { value: 1 })).type.toBe<Effect.Effect<number, AcpRequestError | AcpTimeoutError>>()
    expect(connection.notify(notice, { value: 1 })).type.toBe<Effect.Effect<void, AcpConnectionClosed | AcpProtocolError>>()
  })

  it("preserves identity-codec method declarations", () => {
    expect(identity).type.toBeAssignableTo<AcpSchema.RequestMethod<"test/identity", number, number>>()
    expect(connection.request(identity, 1)).type.toBe<Effect.Effect<number, AcpRequestError | AcpTimeoutError>>()
  })
})
