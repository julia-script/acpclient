import * as Effect from "effect/Effect"
import * as AcpGateway from "effect-acp/AcpGateway"
import * as AcpGatewayClient from "effect-acp/AcpGatewayClient"
import * as AcpRemoteClient from "effect-acp/AcpRemoteClient"

export const openHostedSession = (
  url: string,
  cwd: string,
  storage: AcpGatewayClient.Storage,
  saved?: AcpRemoteClient.SessionDescriptor
) => Effect.gen(function*() {
  const gateway = yield* AcpGatewayClient.connect(url, { workspace: "demo", storage })
  const remote = yield* AcpRemoteClient.make(gateway, { profile: "assistant" })
  if (saved !== undefined) {
    const session = yield* remote.attach(saved)
    return { session, descriptor: saved, gateway }
  }
  // The host's launch profile determines the actual ACP version and capabilities.
  const connection = yield* remote.connect({ versions: [1], params: {} })
  const session = yield* connection.newSession({ cwd })
  const descriptor = remote.descriptor(session)
  if (descriptor === undefined) return yield* AcpGateway.failure("NotFound")
  return { session, descriptor, gateway }
})
