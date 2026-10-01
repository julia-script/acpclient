import { expect, it } from "@effect/vitest"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Socket from "effect/socket/Socket"
import * as AcpTransport from "../src/AcpTransport.ts"
import * as WebSocket from "../src/transport/WebSocket.ts"

class Config extends Context.Service<Config, { readonly url: string }>()("test/TransportContractConfig") {}
class ConfigError extends Data.TaggedError("ConfigError")<{ readonly message: string }> {}

it.effect("keeps a custom transport acquisition failure intact", () => Effect.scoped(Effect.gen(function*() {
  const failure = new ConfigError({ message: "acquisition failed" })
  const acquire = Effect.flatMap(Config, () => Effect.fail(failure))
  const transport = AcpTransport.layer(acquire)
  const received = yield* Effect.flip(Layer.build(transport).pipe(
    Effect.provideService(Config, { url: "ws://example.test" })
  ))

  expect(received).toBe(failure)
})))

it.effect("keeps an effectful URL failure intact before dialing", () => Effect.scoped(Effect.gen(function*() {
  const failure = new ConfigError({ message: "URL lookup failed" })
  let dialed = false
  const url = Effect.flatMap(Config, () => Effect.fail(failure))
  const transport = WebSocket.layer(url)
  const received = yield* Effect.flip(Layer.build(transport).pipe(
    Effect.provideService(Config, { url: "ws://example.test" }),
    Effect.provideService(Socket.WebSocketConstructor, () => {
      dialed = true
      throw new ConfigError({ message: "URL failure must prevent dialing" })
    })
  ))

  expect(received).toBe(failure)
  expect(dialed).toBe(false)
})))
