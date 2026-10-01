import * as Effect from "effect/Effect"
import { AcpClient } from "effect-acp/AcpClient"
import * as Layer from "effect/Layer"
import * as Socket from "effect/socket/Socket"
import * as AcpConnector from "effect-acp/AcpConnector"
import * as AcpLocalClient from "effect-acp/AcpLocalClient"
import * as WebSocket from "effect-acp/transport/WebSocket"

export const browserClient = (url: string) => AcpLocalClient.layer.pipe(
  Layer.provide(AcpConnector.layer(WebSocket.layer(url))),
  Layer.provide(Socket.layerWebSocketConstructorGlobal)
)


// A complete one-turn operation. For a chat UI, keep its connection scope open
// for the lifetime of the view and use session.observe to render updates.
export const greetThroughBridge = (url: string, cwd: string, authMethod?: string) => Effect.scoped(
  Effect.gen(function*() {
    const client = yield* AcpClient
    const connection = yield* client.connect({
      versions: [1],
      params: { clientInfo: { name: "browser-app", version: "1.0.0" } },
      timeout: "30 seconds",
      interactionTimeout: "30 seconds"
    })
    if (authMethod !== undefined) yield* connection.authenticate(authMethod)
    const session = yield* connection.newSession({ cwd })
    const submission = yield* session.submit([{
      type: "text", text: "Reply with a short greeting. Do not use tools."
    }])
    yield* submission.outcome
    return yield* session.snapshot
  })
).pipe(Effect.provide(browserClient(url)))
