import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Cause from "effect/Cause"
import * as Exit from "effect/Exit"
import { describe, expect, test } from "bun:test"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as BunServices from "@effect/platform-bun/BunServices"
import { failure } from "./support/failure.ts"
import { emitModule, UnknownOverrideError, UnsupportedSchemaError } from "../scripts/codegen/emit.ts"
import { applyGenerated, generateAll, generateSource, GeneratedSchemaDrift } from "../scripts/codegen/generate.ts"
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

  const options = {
    manifest: { generator: "test", upstream: { repository: "test", revision: "test" } },
    input: { version: 9, surface: "baseline", path: "fixture.json", sha256: "0", output: "x.ts" },
    overrides: { 9: { Overridden: { reason: "fixture", ts: "string", schema: "Schema.String" } } }
  } as const
  const document = (defs: Record<string, unknown>) => ({ $defs: { Overridden: { type: "number" }, ...envelopes, ...defs } })
  const emit = (defs: Record<string, unknown>) => emitModule(document(defs), options)
  const envelopes = Object.fromEntries(
    ["ClientRequest", "AgentRequest", "AgentResponse", "ClientResponse", "ClientNotification", "AgentNotification"].map((n) => [n, {}])
  )

  test("unsupported constructs return structured diagnostics", () => {
    for (const [defs, definition, construct] of [
      [{ Name: { type: "string", maxLength: 3 } }, "Name", "maxLength"],
      [{ Obj: { type: "object", properties: { a: { if: {} } } } }, "Obj", "if"],
      [{ Loose: { unevaluatedProperties: false, type: "object" } }, "Loose", "unevaluatedProperties"],
      [{ Untyped: { properties: { a: {} } } }, "Untyped", "properties"],
      [{ Missing: { $ref: "#/$defs/Absent" } }, "Missing", "$ref"]
    ] as const) {
      const result = emit(defs)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isSuccess(result)) throw new Error("Expected generator diagnostic")
      expect(result.failure).toBeInstanceOf(UnsupportedSchemaError)
      expect(result.failure).toMatchObject({ _tag: "UnsupportedSchemaError", definition, construct })
    }
  })

  test("annotations and extensions are ignored; overrides replace emission", () => {
    const result = emit({ Name: { type: "string", format: "uri", description: "d", "x-anything": 1 } })
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) throw result.failure
    const source = result.success
    expect(source).toContain(`export const Name = Wire.def<Name>("Name", Schema.String)`)
    expect(source).toContain(`// Reviewed override: fixture`)
    expect(source).toContain(`export const Overridden = Wire.def<Overridden>("Overridden", Schema.String)`)
    expect(Result.isSuccess(emit({}))).toBe(true)
  })

  test("schema names and property keys never resolve through prototypes", () => {
    const missing = emit({ Ref: { $ref: "#/$defs/toString" } })
    expect(Result.isFailure(missing)).toBe(true)
    if (Result.isSuccess(missing)) throw new Error("Expected unknown reference")
    expect(missing.failure).toMatchObject({ _tag: "UnsupportedSchemaError", definition: "Ref", construct: "$ref" })

    const names = emit(Object.fromEntries([
      ["constructor", { type: "string" }],
      ["toString", { type: "string" }],
      ["__proto__", { type: "object", properties: Object.fromEntries([["__proto__", { type: "string" }]]) }],
      ["Required", { type: "object", required: ["constructor"] }],
      ["Ref", { $ref: "#/$defs/constructor" }]
    ]))
    expect(Result.isSuccess(names)).toBe(true)
    if (Result.isFailure(names)) throw names.failure
    expect(names.success).toContain("readonly constructor: unknown")
    expect(names.success).toContain("readonly [\"__proto__\"]?: string")
    expect(names.success).toContain("[\"__proto__\"]: Schema.optionalKey(Schema.String)")
    expect(names.success).toContain("export const Ref = Wire.def<Ref>(\"Ref\", constructor)")

    const method = emit({
      ClientRequest: { $ref: "#/$defs/Request" },
      AgentResponse: { $ref: "#/$defs/Response" },
      Request: { type: "object", "x-method": "__proto__", "x-side": "client" },
      Response: { type: "object", "x-method": "__proto__", "x-side": "client" }
    })
    expect(Result.isSuccess(method)).toBe(true)
    if (Result.isFailure(method)) throw method.failure
    expect(method.success).toContain("[\"__proto__\"]: AcpSchema.request(\"__proto__\", Request, Response)")
  })

  test("a stale override is a typed diagnostic with its definition and version", () => {
    const result = emitModule({ $defs: envelopes }, {
      manifest: { generator: "t", upstream: { repository: "t", revision: "t" } },
      input: { version: 9, surface: "baseline", path: "f", sha256: "0", output: "x" },
      overrides: { 9: { Gone: { reason: "r", ts: "string", schema: "Schema.String" } } }
    })
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isSuccess(result)) throw new Error("Expected stale override diagnostic")
    expect(result.failure).toBeInstanceOf(UnknownOverrideError)
    expect(result.failure).toMatchObject({ _tag: "UnknownOverrideError", definition: "Gone", version: 9 })
  })

  test("generator effects fail through their typed channel", () => run(Effect.gen(function*() {
    const error = yield* failure(generateSource(document({ Name: { type: "string", maxLength: 3 } }), options))
    expect(error).toMatchObject({ _tag: "UnsupportedSchemaError", definition: "Name", construct: "maxLength" })
  })))

  test("unexpected emitter defects remain defects", () => run(Effect.gen(function*() {
    const defect = new Error("broken fixture getter")
    const definitions = { Overridden: { type: "number" }, ...envelopes }
    Object.defineProperty(definitions, "Broken", { enumerable: true, get: () => { throw defect } })
    expect(() => emitModule({ $defs: definitions }, options)).toThrow(defect)
    const exit = yield* Effect.exit(Effect.suspend(() => generateSource({ $defs: definitions }, options)))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isSuccess(exit)) throw new Error("Expected generator defect")
    expect(Result.isFailure(Cause.findError(exit.cause))).toBe(true)
    const found = Cause.findDefect(exit.cause)
    expect(Result.isSuccess(found)).toBe(true)
    if (Result.isSuccess(found)) expect(found.success).toBe(defect)
  })))

  test("drift and missing outputs fail through the typed channel without changing files", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "acp-codegen-output-" })
    yield* fs.writeFileString(join(dir, "stale.ts"), "old")
    const error = yield* failure(applyGenerated([
      { output: "stale.ts", source: "new" },
      { output: "missing.ts", source: "new" }
    ], true, dir))
    expect(error).toBeInstanceOf(GeneratedSchemaDrift)
    expect(error).toMatchObject({ outputs: ["stale.ts", "missing.ts"] })
    expect(yield* fs.readFileString(join(dir, "stale.ts"))).toBe("old")
  })))

  test("the executable edge exits on typed drift and unexpected defects", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "acp-codegen-process-" })
    const source = [
      `import * as BunRuntime from "@effect/platform-bun/BunRuntime"`,
      `import * as BunServices from "@effect/platform-bun/BunServices"`,
      `import * as Effect from "effect/Effect"`,
      `import { applyGenerated } from "${join(root, "scripts/codegen/generate.ts")}"`,
      `const output = process.argv.includes("--defect") ? Object.defineProperty({}, "output", { enumerable: true, get() { throw new Error("fixture defect") } }) : { output: "missing.ts", source: "new" }`,
      `BunRuntime.runMain(Effect.suspend(() => applyGenerated([output as { output: string; source: string }], true, process.env.A27_BASE!)).pipe(Effect.provide(BunServices.layer)))`
    ].join("\n")
    const entry = join(dir, "process.ts")
    yield* fs.symlink(join(root, "node_modules"), join(dir, "node_modules"))
    yield* fs.writeFileString(entry, source)
    const env = { ...process.env, A27_BASE: dir }
    const drift = Bun.spawnSync(["bun", entry], { cwd: root, env })
    expect(drift.exitCode).toBe(1)
    expect(drift.stderr.toString() + drift.stdout.toString()).toContain("GeneratedSchemaDrift")
    const defect = Bun.spawnSync(["bun", entry, "--defect"], { cwd: root, env })
    expect(defect.exitCode).toBe(1)
    expect(defect.stderr.toString() + defect.stdout.toString()).toContain("fixture defect")
    expect(defect.stderr.toString() + defect.stdout.toString()).not.toContain("GeneratedSchemaDrift")
  })))

  test("drift check fails on a stale output", () => run(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const { output } = ((yield* generateAll))[0]!
    const path = join(root, output)
    const original = (yield* fs.readFileString(path))
    try {
      yield* fs.writeFileString(path, original + "// drift\n")
      const run = Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString() + run.stdout.toString()).toContain(output)
    } finally {
      yield* fs.writeFileString(path, original)
    }
    expect(Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root }).exitCode).toBe(0)
  })))
})
