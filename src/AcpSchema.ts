/**
 * Version-neutral ACP wire contracts: JSON-RPC identifiers, error codes, and
 * the method declarations that bind a method name to its payload codecs.
 *
 * Versioned payload schemas live in `effect-acp/protocol/v1` and
 * `effect-acp/protocol/v2`.
 *
 */
import * as Schema from "effect/Schema"
import * as Wire from "./internal/wire.ts"

/**
 * A JSON-RPC request identifier. Distinct from session, message, and
 * application identifiers.
 */
export const RequestId = Schema.Union([Schema.String, Wire.integer, Schema.Null])
export type RequestId = typeof RequestId.Type

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
export const ErrorObject: Schema.Codec<ErrorObject> = Wire.object({
  code: Wire.integer, message: Schema.String, data: Schema.optionalKey(Schema.Unknown)
}).annotate({ identifier: "ErrorObject" })

/** A request method: params are sent, a result (or error) comes back. */
export interface RequestMethod<M extends string = string, P = unknown, R = unknown, PE = unknown, RE = unknown> {
  readonly _tag: "Request"
  readonly method: M
  readonly params: Schema.Codec<P, PE>
  readonly result: Schema.Codec<R, RE>
}

/** A notification method: params are sent and never answered. */
export interface NotificationMethod<M extends string = string, P = unknown, PE = unknown> {
  readonly _tag: "Notification"
  readonly method: M
  readonly params: Schema.Codec<P, PE>
}

export type Method = RequestMethod | NotificationMethod

export const request = <const M extends string, P, R, PE, RE>(
  method: M,
  params: Schema.Codec<P, PE>,
  result: Schema.Codec<R, RE>
): RequestMethod<M, P, R, PE, RE> => ({ _tag: "Request", method, params, result })

export const notification = <const M extends string, P, PE>(
  method: M,
  params: Schema.Codec<P, PE>
): NotificationMethod<M, P, PE> => ({ _tag: "Notification", method, params })

/** Params type of a declared method. */
export type Params<D extends Method> = D["params"]["Type"]
/** Result type of a declared request method. */
export type Result<D extends RequestMethod> = D["result"]["Type"]
