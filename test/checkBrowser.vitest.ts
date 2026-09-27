import { fileURLToPath } from "node:url"
import { describe, expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | import("effect/Scope").Scope>) =>
  Effect.scoped(effect).pipe(Effect.provide(BunServices.layer))

describe("browser check executable", () => {
  it.live("importing the script does not start a check", () => Effect.sync(() => {
    const result = Bun.spawnSync([process.execPath, "-e", 'await import("./scripts/check-browser.ts")'], { cwd: fileURLToPath(new URL(".", import.meta.url)) + "/.." })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe("")
    expect(result.stderr.toString()).toBe("")
  }))

  it.live("a forbidden browser import fails the subprocess", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..")
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "acp-browser-fixture-" })
    yield* fs.makeDirectory(path.join(dir, "scripts"))
    yield* fs.makeDirectory(path.join(dir, "src"))
    yield* fs.makeDirectory(path.join(dir, "dist"))
    yield* fs.symlink(path.join(root, "node_modules"), path.join(dir, "node_modules"))
    yield* fs.writeFileString(path.join(dir, "package.json"), '{"exports":{"./Bad":"./dist/Bad.js"}}')
    yield* fs.writeFileString(path.join(dir, "src/Bad.ts"), 'import "node:fs"\nexport const bad = true\n')
    yield* fs.writeFileString(path.join(dir, "dist/Bad.js"), 'export const good = true\n')
    yield* fs.writeFileString(path.join(dir, "scripts/check-browser.ts"), yield* fs.readFileString(path.join(root, "scripts/check-browser.ts")))
    const result = Bun.spawnSync([process.execPath, "scripts/check-browser.ts"], { cwd: dir })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString() + result.stdout.toString()).toContain("browser entry imports node:fs")
  })))
})
