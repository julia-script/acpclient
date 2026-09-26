import * as Effect from "effect/Effect"
import { expect, test } from "bun:test"
import * as Path from "effect/Path"
import { resolveLaunchProfile } from "../examples/bridge-server.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const join = (...segments: string[]) => path.join(...segments)

const root = join(import.meta.dir, "..")
const runExample = (file: string, args: ReadonlyArray<string> = []) =>
  Bun.spawnSync(["bun", join(root, "examples", file), ...args], { cwd: root, timeout: 20_000 })

test("bridge example resolves only own launch profiles", () => {
  const command = { name: "demo" }
  const profiles = { demo: command }
  expect(resolveLaunchProfile(profiles, "demo")).toBe(command)
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(resolveLaunchProfile(profiles, name)).toBeUndefined()
  }
})

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

test("bridge example relays a prompt from a WebSocket client to a spawned agent", () => {
  const result = runExample("bridge-server.ts")
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("bridged ACP v2")
  expect(output).toContain("bridged prompt accepted as m-1")
}, 30_000)

test("session client example drives a v2 agent through prompt and permission", () => {
  const result = runExample("session-client.ts")
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v2")
  expect(output).toContain("prompt accepted as m-1")
  expect(output).toContain("allowing: ")
  expect(output).toContain(`state: "idle"`)
  // v2 messages carry agent identities.
  expect(output).toContain("agent(agent): thinking")
}, 30_000)

test("session client example reports v1 limitations honestly", () => {
  const result = runExample("session-client.ts", ["bun", join(root, "test", "fixtures", "agent.ts"), "1"])
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v1")
  // v1 has no insertion acknowledgement, and no agent message identities.
  expect(output).toContain("v1 has no acceptance to report")
  expect(output).toContain("agent(local): thinking")
}, 30_000)

test("the example agent serves the example client over its own stdio", () => {
  // The client spawns the agent: both examples exercised, end to end, with no
  // model credentials and nothing but ACP on the agent's stdout.
  const result = runExample("stdio-client.ts", ["bun", join(root, "examples", "echo-agent.ts")])
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v2")
  expect(output).toMatch(/prompt accepted as msg-\d+/)
}, 30_000)

test("hosted gateway restores permission and streaming across browser socket refreshes", () => {
  const result = runExample("hosted-server.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("permission and streaming restored; one ACP initialization")
}, 30_000)

test("bridge relays v1 permission, notifications, errors and batches over the real route", () => {
  const result = runExample("bridge-server.ts", ["1"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("bridged turn completed: end_turn")
  expect(result.stdout.toString()).toContain("errors and batches relayed")
}, 30_000)
