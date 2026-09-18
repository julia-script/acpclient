/**
 * Browser import smoke check: bundles every package entry point for the
 * browser, refusing any Node/Bun or platform-package import, then evaluates
 * each bundle in a sandbox exposing only web globals.
 */
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
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

const dir = await mkdtemp(join(tmpdir(), "acp-browser-"))
const root = resolve(import.meta.dir, "..")
let failed = false

// The guard itself must reject a process import.
const probe = join(dir, "probe.ts")
await writeFile(probe, `import "@effect/platform-bun/BunChildProcessSpawner"\n`)
const probed = await Bun.build({ entrypoints: [probe], target: "browser", plugins: [guard] }).then((r) => r.success, () => false)
if (probed) throw new Error("import guard did not reject a platform import")

for (const [name, target] of Object.entries(pkg.exports)) {
  const entry = join(dir, `${name.replaceAll(/[^\w]/g, "_") || "root"}.ts`)
  await writeFile(entry, `import * as M from ${JSON.stringify(join(root, target))}\nglobalThis.__exports = Object.keys(M)\n`)
  const result = await Bun.build({ entrypoints: [entry], target: "browser", format: "iife", plugins: [guard] })
    .catch((error: unknown) => ({ success: false as const, logs: [error], outputs: [] }))
  if (!result.success) {
    failed = true
    console.error(`✗ ${name}:`, ...result.logs)
    continue
  }
  const context = vm.createContext(sandboxGlobals())
  try {
    vm.runInContext(await result.outputs[0]!.text(), context)
    const exported = (context as { __exports?: Array<string> }).__exports
    if (!exported) throw new Error("module did not evaluate")
    console.log(`✓ ${name} (${exported.length} exports)`)
  } catch (error) {
    failed = true
    console.error(`✗ ${name}: evaluation failed`, error)
  }
}

if (failed) process.exit(1)
