import { expect, test } from "bun:test"
import { join } from "node:path"

const root = join(import.meta.dir, "..")
const runExample = (file: string) => Bun.spawnSync(["bun", join(root, "examples", file)], { cwd: root, timeout: 20_000 })

test("stdio example negotiates v2 and prompts", () => {
  const result = runExample("stdio-client.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("negotiated ACP v2")
  expect(result.stdout.toString()).toContain("prompt accepted as m-1")
}, 30_000)

test("custom transport example connects over a MessagePort", () => {
  const result = runExample("custom-transport.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("connected over MessagePort using ACP v1")
}, 30_000)
