/**
 * Build a custom transport from any message-oriented channel. Here a web
 * `MessagePort` carries one JSON text frame per message, so no extra framing
 * is needed; the same shape fits WebSockets, Electron IPC, or workers.
 *
 *   bun examples/custom-transport.ts
 */
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Stream from "effect/Stream"
import { AcpConnector, AcpError, AcpProtocol, AcpTransport } from "effect-acp"
import { createAgent } from "../test/fixtures/agent.ts"

/** Adapts a MessagePort. The port is closed when the connection's scope closes. */
const fromMessagePort = (port: MessagePort) =>
  Effect.gen(function*() {
    // Bounded: if the application stops reading, the channel's own buffering applies.
    const inbox = yield* Queue.bounded<string, AcpError.AcpTransportError>(256)
    port.onmessage = (event) => {
      if (typeof event.data === "string") Queue.offerUnsafe(inbox, event.data)
      else {
        Queue.failCauseUnsafe(
          inbox,
          Cause.fail(new AcpError.AcpTransportError({ reason: "InvalidFrame", message: "non-text frame" }))
        )
      }
    }
    yield* Effect.addFinalizer(() => Effect.sync(() => port.close()))
    const transport: AcpTransport.Transport = {
      incoming: Stream.fromQueue(inbox),
      send: (frame) =>
        Effect.try({
          try: () => port.postMessage(frame),
          catch: (cause) => new AcpError.AcpTransportError({ reason: "Write", message: "postMessage failed", cause })
        })
    }
    return transport
  })

const program = Effect.scoped(Effect.gen(function*() {
  const channel = yield* Effect.acquireRelease(
    Effect.sync(() => new MessageChannel()),
    (channel) => Effect.sync(() => {
      channel.port1.close()
      channel.port2.close()
    })
  )
  // An agent on the other port (here: the in-process fixture agent).
  const onLine = createAgent({ version: 1 }, (line) => channel.port2.postMessage(line))
  channel.port2.onmessage = (event) => onLine(event.data)

  const { negotiated } = yield* AcpProtocol.connect({
    params: { clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }
  }).pipe(Effect.provide(AcpConnector.layer(fromMessagePort(channel.port1))))
  yield* Effect.log(`connected over MessagePort using ACP v${negotiated.version}`)
}))

if (import.meta.main) {
  BunRuntime.runMain(program)
}
