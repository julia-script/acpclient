/**
 * JSON-RPC 2.0 envelope classification and construction.
 *
 * @internal
 */
import type { ErrorObject, RequestId } from "../AcpSchema.ts"

export type Incoming =
  | { readonly _tag: "Request"; readonly id: RequestId; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Notification"; readonly method: string; readonly params: unknown }
  | { readonly _tag: "Response"; readonly id: RequestId; readonly result: unknown }
  | { readonly _tag: "ErrorResponse"; readonly id: RequestId; readonly error: ErrorObject }
  /** Response-shaped but malformed; never answered. */
  | { readonly _tag: "InvalidResponse"; readonly id: RequestId | undefined; readonly reason: string }
  /** Answered with an Invalid Request error whose id is null. */
  | { readonly _tag: "Invalid"; readonly reason: string }

export type Outgoing = Record<string, unknown>

const isObject = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null && !Array.isArray(u)

export const isRequestId = (u: unknown): u is RequestId =>
  typeof u === "string" || u === null || (typeof u === "number" && Number.isInteger(u))

// ACP permits `params: null` for methods without parameters.
const isParams = (u: unknown) => u === null || typeof u === "object"

export const classify = (u: unknown): Incoming => {
  if (!isObject(u)) return { _tag: "Invalid", reason: "Message is not an object" }
  const hasId = "id" in u
  if ("method" in u) {
    if (u.jsonrpc !== "2.0") return { _tag: "Invalid", reason: "jsonrpc must be \"2.0\"" }
    if (typeof u.method !== "string") return { _tag: "Invalid", reason: "method must be a string" }
    if ("params" in u && !isParams(u.params)) return { _tag: "Invalid", reason: "params must be structured" }
    if (!hasId) return { _tag: "Notification", method: u.method, params: u.params }
    if (!isRequestId(u.id)) return { _tag: "Invalid", reason: "Invalid request id" }
    return { _tag: "Request", id: u.id, method: u.method, params: u.params }
  }
  if ("result" in u || "error" in u) {
    if (!hasId || !isRequestId(u.id)) return { _tag: "InvalidResponse", id: undefined, reason: "Invalid response id" }
    if (u.jsonrpc !== "2.0") return { _tag: "InvalidResponse", id: u.id, reason: "jsonrpc must be \"2.0\"" }
    if ("result" in u && "error" in u) return { _tag: "InvalidResponse", id: u.id, reason: "Both result and error" }
    if ("result" in u) return { _tag: "Response", id: u.id, result: u.result }
    const error = u.error
    if (!isObject(error) || !Number.isInteger(error.code) || typeof error.message !== "string") {
      return { _tag: "InvalidResponse", id: u.id, reason: "Malformed error object" }
    }
    return { _tag: "ErrorResponse", id: u.id, error: error as unknown as ErrorObject }
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
