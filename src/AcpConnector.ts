/**
 * Service that opens scoped ACP transports: a spawned process, a socket, or
 * an application-provided adapter.
 *
 * @since 0.1.0
 */
import * as Context from "effect/Context"
import type * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type { AcpTransportError } from "./AcpError.ts"
import type { AcpTransport } from "./AcpTransport.ts"

export class AcpConnector extends Context.Service<AcpConnector, {
  /** Opens a transport owned by the caller's scope. */
  readonly connect: Effect.Effect<AcpTransport, AcpTransportError, Scope.Scope>
}>()("effect-acp/AcpConnector") {}

/** Builds a connector layer from a scoped transport factory. */
export const layer = (
  connect: Effect.Effect<AcpTransport, AcpTransportError, Scope.Scope>
): Layer.Layer<AcpConnector> => Layer.succeed(AcpConnector, AcpConnector.of({ connect }))
