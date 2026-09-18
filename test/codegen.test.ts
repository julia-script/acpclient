import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { emitModule, UnsupportedSchemaError } from "../scripts/codegen/emit.ts"
import { generateAll } from "../scripts/codegen/generate.ts"
import { InputHashMismatch, loadInput, loadManifest, root, sha256 } from "../scripts/codegen/inputs.ts"

describe("schema provenance", () => {
  test("manifest hashes match the reviewed hashes in ARCHITECTURE.md and the vendored files", async () => {
    const manifest = await loadManifest()
    const architecture = await readFile(join(root, "ARCHITECTURE.md"), "utf8")
    for (const input of manifest.inputs) {
      const relative = input.path.replace("repos/agent-client-protocol/", "")
      const recorded = new RegExp(`${relative.replaceAll(".", "\\.")}\\s+([0-9a-f]{64})`).exec(architecture)?.[1]
      expect(recorded).toBe(input.sha256)
      const loaded = await loadInput(input)
      expect(Object.keys(loaded.schema.$defs).length).toBeGreaterThan(100)
    }
  })

  test("an altered input is rejected", async () => {
    const manifest = await loadManifest()
    const input = manifest.inputs[0]!
    const dir = await mkdtemp(join(tmpdir(), "acp-codegen-"))
    const original = await readFile(join(root, input.path), "utf8")
    const altered = original.replace(`"type": "string"`, `"type": "number"`)
    await Bun.write(join(dir, input.path), altered)
    const error = await loadInput(input, dir).catch((e) => e)
    expect(error).toBeInstanceOf(InputHashMismatch)
    expect(error.actual).toBe(sha256(new TextEncoder().encode(altered)))
  })
})

describe("generation", () => {
  test("repeated generation is identical and matches checked-in outputs", async () => {
    const first = await generateAll()
    const second = await generateAll()
    expect(second).toEqual(first)
    for (const { output, source } of first) {
      expect(await readFile(join(root, output), "utf8")).toBe(source)
      expect(source).toContain(`export const provenance`)
    }
  })

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
    expect(source).toContain(`export const Name = W.def<Name>("Name", Schema.String)`)
    expect(source).toContain(`// Reviewed override: fixture`)
    expect(source).toContain(`export const Overridden = W.def<Overridden>("Overridden", Schema.String)`)
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

  test("drift check fails on a stale output", async () => {
    const { output } = (await generateAll())[0]!
    const path = join(root, output)
    const original = await readFile(path, "utf8")
    try {
      await writeFile(path, original + "// drift\n")
      const run = Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root })
      expect(run.exitCode).toBe(1)
      expect(run.stderr.toString()).toContain(output)
    } finally {
      await writeFile(path, original)
    }
    expect(Bun.spawnSync(["bun", "scripts/codegen/generate.ts", "--check"], { cwd: root }).exitCode).toBe(0)
  })
})
