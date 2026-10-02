/** Verify the tarball from an isolated consumer without repository path aliases. */
import assert from "node:assert/strict"
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Keep the package consumer check runnable with standalone Node.
import { spawnSync } from "node:child_process"
// oxlint-disable-next-line effecttsgo/node-builtin-import -- Use Node directly to isolate package checks from Effect platform services.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
// oxlint-disable-next-line effecttsgo/node-builtin-import -- This is a standalone Node packaging script.
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const temp = await mkdtemp(join(tmpdir(), "effect-acp-package-"))
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"))

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

try {
  // The caller builds first; skip lifecycle hooks while inspecting the tarball.
  const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", temp], root))
  const paths = new Set(packed.files.map((file) => file.path))
  assert.equal(pkg.name, "effect-acp")
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
  for (const path of ["LICENSE", "README.md", "package.json"]) assert(paths.has(path), `Missing ${path}`)
  for (const [name, target] of Object.entries(pkg.exports)) {
    for (const path of [target.types, target.default]) assert(paths.has(path.replace(/^\.\//, "")), `Missing ${name}: ${path}`)
  }
  for (const path of paths) {
    assert(/^(dist\/|src\/|LICENSE$|README\.md$|CHANGELOG\.md$|package\.json$)/.test(path), `Unexpected packed file: ${path}`)
    assert(!/\.(test|spec)\.[cm]?[jt]s$/.test(path), `Packed test: ${path}`)
  }

  await writeFile(join(temp, "package.json"), JSON.stringify({
    private: true,
    type: "module",
    dependencies: {
      "effect-acp": `file:${join(temp, packed.filename)}`,
      effect: pkg.peerDependencies.effect,
      typescript: pkg.devDependencies.typescript
    }
  }))
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], temp)
  const imports = Object.keys(pkg.exports).map((name) => name === "." ? pkg.name : `${pkg.name}${name.slice(1)}`)
  await writeFile(join(temp, "consumer.mjs"), imports.map((name) => `await import(${JSON.stringify(name)})`).join("\n"))
  run(process.execPath, ["consumer.mjs"], temp)
  await writeFile(join(temp, "consumer.ts"), imports.map((name, index) => `export * as Entry${index} from ${JSON.stringify(name)}`).join("\n"))
  for (const resolution of ["NodeNext", "Bundler"]) {
    await writeFile(join(temp, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        lib: ["ESNext", "DOM"],
        types: [],
        module: resolution === "NodeNext" ? "NodeNext" : "ESNext",
        moduleResolution: resolution
      },
      files: ["consumer.ts"]
    }))
    run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"], temp)
  }
  process.stdout.write(`Verified ${pkg.name}@${pkg.version}: ${paths.size} packed files, ${imports.length} Node imports and TypeScript exports (NodeNext and Bundler)\n`)
} finally {
  await rm(temp, { recursive: true, force: true })
}
