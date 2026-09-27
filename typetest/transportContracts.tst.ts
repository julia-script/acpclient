import { describe, expect, it } from "tstyche"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type * as Socket from "effect/unstable/socket/Socket"
import * as AcpTransport from "../src/AcpTransport.ts"
import type { AcpTransportError } from "../src/AcpError.ts"
import * as WebSocket from "../src/transport/WebSocket.ts"

class Config extends Context.Service<Config, { readonly url: string }>()("test/TransportConfig") {}
class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

describe("transport acquisition contracts", () => {
  it("keeps the original explicit service type argument", () => {
    const acquire: Effect.Effect<AcpTransport.Transport, AcpTransportError, Config> = Effect.as(
      Effect.service(Config),
      {} as AcpTransport.Transport
    )

    expect(AcpTransport.layer<Config>(acquire)).type.toBe<Layer.Layer<
      AcpTransport.AcpTransport,
      AcpTransportError,
      Config
    >>()
  })

  it("retains custom acquisition errors and services", () => {
    const acquire = Effect.flatMap(Effect.service(Config), () => Effect.fail(new ConfigError({ message: "acquisition failed" })))
    const scopedAcquire = Effect.flatMap(Scope.Scope, () => acquire)

    expect(AcpTransport.layer(acquire)).type.toBe<Layer.Layer<AcpTransport.AcpTransport, ConfigError, Config>>()
    expect(AcpTransport.layer(scopedAcquire)).type.toBe<Layer.Layer<AcpTransport.AcpTransport, ConfigError, Config>>()
  })

  it("retains effectful URL errors and services", () => {
    const url = Effect.flatMap(Effect.service(Config), (config) =>
      config.url ? Effect.succeed(config.url) : Effect.fail(new ConfigError({ message: "URL lookup failed" })))
    const scopedUrl = Effect.flatMap(Scope.Scope, () => url)

    expect(WebSocket.make(url)).type.toBe<Effect.Effect<
      AcpTransport.Transport,
      AcpTransportError | ConfigError,
      Socket.WebSocketConstructor | Scope.Scope | Config
    >>()
    expect(WebSocket.layer(url)).type.toBe<Layer.Layer<
      AcpTransport.AcpTransport,
      AcpTransportError | ConfigError,
      Socket.WebSocketConstructor | Config
    >>()
    expect(WebSocket.layer(scopedUrl)).type.toBe<Layer.Layer<
      AcpTransport.AcpTransport,
      AcpTransportError | ConfigError,
      Socket.WebSocketConstructor | Config
    >>()
    expect(WebSocket.layer("ws://example.test")).type.toBe<Layer.Layer<
      AcpTransport.AcpTransport,
      AcpTransportError,
      Socket.WebSocketConstructor
    >>()
  })
})
