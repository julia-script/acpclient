/** Loads pinned upstream inputs and verifies their reviewed SHA-256 hashes. */
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
export const root = path.join(import.meta.dir, "..", "..")
export const manifestPath = path.join(import.meta.dir, "manifest.json")

export const ManifestInput = Schema.Struct({
  version: Schema.Int, surface: Schema.Literal("baseline"), path: Schema.String,
  sha256: Schema.String, output: Schema.String
})
export type ManifestInput = typeof ManifestInput.Type
export const Manifest = Schema.Struct({
  generator: Schema.String,
  upstream: Schema.Struct({ repository: Schema.String, revision: Schema.String }),
  inputs: Schema.Array(ManifestInput)
})
export type Manifest = typeof Manifest.Type
export interface LoadedInput { readonly input: ManifestInput; readonly schema: JsonSchemaDocument }
export interface JsonSchemaDocument { readonly $defs: Record<string, unknown>; readonly [key: string]: unknown }
const Document = Schema.Struct({ $defs: Schema.Record(Schema.String, Schema.Unknown) })

export const loadManifest = (file = manifestPath) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  return yield* Schema.decodeEffect(Schema.fromJsonString(Manifest))(yield* fs.readFileString(file))
})
export const sha256 = (bytes: Uint8Array) => Effect.gen(function*() {
  const crypto = yield* Crypto.Crypto
  return Encoding.encodeHex(yield* crypto.digest("SHA-256", bytes))
})
export class InputHashMismatch extends Data.TaggedError("InputHashMismatch")<{
  readonly path: string; readonly expected: string; readonly actual: string; readonly message: string
}> {
  constructor(path: string, expected: string, actual: string) {
    super({ path, expected, actual, message: `Pinned schema input ${path} has SHA-256 ${actual}, expected ${expected}. Update the manifest deliberately after reviewing the upstream change.` })
  }
}
/** Reads one input relative to base, verifying its hash before parsing. */
export const loadInput = (input: ManifestInput, base = root) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const bytes = yield* fs.readFile(path.join(base, input.path))
  const actual = yield* sha256(bytes)
  if (actual !== input.sha256) return yield* new InputHashMismatch(input.path, input.sha256, actual)
  const schema = yield* Schema.decodeEffect(Schema.fromJsonString(Document))(new TextDecoder().decode(bytes))
  return { input, schema }
})
