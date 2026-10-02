/**
 * A factory for fresh scoped connections built from a transport acquisition.
 */
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import type { AcpTransportError } from "./AcpError.ts"
import type { Transport } from "./AcpTransport.ts"

/**
 * Service that opens a fresh transport in the scope of each connection request.
 *
 * **When to use**
 *
 * Use when multiple clients or sessions need independent transport lifetimes from the same adapter
 * configuration. `Stdio.layer` and `WebSocket.layer` provide it directly.
 *
 * @see {@link layer} for constructing a connector from a custom transport acquisition.
 *
 * @category services
 */
export class AcpConnector extends Context.Service<AcpConnector, {
  /**
   * Opens a fresh transport, owned by the caller's scope.
   */
  readonly connect: Effect.Effect<Transport, AcpTransportError, Scope.Scope>
}>()("effect-acp/AcpConnector") {}

/**
 * Captures the acquisition's dependencies without opening a connection. Every connect runs
 * `acquire` again in that call's scope, so sibling connections never share or prematurely close
 * one another's transport.
 *
 * @category constructors
 */
export const make = <R>(
  acquire: Effect.Effect<Transport, AcpTransportError, R>
): Effect.Effect<AcpConnector["Service"], never, Exclude<R, Scope.Scope>> =>
  Effect.map(Effect.context<Exclude<R, Scope.Scope>>(), (services) =>
    AcpConnector.of({
      connect: Effect.flatMap(Scope.Scope, (scope) =>
        Effect.provideContext(acquire, Context.add(services, Scope.Scope, scope) as Context.Context<R>))
    }))

/**
 * Provides {@link AcpConnector} from a scoped transport acquisition, e.g. a custom adapter.
 *
 * @category layers
 */
export const layer = <R>(
  acquire: Effect.Effect<Transport, AcpTransportError, R>
): Layer.Layer<AcpConnector, never, Exclude<R, Scope.Scope>> =>
  Layer.effect(AcpConnector, make(acquire))
