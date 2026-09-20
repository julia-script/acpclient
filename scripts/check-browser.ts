/**
 * Browser import smoke check: bundles every package entry point for the
 * browser, refusing any Node/Bun or platform-package import, then evaluates
 * each bundle in a sandbox exposing only web globals.
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as vm from "node:vm"
import pkg from "../package.json"

const forbidden = /^(node:|bun$|bun:|fs$|path$|os$|child_process$|crypto$|stream$|net$|@effect\/platform-)/

const guard: Bun.BunPlugin = {
  name: "forbid-runtime-imports",
  setup(build) {
    build.onResolve({ filter: forbidden }, (args) => {
      throw new Error(`browser entry imports ${args.path} (from ${args.importer})`)
    })
  }
}

const sandboxGlobals = () => ({
  console,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  queueMicrotask,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  structuredClone,
  crypto: globalThis.crypto
})

const fs = Effect.runSync(Effect.provide(FileSystem.FileSystem, BunServices.layer))
const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const join = (...segments: string[]) => path.join(...segments)
const dir = await Effect.runPromise(fs.makeTempDirectory({ prefix: "acp-browser-" }))
const root = path.resolve(import.meta.dir, "..")
let failed = false

// The guard itself must reject a process import.
const probe = join(dir, "probe.ts")
await Effect.runPromise(fs.writeFileString(probe, `import "@effect/platform-bun/BunChildProcessSpawner"\n`))
const probed = await Bun.build({ entrypoints: [probe], target: "browser", plugins: [guard] }).then((r) => r.success, () => false)
if (probed) throw new Error("import guard did not reject a platform import")

const sourceExports = Object.fromEntries(Object.entries(pkg.exports).map(([name, target]) => [
  name, target.replace("./dist/", "./src/").replace(/\.js$/, ".ts")
]))
for (const [surface, exports] of Object.entries({ source: sourceExports, dist: pkg.exports })) {
  for (const [name, target] of Object.entries(exports)) {
    const entry = join(dir, `${surface}_${name.replaceAll(/[^\w]/g, "_") || "root"}.ts`)
    await Effect.runPromise(fs.writeFileString(entry, `import * as M from ${JSON.stringify(join(root, target))}\nglobalThis.__exports = Object.keys(M)\n`))
    const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", plugins: [guard] })
      .catch((error: unknown) => ({ success: false as const, logs: [error], outputs: [] }))
    if (!result.success) {
      failed = true
      Effect.runSync(Effect.logError(`✗ ${surface} ${name}:`, ...result.logs))
      continue
    }
    const context = vm.createContext(sandboxGlobals())
    try {
      vm.runInContext(await result.outputs[0]!.text(), context)
      const exported = await Effect.runPromise(Schema.decodeUnknownEffect(Schema.Array(Schema.String))(context.__exports))
      Effect.runSync(Effect.log(`✓ ${surface} ${name} (${exported.length} exports)`))
    } catch (error) {
      failed = true
      Effect.runSync(Effect.logError(`✗ ${surface} ${name}: evaluation failed`, error))
    }
  }

}

await Effect.runPromise(fs.remove(dir, { recursive: true }))
if (failed) process.exitCode = 1
