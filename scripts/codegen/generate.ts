/** Regenerates versioned wire schemas; --check verifies checked-in outputs. */
import * as BunServices from "@effect/platform-bun/BunServices"
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { emitModule, type EmitOptions } from "./emit.ts"
import { loadInput, loadManifest, root, type JsonSchemaDocument } from "./inputs.ts"

/** Converts emission diagnostics into the generator's typed failure channel. */
export const generateSource = (schema: JsonSchemaDocument, options: EmitOptions) => Effect.fromResult(emitModule(schema, options))

export const generateAll = Effect.gen(function*() {
  const manifest = yield* loadManifest()
  return yield* Effect.forEach(manifest.inputs, (input) => Effect.gen(function*() {
    const { schema } = yield* loadInput(input)
    return { output: input.output, source: yield* generateSource(schema, { manifest, input }) }
  }), { concurrency: "unbounded" })
})

export class GeneratedSchemaDrift extends Data.TaggedError("GeneratedSchemaDrift")<{
  readonly outputs: ReadonlyArray<string>
  readonly message: string
}> {
  constructor(outputs: ReadonlyArray<string>) {
    super({ outputs, message: `Generated schemas are out of date: ${outputs.join(", ")}\nRun \`bun run generate\` and review the diff.` })
  }
}

export const applyGenerated = (
  outputs: ReadonlyArray<{ readonly output: string; readonly source: string }>,
  check: boolean,
  base = root
) => Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const drifted: Array<string> = []
  for (const { output, source } of outputs) {
    const file = path.join(base, output)
    if (check) {
      const current = (yield* fs.exists(file)) ? yield* fs.readFileString(file) : ""
      if (current !== source) drifted.push(output)
    } else {
      yield* fs.writeFileString(file, source)
      yield* Effect.log(`wrote ${output}`)
    }
  }
  if (drifted.length > 0) return yield* new GeneratedSchemaDrift(drifted)
  if (check) yield* Effect.log("generated schemas are up to date")
})

const program = Effect.gen(function*() {
  const check = yield* Effect.sync(() => process.argv.includes("--check"))
  yield* applyGenerated(yield* generateAll, check)
})

if (import.meta.main) {
  BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)))
}
