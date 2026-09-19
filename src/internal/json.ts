/** JSON syntax codecs. Callers handle failures in Effect or Result. */
import * as Schema from "effect/Schema"
import * as Result from "effect/Result"

const JsonText = Schema.fromJsonString(Schema.Unknown)

export const encode = Schema.encodeUnknownEffect(JsonText)
const ParsedJson = Schema.fromJsonString(Schema.Json)
export const decode = Schema.decodeEffect(ParsedJson)
export const encodeResult = Schema.encodeUnknownResult(JsonText)
export const decodeResult = Schema.decodeResult(ParsedJson)
export const byteLength = (value: unknown) =>
  Result.map(encodeResult(value), (text) => new TextEncoder().encode(text).byteLength)
