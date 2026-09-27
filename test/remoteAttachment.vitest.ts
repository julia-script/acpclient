import { expect, it } from "@effect/vitest"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as AcpGateway from "../src/AcpGateway.ts"
import * as GC from "../src/AcpGatewayClient.ts"
import * as Remote from "../src/AcpRemoteClient.ts"
import { apiFor, hostedHarness } from "./support/host.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) =>
  Effect.scoped(effect).pipe(Effect.timeout("3 seconds"))

const code = (exit: Exit.Exit<unknown, unknown>) => Exit.isSuccess(exit)
  ? "success"
  : (Cause.squash(exit.cause) as AcpGateway.GatewayError).code

it.live("concurrent callers share one attachment until both scopes close", () => run(Effect.gen(function*() {
  let attached = 0
  let detached = 0
  const h = yield* hostedHarness(2, { onLifecycle: (event) => Effect.sync(() => {
    if (event.type === "attached") attached++
    if (event.type === "detached") detached++
  }) })
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release

  let calls = 0
  const started = yield* Deferred.make<void>()
  const proceed = yield* Deferred.make<void>()
  const api = apiFor(h.host)
  const gateway = yield* GC.fromApi({ ...api, Attach: (input) => Stream.unwrap(Effect.gen(function*() {
    calls++
    yield* Deferred.succeed(started, undefined)
    yield* Deferred.await(proceed)
    return api.Attach(input)
  })) }, { workspace: "work", storage: h.storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  const firstScope = yield* Scope.make()
  const secondScope = yield* Scope.make()
  const firstFiber = yield* Scope.provide(remote.attach(descriptor), firstScope).pipe(Effect.forkChild)
  yield* Deferred.await(started)
  const secondFiber = yield* Scope.provide(remote.attach(descriptor), secondScope).pipe(Effect.forkChild)
  yield* Deferred.succeed(proceed, undefined)
  const first = yield* Fiber.join(firstFiber)
  const second = yield* Fiber.join(secondFiber)
  expect(calls).toBe(1)
  expect(remote.descriptor(first)).toEqual(descriptor)
  expect(remote.descriptor(second)).toEqual(descriptor)

  yield* Scope.close(firstScope, Exit.void)
  expect(detached).toBe(1)
  expect(code(yield* Effect.exit(first.cancel))).toBe("Closed")
  const observation = yield* Scope.provide(second.observe, secondScope)
  const next = yield* Stream.runHead(observation.changes).pipe(Effect.forkChild)
  yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "alive" } })
  expect((yield* Fiber.join(next))._tag).toBe("Some")
  expect((yield* second.snapshot).messages).toHaveLength(1)

  yield* Scope.close(secondScope, Exit.void)
  expect(attached).toBe(2)
  expect(detached).toBe(2)
  expect(remote.descriptor(first)).toBeUndefined()
  expect(remote.descriptor(second)).toBeUndefined()
})))

it.live("explicit release drops only its caller reference", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  const firstScope = yield* Scope.make()
  const secondScope = yield* Scope.make()
  const first = yield* Scope.provide(h.remote.attach(descriptor), firstScope)
  const second = yield* Scope.provide(h.remote.attach(descriptor), secondScope)
  yield* first.release
  yield* first.release
  expect(code(yield* Effect.exit(first.submit([{ type: "text", text: "released" }])))).toBe("Closed")
  yield* second.cancel
  const sent = yield* h.agent.received
  expect(sent.filter((message) => message.method === "session/prompt")).toHaveLength(0)
  expect(sent.filter((message) => message.method === "session/cancel")).toHaveLength(1)
  const observed = yield* Scope.provide(second.observe, secondScope)
  const next = yield* Stream.runHead(observed.changes).pipe(Effect.forkChild)
  yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "alive" } })
  expect((yield* Fiber.join(next))._tag).toBe("Some")
  yield* Scope.close(firstScope, Exit.void)
  yield* second.release
  yield* Scope.close(secondScope, Exit.void)
})))

it.live("interrupting an in-flight caller leaves a fresh attachment available", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  const api = apiFor(h.host)
  const started = yield* Deferred.make<void>()
  const blocked = yield* Deferred.make<void>()
  let calls = 0
  const gateway = yield* GC.fromApi({ ...api, Attach: (input) => Stream.unwrap(Effect.gen(function*() {
    if (++calls === 1) {
      yield* Deferred.succeed(started, undefined)
      yield* Deferred.await(blocked)
    }
    return api.Attach(input)
  })) }, { workspace: "work", storage: h.storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  const firstScope = yield* Scope.make()
  const first = yield* Scope.provide(remote.attach(descriptor), firstScope).pipe(Effect.forkChild)
  yield* Deferred.await(started)
  yield* Fiber.interrupt(first)
  yield* Scope.close(firstScope, Exit.void)
  const secondScope = yield* Scope.make()
  const second = yield* Scope.provide(remote.attach(descriptor), secondScope)
  expect(second.sessionId).toBe(descriptor.sessionId)
  expect(calls).toBe(2)
  yield* Scope.close(secondScope, Exit.void)
})))

