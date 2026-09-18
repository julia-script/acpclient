/**
 * Version-neutral ACP wire contracts: JSON-RPC identifiers, error codes, and
 * the method declarations that bind a method name to its payload codecs.
 *
 * Versioned payload schemas live in `effect-acp/protocol/v1` and
 * `effect-acp/protocol/v2`.
 *
 * @since 0.1.0
 */
import * as Schema from "effect/Schema"
import * as W from "./internal/wire.ts"

/**
 * A JSON-RPC request identifier. Distinct from session, message, and
 * application identifiers.
 */
export type RequestId = string | number | null
export const RequestId: Schema.Codec<RequestId> = Schema.Union([Schema.String, W.integer, Schema.Null])

/** Standard JSON-RPC and ACP error codes. */
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

/** A JSON-RPC error object as sent on the wire. */
export interface ErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}
export const ErrorObject: Schema.Codec<ErrorObject> = W.def<ErrorObject>(
  "ErrorObject",
  W.object({ code: W.integer, message: Schema.String, data: Schema.optionalKey(Schema.Unknown) })
)

/** A request method: params are sent, a result (or error) comes back. */
export interface RequestMethod<M extends string = string, P = any, R = any> {
  readonly _tag: "Request"
  readonly method: M
  readonly params: Schema.Codec<P>
  readonly result: Schema.Codec<R>
}

/** A notification method: params are sent and never answered. */
export interface NotificationMethod<M extends string = string, P = any> {
  readonly _tag: "Notification"
  readonly method: M
  readonly params: Schema.Codec<P>
}

export type Method = RequestMethod | NotificationMethod

export const request = <const M extends string, P, R>(
  method: M,
  params: Schema.Codec<P>,
  result: Schema.Codec<R>
): RequestMethod<M, P, R> => ({ _tag: "Request", method, params, result })

export const notification = <const M extends string, P>(
  method: M,
  params: Schema.Codec<P>
): NotificationMethod<M, P> => ({ _tag: "Notification", method, params })

/** Params type of a declared method. */
export type Params<D extends Method> = D["params"]["Type"]
/** Result type of a declared request method. */
export type Result<D extends RequestMethod> = D["result"]["Type"]
