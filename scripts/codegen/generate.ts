/** Regenerates versioned wire schemas; --check verifies checked-in outputs. */
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { emitModule } from "./emit.ts"
import { loadInput, loadManifest, root } from "./inputs.ts"

export const generateAll = Effect.gen(function*() {
  const manifest = yield* loadManifest()
  return yield* Effect.forEach(manifest.inputs, (input) => Effect.gen(function*() {
    const { schema } = yield* loadInput(input)
    return { output: input.output, source: emitModule(schema, { manifest, input }) }
  }), { concurrency: "unbounded" })
})

if (import.meta.main) {
  await Effect.runPromise(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const check = process.argv.includes("--check")
    const outputs = yield* generateAll
    const drifted: Array<string> = []
    for (const { output, source } of outputs) {
      const file = path.join(root, output)
      if (check) {
        const current = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.void))
        if (current !== source) drifted.push(output)
      } else {
        yield* fs.writeFileString(file, source)
        yield* Effect.log(`wrote ${output}`)
      }
    }
    if (drifted.length > 0) {
      yield* Effect.logError(`Generated schemas are out of date: ${drifted.join(", ")}\nRun \`bun run generate\` and review the diff.`).pipe(Effect.provide(Logger.layer([Logger.withConsoleError(Logger.formatSimple)])))
      process.exitCode = 1
    } else if (check) yield* Effect.log("generated schemas are up to date")
  }).pipe(Effect.provide(BunServices.layer)))
}
