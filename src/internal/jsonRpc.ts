/**
 * JSON-RPC 2.0 envelope classification and construction.
 *
 * @internal
 */
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { ErrorObject, RequestId } from "../AcpSchema.ts"

export type Incoming =
  | { readonly _tag: "Request"; readonly id: RequestId; readonly method: string; readonly params: typeof Params.Type | undefined }
  | { readonly _tag: "Notification"; readonly method: string; readonly params: typeof Params.Type | undefined }
  | { readonly _tag: "Response"; readonly id: RequestId; readonly result: unknown }
  | { readonly _tag: "ErrorResponse"; readonly id: RequestId; readonly error: ErrorObject }
  /** Response-shaped but malformed; never answered. */
  | { readonly _tag: "InvalidResponse"; readonly id: RequestId | undefined; readonly reason: string }
  /** Answered with an Invalid Request error whose id is null. */
  | { readonly _tag: "Invalid"; readonly reason: string }

export type Outgoing =
  | { readonly jsonrpc: "2.0"; readonly method: string; readonly id?: RequestId; readonly params?: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly result: unknown }
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly error: ErrorObject }

const ObjectEnvelope = Schema.Record(Schema.String, Schema.Unknown)
// ACP permits null for methods without parameters, as well as structured params.
const Params = Schema.Union([Schema.Null, ObjectEnvelope, Schema.Array(Schema.Unknown)])
const notificationFields = {
  jsonrpc: Schema.Literal("2.0"),
  method: Schema.String,
  params: Schema.optionalKey(Params)
}
const Request = Schema.Struct({ ...notificationFields, id: RequestId })
const Notification = Schema.Struct(notificationFields)
const Response = Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: RequestId, result: Schema.Unknown })
const ErrorResponse = Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: RequestId, error: ErrorObject })
const isObject = Schema.is(ObjectEnvelope)
export const isRequestId = Schema.is(RequestId)
const decodeRequest = Schema.decodeUnknownResult(Request)
const decodeNotification = Schema.decodeUnknownResult(Notification)
const decodeResponse = Schema.decodeUnknownResult(Response)
const decodeErrorResponse = Schema.decodeUnknownResult(ErrorResponse)

export const classify = (u: unknown): Incoming => {
  if (!isObject(u)) return { _tag: "Invalid", reason: "Message is not an object" }
  const hasId = "id" in u
  if ("method" in u) {
    if (hasId) {
      const decoded = decodeRequest(u)
      return Result.isFailure(decoded)
        ? { _tag: "Invalid", reason: decoded.failure.message }
        : { _tag: "Request", id: decoded.success.id, method: decoded.success.method, params: decoded.success.params }
    }
    const decoded = decodeNotification(u)
    return Result.isFailure(decoded)
      ? { _tag: "Invalid", reason: decoded.failure.message }
      : { _tag: "Notification", method: decoded.success.method, params: decoded.success.params }
  }
  if ("result" in u || "error" in u) {
    if (!hasId || !isRequestId(u.id)) return { _tag: "InvalidResponse", id: undefined, reason: "Invalid response id" }
    if ("result" in u && "error" in u) return { _tag: "InvalidResponse", id: u.id, reason: "Both result and error" }
    if ("result" in u) {
      const decoded = decodeResponse(u)
      return Result.isFailure(decoded)
        ? { _tag: "InvalidResponse", id: u.id, reason: decoded.failure.message }
        : { _tag: "Response", id: decoded.success.id, result: decoded.success.result }
    }
    const decoded = decodeErrorResponse(u)
    return Result.isFailure(decoded)
      ? { _tag: "InvalidResponse", id: u.id, reason: decoded.failure.message }
      : { _tag: "ErrorResponse", id: decoded.success.id, error: decoded.success.error }
  }
  return { _tag: "Invalid", reason: "Not a request, notification, or response" }
}

export const request = (id: RequestId, method: string, params: unknown): Outgoing =>
  params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params }

export const notification = (method: string, params: unknown): Outgoing =>
  params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params }

export const success = (id: RequestId, result: unknown): Outgoing => ({ jsonrpc: "2.0", id, result: result ?? null })

export const failure = (id: RequestId, code: number, message: string, data?: unknown): Outgoing => ({
  jsonrpc: "2.0",
  id,
  error: data === undefined ? { code, message } : { code, message, data }
})
