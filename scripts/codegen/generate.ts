/**
 * Regenerates the versioned wire schema modules from the pinned inputs.
 *
 *   bun scripts/codegen/generate.ts          write outputs
 *   bun scripts/codegen/generate.ts --check  fail if checked-in outputs drift
 */
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { emitModule } from "./emit.ts"
import { loadInput, loadManifest, root } from "./inputs.ts"

export const generateAll = async (): Promise<ReadonlyArray<{ readonly output: string; readonly source: string }>> => {
  const manifest = await loadManifest()
  return Promise.all(manifest.inputs.map(async (input) => {
    const { schema } = await loadInput(input)
    return { output: input.output, source: emitModule(schema, { manifest, input }) }
  }))
}

if (import.meta.main) {
  const check = process.argv.includes("--check")
  const outputs = await generateAll()
  const drifted: Array<string> = []
  for (const { output, source } of outputs) {
    const path = join(root, output)
    if (check) {
      const current = await readFile(path, "utf8").catch(() => undefined)
      if (current !== source) drifted.push(output)
    } else {
      await writeFile(path, source)
      console.log(`wrote ${output}`)
    }
  }
  if (drifted.length > 0) {
    console.error(`Generated schemas are out of date: ${drifted.join(", ")}\nRun \`bun run generate\` and review the diff.`)
    process.exit(1)
  }
  if (check) console.log("generated schemas are up to date")
}
