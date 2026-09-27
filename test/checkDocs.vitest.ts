import { fileURLToPath } from "node:url"
import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"

it.live("documentation checker reports malformed URI escapes as a diagnostic", () =>
  Effect.scoped(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-docs-" })
    yield* fs.makeDirectory(path.join(root, "scripts"))
    yield* fs.makeDirectory(path.join(root, "docs"))
    yield* fs.copyFile(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../scripts/check-docs.ts"), path.join(root, "scripts/check-docs.ts"))
    yield* fs.symlink(path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../node_modules"), path.join(root, "node_modules"))
    yield* fs.writeFileString(path.join(root, "README.md"), "[bad](bad%ZZ.md)\n")
    const child = Bun.spawn([process.execPath, path.join(root, "scripts/check-docs.ts")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe"
    })
    const [status, stderr, stdout] = yield* Effect.promise(() => Promise.all([
      child.exited,
      new Response(child.stderr).text(),
      new Response(child.stdout).text()
    ]))
    expect(status).not.toBe(0)
    expect(stderr + stdout).toContain("README.md: invalid link URI bad%ZZ.md")
  })).pipe(Effect.provide(BunServices.layer))
)
