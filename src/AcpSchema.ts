/**
 * Version-neutral ACP wire contracts: JSON-RPC identifiers, error codes, and the method
 * declarations that bind a method name to its payload codecs.
 *
 * **Details**
 *
 * Versioned payload schemas live in `effect-acp/protocol/v1` and
 * `effect-acp/protocol/v2`.
 */
import * as Schema from "effect/Schema"
import * as Wire from "./internal/wire.ts"

/**
 * A JSON-RPC request identifier. Distinct from session, message, and application identifiers.
 *
 * @category schemas
 */
export const RequestId = Schema.Union([Schema.String, Wire.integer, Schema.Null])
/**
 * JSON-RPC identifier used to correlate a request with its response.
 *
 * @category models
 */
export type RequestId = typeof RequestId.Type

/**
 * Standard JSON-RPC and ACP error codes.
 *
 * @category constants
 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  RequestCancelled: -32800,
  AuthRequired: -32000,
  ResourceNotFound: -32002
} as const

/**
 * A JSON-RPC error object as sent on the wire.
 *
 * @category models
 */
export interface ErrorObject {
  /**
   * Numeric failure code used by JSON-RPC or an ACP extension.
   */
  readonly code: number
  /**
   * Human-readable description supplied by the failing peer.
   */
  readonly message: string
  /**
   * Optional peer-provided error details.
   */
  readonly data?: unknown
}
/**
 * Schema for JSON-RPC error objects received from or sent to a peer.
 *
 * @category schemas
 */
export const ErrorObject: Schema.Codec<ErrorObject> = Wire.object({
  code: Wire.integer, message: Schema.String, data: Schema.optionalKey(Schema.Unknown)
}).annotate({ identifier: "ErrorObject" })

/**
 * A request method: params are sent, a result (or error) comes back.
 *
 * @category models
 */
export interface RequestMethod<M extends string = string, P = unknown, R = unknown, PE = unknown, RE = unknown> {
  readonly _tag: "Request"
  /**
   * Exact wire method name used for dispatch.
   */
  readonly method: M
  /**
   * Codec for outgoing parameter encoding and incoming parameter decoding.
   */
  readonly params: Schema.Codec<P, PE>
  /**
   * Codec for outgoing result encoding and incoming result decoding.
   */
  readonly result: Schema.Codec<R, RE>
}

/**
 * A notification method: params are sent and never answered.
 *
 * @category models
 */
export interface NotificationMethod<M extends string = string, P = unknown, PE = unknown> {
  readonly _tag: "Notification"
  /**
   * Exact wire method name used for dispatch.
   */
  readonly method: M
  /**
   * Codec for outgoing parameter encoding and incoming parameter decoding.
   */
  readonly params: Schema.Codec<P, PE>
}

/**
 * Request or notification declaration binding a wire method name to its codecs.
 *
 * @category models
 */
export type Method = RequestMethod | NotificationMethod

/**
 * Creates a request declaration from its wire name, parameter codec, and result codec.
 *
 * **When to use**
 *
 * Use to define typed extension requests or custom protocol methods. The declaration can be passed
 * to connection requests and incoming routes.
 *
 * **Details**
 *
 * The parameter and result codecs may have different encoded and decoded types. Creating a
 * declaration performs no validation or I/O.
 *
 * @see {@link notification} for methods that do not receive responses.
 *
 * @category constructors
 */
export const request = <const M extends string, P, R, PE, RE>(
  method: M,
  params: Schema.Codec<P, PE>,
  result: Schema.Codec<R, RE>
): RequestMethod<M, P, R, PE, RE> => ({ _tag: "Request", method, params, result })

/**
 * Creates a notification declaration from its wire name and parameter codec.
 *
 * **Details**
 *
 * A notification has no result codec because the peer does not answer it. Creating a declaration
 * performs no validation or I/O.
 *
 * @see {@link request} for methods that receive responses.
 *
 * @category constructors
 */
export const notification = <const M extends string, P, PE>(
  method: M,
  params: Schema.Codec<P, PE>
): NotificationMethod<M, P, PE> => ({ _tag: "Notification", method, params })

/**
 * Params type of a declared method.
 *
 * @category utility types
 */
export type Params<D extends Method> = D["params"]["Type"]
/**
 * Result type of a declared request method.
 *
 * @category utility types
 */
export type Result<D extends RequestMethod> = D["result"]["Type"]
