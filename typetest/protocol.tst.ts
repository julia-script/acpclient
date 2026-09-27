import { describe, expect, it } from "tstyche"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as AcpProtocol from "../src/AcpProtocol.ts"
import type { AcpConnectionClosed, AcpTransportError } from "../src/AcpError.ts"
import type { AcpConnector } from "../src/AcpConnector.ts"

const v1Params = { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }
const v2Params = { info: { name: "client", version: "1" }, capabilities: {} }

describe("public protocol contracts", () => {
  it("accepts only supported version policies with matching params", () => {
    expect({ params: v1Params }).type.toBeAssignableTo<AcpProtocol.ConnectOptions>()
    expect({ versions: [2, 1] as const, params: v2Params }).type.toBeAssignableTo<AcpProtocol.ConnectOptions>()
    expect({ versions: [1, 2] as const, params: v2Params }).type.not.toBeAssignableTo<AcpProtocol.ConnectOptions>()
    expect({ versions: [2, 1] as const, params: v1Params }).type.not.toBeAssignableTo<AcpProtocol.ConnectOptions>()
  })

  it("exposes connection scope and typed initialization failures", () => {
    expect(AcpProtocol.connect({ params: v1Params })).type.toBe<
      Effect.Effect<
        AcpProtocol.Connected,
        AcpTransportError | AcpConnectionClosed | AcpProtocol.InitializeError,
        AcpConnector | Scope.Scope
      >
    >()
  })
})
