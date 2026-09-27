/**
 * Scoped duplex exchange of complete UTF-8 JSON text frames.
 *
 * A frame holds one JSON-RPC message or a batch array. Adapters own framing
 * (stdio newline delimiting, WebSocket messages, ...), ordered writes, and
 * closure; JSON parsing and envelope handling belong to `AcpConnection`.
 * Transport values are acquired in a `Scope`; closing it releases the
 * underlying resources.
 *
 */
import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import type * as Scope from "effect/Scope"
import type * as Effect from "effect/Effect"
import type * as Stream from "effect/Stream"
import type { AcpTransportError } from "./AcpError.ts"

export interface Transport {
  /**
   * Inbound frames in arrival order. Consumed once. Ends when the remote side
   * closes; fails on a read or framing error.
   */
  readonly incoming: Stream.Stream<string, AcpTransportError>
  /**
   * Writes one complete frame. Writes are ordered and never interleave. May
   * suspend while the transport applies backpressure; fails with reason
   * `"Closed"` once the transport is closed.
   */
  readonly send: (frame: string) => Effect.Effect<void, AcpTransportError>
}

/** One scoped duplex connection, supplied by a concrete transport layer. */
export class AcpTransport extends Context.Service<AcpTransport, Transport>()("effect-acp/AcpTransport") {}

/** Builds a transport layer from a scoped adapter acquisition. */
export const layer = <E, R>(
  acquire: Effect.Effect<Transport, E, R>
): Layer.Layer<AcpTransport, E, Exclude<R, Scope.Scope>> =>
  Layer.effect(AcpTransport, acquire)
