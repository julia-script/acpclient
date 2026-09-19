import * as Effect from "effect/Effect"
import { describe, expect, test } from "bun:test"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { failure } from "./support/failure.ts"
import { emitModule, UnsupportedSchemaError } from "../scripts/codegen/emit.ts"
import { generateAll } from "../scripts/codegen/generate.ts"
import { InputHashMismatch, loadInput, loadManifest, root, sha256 } from "../scripts/codegen/inputs.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const join = (...segments: string[]) => path.join(...segments)
const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices | import("effect/Scope").Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(BunServices.layer)))

describe("schema provenance", () => {
  test("manifest hashes match the reviewed hashes in ARCHITECTURE.md and the vendored files", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const manifest = (yield* loadManifest())
    const architecture = (yield* fs.readFileString(join(root, "ARCHITECTURE.md")))
    for (const input of manifest.inputs) {
      const relative = input.path.replace("repos/agent-client-protocol/", "")
      const recorded = new RegExp(`${relative.replaceAll(".", "\\.")}\\s+([0-9a-f]{64})`).exec(architecture)?.[1]
      expect(recorded).toBe(input.sha256)
      const loaded = (yield* loadInput(input))
      expect(Object.keys(loaded.schema.$defs).length).toBeGreaterThan(100)
    }
  })))

  test("an altered input is rejected", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const manifest = (yield* loadManifest())
    const input = manifest.inputs[0]!
    const dir = (yield* fs.makeTempDirectoryScoped({ prefix: "acp-codegen-" }))
    const original = (yield* fs.readFileString(join(root, input.path)))
    const altered = original.replace(`"type": "string"`, `"type": "number"`)
    yield* fs.makeDirectory(path.dirname(join(dir, input.path)), { recursive: true })
    yield* fs.writeFileString(join(dir, input.path), altered)
    const error = (yield* failure(loadInput(input, dir)))
    expect(error).toBeInstanceOf(InputHashMismatch)
    expect(error._tag).toBe("InputHashMismatch")
    if (error._tag !== "InputHashMismatch") throw new Error("Expected hash mismatch")
    expect(error.actual).toBe(yield* sha256(new TextEncoder().encode(altered)))
  })))
})

describe("generation", () => {
  test("repeated generation is identical and matches checked-in outputs", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const first = (yield* generateAll)
    const second = (yield* generateAll)
    expect(second).toEqual(first)
    for (const { output, source } of first) {
      expect((yield* fs.readFileString(join(root, output)))).toBe(source)
      expect(source).toContain(`export const provenance`)
    }
  })))

  const emit = (defs: Record<string, unknown>) =>
    emitModule({ $defs: { Overridden: { type: "number" }, ...envelopes, ...defs } }, {
      manifest: { generator: "test", upstream: { repository: "test", revision: "test" } },
      input: { version: 9, surface: "baseline", path: "fixture.json", sha256: "0", output: "x.ts" },
      overrides: { 9: { Overridden: { reason: "fixture", ts: "string", schema: "Schema.String" } } }
    })
  const envelopes = Object.fromEntries(
    ["ClientRequest", "AgentRequest", "AgentResponse", "ClientResponse", "ClientNotification", "AgentNotification"].map((n) => [n, {}])
  )

  test("unsupported validation keywords fail with the definition named", () => {
    expect(() => emit({ Name: { type: "string", maxLength: 3 } })).toThrow(UnsupportedSchemaError)
    expect(() => emit({ Name: { type: "string", maxLength: 3 } })).toThrow(/"maxLength" in definition Name/)
    expect(() => emit({ Obj: { type: "object", properties: { a: { if: {} } } } })).toThrow(/"if" in definition Obj/)
    expect(() => emit({ Loose: { unevaluatedProperties: false, type: "object" } })).toThrow(/unevaluatedProperties/)
    expect(() => emit({ Untyped: { properties: { a: {} } } })).toThrow(/"properties" in definition Untyped/)
  })

  test("annotations and extensions are ignored; overrides replace emission", () => {
    const source = emit({ Name: { type: "string", format: "uri", description: "d", "x-anything": 1 } })
    expect(source).toContain(`export const Name = Wire.def<Name>("Name", Schema.String)`)
    expect(source).toContain(`// Reviewed override: fixture`)
    expect(source).toContain(`export const Overridden = Wire.def<Overridden>("Overridden", Schema.String)`)
    expect(() => emit({})).not.toThrow()
  })

  test("an override for a definition that disappeared fails", () => {
    expect(() =>
      emitModule({ $defs: envelopes }, {
        manifest: { generator: "t", upstream: { repository: "t", revision: "t" } },
        input: { version: 9, surface: "baseline", path: "f", sha256: "0", output: "x" },
        overrides: { 9: { Gone: { reason: "r", ts: "string", schema: "Schema.String" } } }
      })
    ).toThrow(/unknown definition Gone/)
  })

  test("drift check fails on a stale output", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { output } = ((yield* generateAll))[0]!
    const path = join(root, output)
    const original = (yield* fs.readFileString(path))
    try {
      yield* fs.writeFileString(path, original + "// drift\n")
      const run = Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString()).toContain(output)
    } finally {
      yield* fs.writeFileString(path, original)
    }
    expect(Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root }).exitCode).toBe(0)
  })))
})
