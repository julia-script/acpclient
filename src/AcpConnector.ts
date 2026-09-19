/** A factory for fresh scoped connections built from a transport Layer. */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type { AcpTransportError } from "./AcpError.ts"
import { AcpTransport, type Transport } from "./AcpTransport.ts"

export class AcpConnector extends Context.Service<AcpConnector, {
  /** Opens a fresh transport, owned by the caller's scope. */
  readonly connect: Effect.Effect<Transport, AcpTransportError, Scope.Scope>
}>()("effect-acp/AcpConnector") {}

/**
 * Captures the platform dependencies without opening a connection. Every
 * connect builds a fresh transport layer in that call's scope; neither layer
 * memoization nor sibling connections can share or prematurely close it.
 */
export const layer = <R>(transport: Layer.Layer<AcpTransport, AcpTransportError, R>): Layer.Layer<AcpConnector, never, R> =>
  Layer.effect(AcpConnector, Effect.gen(function*() {
    const services = yield* Effect.context<R>()
    return AcpConnector.of({
      connect: Effect.flatMap(Scope.Scope, (scope) => Layer.buildWithScope(Layer.fresh(transport), scope).pipe(
        Effect.provideContext(services),
        Effect.map((context) => Context.get(context, AcpTransport))
      ))
    })
  }))
