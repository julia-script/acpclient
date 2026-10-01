import * as AcpConnector from "../src/AcpConnector.ts"
import { expect, it } from "@effect/vitest"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ChildProcess from "effect/process/ChildProcess"
import { AcpClient } from "../src/AcpClient.ts"
import * as Host from "../src/AcpHost.ts"
import * as GC from "../src/AcpGatewayClient.ts"
import * as Local from "../src/AcpLocalClient.ts"
import * as Remote from "../src/AcpRemoteClient.ts"
import * as Stdio from "../src/transport/Stdio.ts"
import { failure } from "./support/failure.ts"
import { apiFor, policy } from "./support/host.ts"
const harness = Effect.gen(function*() {
  // Real subprocess scheduling needs room for release to reach the host before retention starts.
  const host = yield* Host.make({ policy: { ...policy, retentionMs: 500, shutdownMs: 100 }, authorize: () => Effect.void,
    open: (_identity, _workspace, _profile, _options, enforced) => Effect.gen(function*() {
      const client = yield* AcpClient
      return yield* client.connect({ versions: [2], params: { info: { name: "test", version: "1" } }, ...enforced })
    }).pipe(Effect.provide(Local.layer.pipe(Layer.provide(AcpConnector.layer(Stdio.layer(ChildProcess.make("bun", [new URL("./fixtures/agent.ts", import.meta.url).pathname, "2", "ignore-close"]))))))) })
  const gateway = yield* GC.fromApi(apiFor(host), { workspace: "work", storage: GC.memoryStorage() })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  const connection = yield* remote.connect({ versions: [2], params: { info: { name: "test", version: "1" } } })
  return { connection, gateway }
})
const run = <A,E>(effect: Effect.Effect<A,E,import("effect/Scope").Scope | import("effect/process/ChildProcessSpawner").ChildProcessSpawner>) => Effect.scoped(effect).pipe(Effect.provide(BunServices.layer), Effect.timeout("10 seconds"))

it.live("a real subprocess crash records outcomeUnknown and terminates connection waits", () => run(Effect.gen(function*() {
  const h = yield* harness
  expect(yield* failure(h.connection.request("_fixture/crash", {}))).toMatchObject({ code: "OutcomeUnknown" })
  expect((yield* h.connection.closed)._tag).toBe("AcpConnectionClosed")
  const operations = yield* h.gateway.pendingOperations
  expect((yield* h.gateway.retry(operations[operations.length - 1]!)).status).toBe("outcomeUnknown")
})), 15_000)

it.live("retention releases a real subprocess that never answers session close", () => run(Effect.gen(function*() {
  const h = yield* harness
  const session = yield* h.connection.newSession({ cwd: "/tmp" })
  yield* session.release
  expect((yield* h.connection.closed)._tag).toBe("AcpConnectionClosed")
})), 15_000)
