/**
 * Typed failures for ACP transports and connections.
 *
 */
import * as Schema from "effect/Schema"

/** A transport could not open, read, write, or frame a message. */
export class AcpTransportError extends Schema.TaggedError<AcpTransportError>()("AcpTransportError", {
  reason: Schema.Literals(["Open", "Read", "Write", "Closed", "FrameTooLarge", "InvalidFrame"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** The connection terminated; pending and later calls observe this failure. */
export class AcpConnectionClosed extends Schema.TaggedError<AcpConnectionClosed>()("AcpConnectionClosed", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** The remote peer answered a request with a JSON-RPC error. */
export class AcpRemoteError extends Schema.TaggedError<AcpRemoteError>()("AcpRemoteError", {
  code: Schema.Finite,
  message: Schema.String,
  data: Schema.optional(Schema.Unknown)
}) {}

/** The remote peer sent data that violates the negotiated protocol. */
export class AcpProtocolError extends Schema.TaggedError<AcpProtocolError>()("AcpProtocolError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/** A configured communication limit was reached; nothing was sent. */
export class AcpCapacityError extends Schema.TaggedError<AcpCapacityError>()("AcpCapacityError", {
  resource: Schema.Literals(["pendingRequests"]),
  limit: Schema.Finite
}) {}

/**
 * A local deadline elapsed. The remote request may still be running; this is
 * not a confirmed remote cancellation.
 */
export class AcpTimeoutError extends Schema.TaggedError<AcpTimeoutError>()("AcpTimeoutError", {
  method: Schema.String,
  requestId: Schema.Union([Schema.String, Schema.Finite, Schema.Null])
}) {}

/** Initialization selected a protocol version outside the enabled set. */
export class AcpUnsupportedVersion extends Schema.TaggedError<AcpUnsupportedVersion>()("AcpUnsupportedVersion", {
  requested: Schema.Finite,
  received: Schema.Unknown,
  supported: Schema.Array(Schema.Finite)
}) {}

/** Failures of an outgoing request. */
export type AcpRequestError = AcpRemoteError | AcpProtocolError | AcpConnectionClosed | AcpCapacityError
