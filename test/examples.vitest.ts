import { fileURLToPath } from "node:url"
import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { resolveLaunchProfile } from "../examples/bridge-server.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const join = (...segments: string[]) => path.join(...segments)

const root = join(fileURLToPath(new URL(".", import.meta.url)), "..")
// These examples launch real Bun subprocesses, so their tests use live services.
const runExample = (file: string, args: ReadonlyArray<string> = []) =>
  Bun.spawnSync([process.execPath, join(root, "examples", file), ...args], { cwd: root, timeout: 20_000 })

it.live("executable examples can be imported without starting their runtime", () => Effect.sync(() => {
  for (const file of [
    "../examples/echo-agent.ts",
    "../examples/custom-transport.ts",
    "../examples/hosted-server.ts",
    "../docs/examples/first-session.ts",
    "../docs/examples/hosted-reconnect.ts"
  ]) {
    const url = new URL(file, import.meta.url)
    const result = Bun.spawnSync([process.execPath, "-e", `await import(process.env.EXAMPLE_IMPORT_URL); console.log("imported")`], {
      cwd: root,
      env: { ...process.env, EXAMPLE_IMPORT_URL: url.href },
      timeout: 5_000
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString().trim()).toBe("imported")
  }
}), 20_000)

it("bridge example resolves only own launch profiles", () => {
  const command = { name: "demo" }
  const profiles = { demo: command }
  expect(resolveLaunchProfile(profiles, "demo")).toBe(command)
  for (const name of ["constructor", "toString", "__proto__"]) {
    expect(resolveLaunchProfile(profiles, name)).toBeUndefined()
  }
})

it.live("stdio example negotiates v2 and prompts", () => Effect.sync(() => {
  const result = runExample("stdio-client.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("negotiated ACP v2")
  expect(result.stdout.toString()).toContain("prompt accepted as m-1")
}), 30_000)

it.live("custom transport example connects over a MessagePort", () => Effect.sync(() => {
  const result = runExample("custom-transport.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("connected over MessagePort using ACP v1")
}), 30_000)

it.live("bridge example relays a prompt from a WebSocket client to a spawned agent", () => Effect.sync(() => {
  const result = runExample("bridge-server.ts")
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("bridged ACP v2")
  expect(output).toContain("bridged prompt accepted as m-1")
}), 30_000)

it.live("session client example drives a v2 agent through prompt and permission", () => Effect.sync(() => {
  const result = runExample("session-client.ts")
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v2")
  expect(output).toContain("prompt accepted as m-1")
  expect(output).toContain("allowing: ")
  expect(output).toContain(`state: "idle"`)
  // v2 messages carry agent identities.
  expect(output).toContain("agent(agent): thinking")
}), 30_000)

it.live("session client example reports v1 limitations honestly", () => Effect.sync(() => {
  const result = runExample("session-client.ts", [process.execPath, join(root, "test", "fixtures", "agent.ts"), "1"])
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v1")
  // v1 has no insertion acknowledgement, and no agent message identities.
  expect(output).toContain("v1 has no acceptance to report")
  expect(output).toContain("agent(local): thinking")
}), 30_000)

it.live("the example agent serves the example client over its own stdio", () => Effect.sync(() => {
  // The client spawns the agent: both examples exercised, end to end, with no
  // model credentials and nothing but ACP on the agent's stdout.
  const result = runExample("stdio-client.ts", [process.execPath, join(root, "examples", "echo-agent.ts")])
  expect(result.exitCode).toBe(0)
  const output = result.stdout.toString()
  expect(output).toContain("negotiated ACP v2")
  expect(output).toMatch(/prompt accepted as msg-\d+/)
}), 30_000)

it.live("hosted gateway restores permission and streaming across browser socket refreshes", () => Effect.sync(() => {
  const result = runExample("hosted-server.ts")
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("permission and streaming restored; one ACP initialization")
}), 30_000)

it.live("bridge relays v1 permission, notifications, errors and batches over the real route", () => Effect.sync(() => {
  const result = runExample("bridge-server.ts", ["1"])
  expect(result.exitCode).toBe(0)
  expect(result.stdout.toString()).toContain("bridged turn completed: end_turn")
  expect(result.stdout.toString()).toContain("errors and batches relayed")
}), 30_000)