it.live("failed acquisition can retry and takeover still reaches the host", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  const api = apiFor(h.host)
  let fail = true
  const takeovers: boolean[] = []
  const gateway = yield* GC.fromApi({ ...api, Attach: (input) => {
    takeovers.push(input.takeover ?? false)
    if (fail) { fail = false; return Stream.fail(AcpGateway.failure("Closed")) }
    return api.Attach(input)
  } }, { workspace: "work", storage: h.storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  expect(code(yield* Effect.exit(remote.attach(descriptor, true)))).toBe("Closed")
  const scope = yield* Scope.make()
  const replacement = yield* Scope.provide(remote.attach(descriptor, true), scope)
  expect(replacement.sessionId).toBe(original.sessionId)
  expect(takeovers).toEqual([true, true])
  expect(code(yield* Effect.exit(original.cancel))).toBe("StaleController")
  yield* Scope.close(scope, Exit.void)
})))

it.live("a failed first snapshot save releases the controller before retry", () => run(Effect.gen(function*() {
  let detached = 0
  const h = yield* hostedHarness(2, { onLifecycle: (event) => Effect.sync(() => {
    if (event.type === "detached") detached++
  }) })
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  const base = GC.memoryStorage()
  let failSave = true
  const storage: GC.Storage = {
    load: base.load,
    save: (key, value) => Effect.suspend(() => {
      if (key.endsWith(`:session:${descriptor.session}`) && failSave) {
        failSave = false
        return Effect.fail(AcpGateway.failure("Invalid"))
      }
      return base.save(key, value)
    }),
    remove: base.remove
  }
  const gateway = yield* GC.fromApi(apiFor(h.host), { workspace: "work", storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  expect(code(yield* Effect.exit(remote.attach(descriptor)))).toBe("Invalid")
  expect(detached).toBe(2)
  const replacement = yield* remote.attach(descriptor, true)
  expect(code(yield* Effect.exit(replacement.cancel))).toBe("success")
  yield* replacement.release
})))

it.live("a stale descriptor is rejected and does not poison a later attachment", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  expect(code(yield* Effect.exit(h.remote.attach({ ...descriptor, sessionId: "wrong" })))).toBe("Invalid")
  const replacement = yield* h.remote.attach(descriptor)
  expect(replacement.sessionId).toBe(descriptor.sessionId)
  yield* replacement.release
})))

it.live("a stale descriptor cannot take over a live controller", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  expect(code(yield* Effect.exit(original.cancel))).toBe("success")
  expect(code(yield* Effect.exit(h.remote.attach({ ...descriptor, sessionId: "wrong" }, true)))).toBe("Invalid")
  expect(code(yield* Effect.exit(original.cancel))).toBe("success")
  yield* original.release
})))

it.live("live metadata still blocks stale takeover when retained storage is unavailable", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  let hideRetained = false
  const storage: GC.Storage = {
    load: (key) => hideRetained && key.endsWith(`:session:${descriptor.session}`)
      ? Effect.void
      : h.storage.load(key),
    save: h.storage.save,
    remove: h.storage.remove
  }
  const gateway = yield* GC.fromApi(apiFor(h.host), { workspace: "work", storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  const active = yield* remote.attach(descriptor)
  hideRetained = true
  expect(code(yield* Effect.exit(remote.attach({ ...descriptor, version: 1 }, true)))).toBe("Invalid")
  expect(code(yield* Effect.exit(active.cancel))).toBe("success")
  yield* active.release
})))

it.live("an in-flight attachment blocks a stale takeover before its first save", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  yield* original.release
  const base = GC.memoryStorage()
  const saving = yield* Deferred.make<void>()
  const proceed = yield* Deferred.make<void>()
  let gateFirstSave = true
  const sessionKey = `:session:${descriptor.session}`
  const storage: GC.Storage = {
    load: (key) => key.endsWith(sessionKey) ? Effect.void : base.load(key),
    save: (key, value) => Effect.suspend(() => {
      if (!key.endsWith(sessionKey) || !gateFirstSave) return base.save(key, value)
      gateFirstSave = false
      return Deferred.succeed(saving, undefined).pipe(
        Effect.andThen(Deferred.await(proceed)), Effect.andThen(base.save(key, value)))
    }),
    remove: base.remove
  }
  const gateway = yield* GC.fromApi(apiFor(h.host), { workspace: "work", storage })
  const remote = yield* Remote.make(gateway, { profile: "test" })
  const first = yield* remote.attach(descriptor).pipe(Effect.forkChild)
  yield* Deferred.await(saving)
  expect(code(yield* Effect.exit(remote.attach({ ...descriptor, sessionId: "wrong" }, true)))).toBe("Invalid")
  yield* Deferred.succeed(proceed, undefined)
  const active = yield* Fiber.join(first)
  expect(code(yield* Effect.exit(active.cancel))).toBe("success")
  yield* active.release
})))

it.live("an explicit takeover replaces an active local attachment", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const original = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(original)!
  const replacement = yield* h.remote.attach(descriptor, true)
  expect(replacement.sessionId).toBe(original.sessionId)
  expect(code(yield* Effect.exit(original.cancel))).toBe("StaleController")
  yield* original.release
  expect((yield* replacement.snapshot).sessionId).toBe(descriptor.sessionId)
  yield* replacement.release
})))
