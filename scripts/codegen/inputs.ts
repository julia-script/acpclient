/**
 * Loads the pinned upstream schema inputs listed in `manifest.json` and refuses
 * any input whose bytes differ from the recorded SHA-256.
 */
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

export interface ManifestInput {
  readonly version: number
  readonly surface: "baseline"
  readonly path: string
  readonly sha256: string
  readonly output: string
}

export interface Manifest {
  readonly generator: string
  readonly upstream: { readonly repository: string; readonly revision: string }
  readonly inputs: ReadonlyArray<ManifestInput>
}

export interface LoadedInput {
  readonly input: ManifestInput
  readonly schema: JsonSchemaDocument
}

export interface JsonSchemaDocument {
  readonly $defs: Record<string, unknown>
  readonly [key: string]: unknown
}

export const root = join(import.meta.dir, "..", "..")
export const manifestPath = join(import.meta.dir, "manifest.json")

export const loadManifest = async (path = manifestPath): Promise<Manifest> =>
  JSON.parse(await readFile(path, "utf8")) as Manifest

export const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex")

export class InputHashMismatch extends Error {
  constructor(readonly path: string, readonly expected: string, readonly actual: string) {
    super(`Pinned schema input ${path} has SHA-256 ${actual}, expected ${expected}. Update the manifest deliberately after reviewing the upstream change.`)
  }
}

/** Reads one input relative to `base`, verifying its hash before parsing. */
export const loadInput = async (input: ManifestInput, base = root): Promise<LoadedInput> => {
  const bytes = await readFile(join(base, input.path))
  const actual = sha256(bytes)
  if (actual !== input.sha256) throw new InputHashMismatch(input.path, input.sha256, actual)
  const schema = JSON.parse(new TextDecoder().decode(bytes)) as JsonSchemaDocument
  if (typeof schema.$defs !== "object" || schema.$defs === null) {
    throw new Error(`Pinned schema input ${input.path} has no $defs`)
  }
  return { input, schema }
}
