import * as Json from "../src/internal/json.ts"
import { expect, test } from "bun:test"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as Host from "../src/AcpHost.ts"
import * as AcpGateway from "../src/AcpGateway.ts"
import * as GC from "../src/AcpGatewayClient.ts"
import * as Remote from "../src/AcpRemoteClient.ts"
import { apiFor, hostedHarness, identity, policy } from "./support/host.ts"
const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.runPromise(Effect.scoped(effect).pipe(Effect.timeout("3 seconds")))
const code = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "success"
  const failure = Cause.squash(exit.cause)
  return Schema.is(AcpGateway.GatewayError)(failure) ? failure.code : Cause.pretty(exit.cause)
}
const until = (predicate: Effect.Effect<boolean>) => Effect.gen(function*() { while (!(yield* predicate)) yield* Effect.sleep("1 millis") })
const session = Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const handle = yield* h.connection.newSession({ cwd: "/private-work" })
  return { ...h, handle, descriptor: h.remote.descriptor(handle)! }
})

test("host validates every finite bound and rejects incompatible gateway versions before opening", () => run(Effect.gen(function*() {
  for (const key of Object.keys(policy)) {
    const invalid = yield* Effect.exit(Host.make({ policy: { ...policy, [key]: 0 }, authorize: () => Effect.void, open: () => Effect.die("must not open") }))
    expect(code(invalid)).toBe("Invalid")
  }
  const host = yield* Host.make({ policy, authorize: () => Effect.void, open: () => Effect.die("must not open") })
  expect(code(yield* Effect.exit(host.hello(identity, { version: 999, workspace: "w", clientId: "c" })))).toBe("UnsupportedVersion")
  const window = yield* host.hello(identity, { version: 1, workspace: "w", clientId: "c" })
  expect(yield* Schema.decodeUnknownEffect(AcpGateway.Window)((yield* Json.decode((yield* Json.encode(window)))))).toEqual(window)
})))

test("retry ledger deduplicates canonically, rejects conflicts and survives caller interruption", () => run(Effect.gen(function*() {
  const h = yield* session
  const admission: AcpGateway.Admission = { window: h.gateway.window, operationId: "same", command: { _tag: "Open", options: { b: 2, a: 1 }, profile: "second" } }
  const first = yield* h.host.admit(identity, admission)
  const duplicate = yield* h.host.admit(identity, { ...admission, command: { _tag: "Open", profile: "second", options: { a: 1, b: 2 } } })
  expect(duplicate.operationId).toBe(first.operationId)
  yield* until(Effect.sync(() => h.opens() === 2))
  expect(code(yield* Effect.exit(h.host.admit(identity, { ...admission, command: { _tag: "Open", options: { b: 2, a: 1 }, profile: "other" } })))).toBe("Conflict")
  expect(h.opens()).toBe(2)
})))

test("refresh restores pending permission and live output without reinitializing ACP", () => run(Effect.gen(function*() {
  const h = yield* session
  yield* h.agent.send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "sess-1", title: "secret", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
  yield* until(Effect.map(h.handle.snapshot, (s) => Object.keys(s.interactions).length === 1))
  const interaction = Object.values((yield* h.handle.snapshot).interactions)[0]!
  yield* h.handle.release
  yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "while away" } })
  const gateway = yield* GC.fromApi(apiFor(h.host), { workspace: "work", storage: h.storage })
  const refreshed = yield* Remote.make(gateway, { profile: "test" })
  const restored = yield* refreshed.attach(h.descriptor)
  yield* until(Effect.map(restored.snapshot, (s) => s.messages.length === 1))
  expect((yield* restored.snapshot).interactions[interaction.interactionId]!.status).toBe("pending")
  yield* restored.resolveInteraction(interaction.interactionId, { _tag: "selected", optionId: "allow" })
  expect(Exit.isFailure(yield* Effect.exit(restored.resolveInteraction(interaction.interactionId, { _tag: "selected", optionId: "allow" })))).toBe(true)
  expect((yield* h.agent.received).filter((x) => x.id === "permission")).toHaveLength(1)
  expect((yield* h.agent.received).filter((x) => x.method === "initialize")).toHaveLength(1)
})))

test("controller takeover revokes stale writers and enforces principal/workspace ownership", () => run(Effect.gen(function*() {
  const h = yield* session
  const request = { epoch: h.host.epoch, workspace: "work", session: h.descriptor.session, clientId: "second" }
  expect(code(yield* Effect.exit(Stream.runHead(h.host.attach({ principalId: "bob" }, request))))).toBe("NotFound")
  expect(code(yield* Effect.exit(Stream.runHead(h.host.attach(identity, { ...request, workspace: "other" }))))).toBe("NotFound")
  expect(code(yield* Effect.exit(Stream.runHead(h.host.attach(identity, request))))).toBe("Conflict")
  const first = yield* Deferred.make<AcpGateway.Frame>()
  const takeover = yield* h.host.attach(identity, { ...request, takeover: true }).pipe(Stream.runForEach((frame) => Deferred.succeed(first, frame)), Effect.forkChild)
  const frame = yield* Deferred.await(first)
  expect(frame._tag).toBe("Attached")
  expect(code(yield* Effect.exit(h.host.admit(identity, { window: h.gateway.window, operationId: "stale", generation: 1, command: { _tag: "Cancel", session: h.descriptor.session } })))).toBe("StaleController")
  yield* Fiber.interrupt(takeover)
})))

test("expired windows, old epochs and capacity never redispatch commands", () => run(Effect.gen(function*() {
  const host = yield* Host.make({ policy: { ...policy, retryMs: 30, commands: 1 }, authorize: () => Effect.void, open: () => Effect.never })
  const window = yield* host.hello(identity, { version: 1, workspace: "work", clientId: "client" })
  const admission: AcpGateway.Admission = { window, operationId: "open", command: { _tag: "Open", profile: "demo", options: null } }
  yield* host.admit(identity, admission)
  expect(code(yield* Effect.exit(host.admit(identity, { ...admission, operationId: "next" })))).toBe("Capacity")
  expect(code(yield* Effect.exit(host.admit(identity, { ...admission, window: { ...window, epoch: "old" } })))).toBe("HostRestarted")
  yield* Effect.sleep("35 millis")
  expect(code(yield* Effect.exit(host.admit(identity, admission)))).toBe("WindowExpired")
})))

test("pre-send storage recovers a lost admission response with the original operation id", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const api = apiFor(h.host)
  let lose = true
  const lossy: GC.Api = { ...api, Admit: (input) => api.Admit(input).pipe(Effect.flatMap((op) => {
    if (lose) { lose = false; return Effect.fail(AcpGateway.failure("Closed")) }
    return Effect.succeed(op)
  })) }
  const gateway = yield* GC.fromApi(lossy, { workspace: "work", storage: h.storage })
  yield* Effect.exit(gateway.submit({ _tag: "Open", profile: "second", options: null }, undefined, "lost"))
  const restored = yield* GC.fromApi(api, { workspace: "work", storage: h.storage })
  const recovered = yield* restored.retry("lost")
  expect(recovered.operationId).toBe("lost")
  yield* until(Effect.sync(() => h.opens() === 2))
  expect(h.opens()).toBe(2)
})))

test("journal floor returns an explicit resync snapshot and validates future cursors", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2, { policy: { events: 1 } })
  const handle = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(handle)!
  for (let n = 0; n < 4; n++) yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: String(n) } })
  yield* until(Effect.map(handle.snapshot, (s) => s.seq >= 5))
  yield* handle.release
  const request = { epoch: h.host.epoch, workspace: "work", session: descriptor.session, clientId: h.gateway.clientId }
  const attached = yield* Stream.runHead(h.host.attach(identity, { ...request, cursor: { epoch: h.host.epoch, session: descriptor.session, sequence: 0 } }))
  expect(attached._tag === "Some" && attached.value._tag === "Attached" && attached.value.resync).toBe(true)
  expect(code(yield* Effect.exit(Stream.runHead(h.host.attach(identity, { ...request, cursor: { epoch: h.host.epoch, session: descriptor.session, sequence: 999 } }))))).toBe("Invalid")
})))

test("ACP loss before acknowledgement retains an uncertain outcome without another prompt", () => run(Effect.gen(function*() {
  const h = yield* session
  const submission = yield* h.handle.submit([{ type: "text", text: "secret-prompt" }])
  yield* h.agent.awaitRequest("session/prompt")
  const operations = yield* h.gateway.pendingOperations
  const operationId = operations[operations.length - 1]!
  yield* h.agent.disconnect
  const outcome = yield* h.gateway.wait(operationId)
  expect(outcome.status).toBe("outcomeUnknown")
  expect(outcome.error?._tag).toBe("AcpGatewayError")
  expect(Exit.isFailure(yield* Effect.exit(submission.accepted))).toBe(true)
  expect((yield* h.gateway.retry(operationId)).status).toBe("outcomeUnknown")
  expect((yield* h.agent.received).filter((message) => message.method === "session/prompt")).toHaveLength(1)
})))

for (const version of [1, 2] as const) {
  test(`v${version} host submission leaves admitted state when its local owner closes`, () => run(Effect.gen(function*() {
    const ownerScope = yield* Scope.make()
    const settled = yield* Deferred.make<void>()
    const h = yield* hostedHarness(version, {
      ownerScope,
      policy: { commands: 3, retryMs: 100 },
      onLifecycle: (event) => event.type === "settled" && event.commands === 3
        ? Deferred.succeed(settled, undefined).pipe(Effect.asVoid)
        : Effect.void
    })
    const handle = yield* h.connection.newSession({ cwd: "/work" })
    const submission = yield* handle.submit([{ type: "text", text: "held" }])
    const outcome = yield* Effect.exit(submission.outcome).pipe(Effect.forkChild)
    yield* h.agent.awaitRequest("session/prompt")
    const pending = yield* h.gateway.pendingOperations
    const operationId = pending[pending.length - 1]!
    expect((yield* h.host.operation(identity, { window: h.gateway.window, operationId })).status).toBe("admitted")
    yield* Scope.close(ownerScope, Exit.void)
    yield* Deferred.await(settled)
    expect((yield* h.host.operation(identity, { window: h.gateway.window, operationId })).status).toBe("outcomeUnknown")
    expect(Exit.isFailure(yield* Fiber.join(outcome))).toBe(true)
    // The ledger retains terminal records for retries, then reclaims their slots.
    yield* Effect.sleep("110 millis")
    const nextWindow = yield* h.host.hello(identity, { version: AcpGateway.version, workspace: "work", clientId: "after-close" })
    const next = yield* h.host.admit(identity, { window: nextWindow, operationId: "next", command: { _tag: "Open", profile: "next", options: null } })
    expect(next.status).toBe("admitted")
  })))
}

test("detached interactions expire as cancellation, never approval", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2, { policy: { interactionMs: 25 } })
  const handle = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(handle)!
  yield* h.agent.send({ jsonrpc: "2.0", id: "permission", method: "session/request_permission", params: { sessionId: "sess-1", title: "Approve?", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] } })
  yield* until(Effect.map(handle.snapshot, (s) => Object.keys(s.interactions).length === 1))
  const id = Object.keys((yield* handle.snapshot).interactions)[0]!
  yield* handle.release
  yield* until(Effect.map(h.agent.received, (messages) => messages.some((m) => m.id === "permission")))
  const restored = yield* h.remote.attach(descriptor)
  expect((yield* restored.snapshot).interactions[id]!.status).toBe("expired")
  expect((yield* Json.encode(yield* Effect.exit(restored.resolveInteraction(id, { _tag: "selected", optionId: "allow" }))))).toContain("AcpInteractionExpired")
  expect((yield* h.agent.received).find((m) => m.id === "permission")).toMatchObject({ result: { outcome: { outcome: "cancelled" } } })
})))

test("one retained session expires without killing its sibling; final expiry bounds unresponsive cleanup", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2, { agent: { version: 2, uniqueSessions: true }, policy: { retentionMs: 30, shutdownMs: 20 } })
  const first = yield* h.connection.newSession({ cwd: "/work" })
  const second = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(first)!
  yield* first.release
  yield* Effect.sleep("70 millis")
  expect(code(yield* Effect.exit(h.remote.attach(descriptor)))).toBe("NotFound")
  yield* h.agent.update(second.sessionId, { sessionUpdate: "agent_message_chunk", messageId: "alive", content: { type: "text", text: "alive" } })
  yield* until(Effect.map(second.snapshot, (s) => s.messages.length === 1))
  const closed = yield* h.connection.closed.pipe(Effect.forkChild)
  expect(closed.pollUnsafe()).toBeUndefined()
  yield* second.release
  yield* Fiber.join(closed)
})))

test("reattaching cancels the prior retention deadline", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2, { policy: { retentionMs: 50, shutdownMs: 10 } })
  const handle = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(handle)!
  yield* handle.release
  yield* Effect.sleep("10 millis")
  const restored = yield* h.remote.attach(descriptor)
  yield* Effect.sleep("60 millis")
  yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "alive", content: { type: "text", text: "alive" } })
  yield* until(Effect.map(restored.snapshot, (s) => s.messages.length === 1))
  expect(h.opens()).toBe(1)
})))

test("slow gateway subscriber is revoked at capacity and can resynchronize without blocking ACP", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2, { policy: { subscriberCapacity: 1 } })
  const handle = yield* h.connection.newSession({ cwd: "/work" })
  const descriptor = h.remote.descriptor(handle)!
  yield* handle.release
  const ready = yield* Deferred.make<void>()
  const stalled = yield* Deferred.make<void>()
  const request = { epoch: h.host.epoch, workspace: "work", session: descriptor.session, clientId: h.gateway.clientId }
  const reader = yield* h.host.attach(identity, request).pipe(Stream.runForEach((frame) => frame._tag === "Attached" ? Deferred.succeed(ready, undefined).pipe(Effect.andThen(Deferred.await(stalled))) : Effect.void), Effect.forkChild)
  yield* Deferred.await(ready)
  for (let n = 0; n < 8; n++) yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: String(n) } })
  yield* Effect.sleep("10 millis")
  const recovered = yield* Stream.runHead(h.host.attach(identity, request))
  expect(recovered._tag === "Some" && recovered.value._tag === "Attached" && recovered.value.snapshot!.seq).toBeGreaterThanOrEqual(9)
  yield* Deferred.succeed(stalled, undefined)
  expect(code(yield* Fiber.await(reader))).toBe("ResyncRequired")
})))

test("gateway errors and lifecycle metrics omit sensitive internal data", () => run(Effect.gen(function*() {
  const events: Array<Parameters<NonNullable<Host.Options["onLifecycle"]>>[0]> = []
  const secret = "credential:/private/secret-prompt"
  const host = yield* Host.make({ policy, authorize: () => Effect.void,
    onLifecycle: (event) => Effect.sync(() => { events.push(event) }),
    open: () => Effect.die(new Error(secret)) })
  const gateway = yield* GC.fromApi(apiFor(host), { workspace: "work", storage: GC.memoryStorage() })
  const operation = yield* gateway.command({ _tag: "Open", profile: "demo", options: { secret } })
  expect(operation.status).toBe("failed")
  expect((yield* Json.encode(operation))).not.toContain(secret)
  expect((yield* Json.encode(events))).not.toContain(secret)
  expect(events.length).toBeGreaterThan(0)
})))

test("interrupting a gateway command wait does not interrupt the host-owned ACP mutation", () => run(Effect.gen(function*() {
  const h = yield* hostedHarness(2)
  const waiting = yield* h.connection.authenticate("oauth").pipe(Effect.forkChild)
  yield* h.agent.awaitRequest("auth/login")
  const pending = yield* h.gateway.pendingOperations
  const id = pending[pending.length - 1]!
  yield* Fiber.interrupt(waiting)
  expect((yield* h.gateway.retry(id)).status).toBe("admitted")
  yield* h.agent.respond("auth/login", {})
  expect((yield* h.gateway.wait(id)).status).toBe("succeeded")
  expect((yield* h.agent.received).filter((m) => m.method === "auth/login")).toHaveLength(1)
})))

test("a duplicate completed close returns its retained result after the session is removed", () => run(Effect.gen(function*() {
  const h = yield* session
  const admission: AcpGateway.Admission = { window: h.gateway.window, operationId: "close", generation: 1, command: { _tag: "Close", session: h.descriptor.session } }
  yield* h.host.admit(identity, admission)
  yield* h.agent.awaitRequest("session/close")
  yield* h.agent.respond("session/close", {})
  const result = yield* h.gateway.wait("close")
  expect(result.status).toBe("succeeded")
  expect((yield* h.host.admit(identity, admission)).status).toBe("succeeded")
  expect((yield* h.agent.received).filter((m) => m.method === "session/close")).toHaveLength(1)
})))

test("old host descriptors fail explicitly after restart and stale extensions cannot bypass control", () => run(Effect.gen(function*() {
  const h = yield* session
  expect(code(yield* Effect.exit(h.remote.attach({ ...h.descriptor, epoch: "old" })))).toBe("HostRestarted")
  const connection = yield* h.storage.load(`${h.gateway.prefix}:connection:test`).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ descriptor: AcpGateway.ConnectionDescriptor })))
  )
  expect(code(yield* Effect.exit(h.host.admit(identity, { window: h.gateway.window, operationId: "extension", command: {
    _tag: "Extension", connection: connection.descriptor.connection, method: "_custom", params: { sessionId: "sess-1" }, controllers: { [h.descriptor.session]: 0 }
  } })))).toBe("StaleController")
  expect((yield* h.agent.received).some((m) => m.method === "_custom")).toBe(false)
})))

test("a stale remote handle cannot release a replacement attachment", () => run(Effect.gen(function*() {
  const h = yield* session
  yield* h.handle.release
  const replacement = yield* h.remote.attach(h.descriptor)
  yield* h.handle.release
  expect(h.remote.descriptor(replacement)).toEqual(h.descriptor)
  yield* h.agent.update("sess-1", { sessionUpdate: "agent_message_chunk", messageId: "live", content: { type: "text", text: "still live" } })
  yield* until(Effect.map(replacement.snapshot, (s) => s.messages.length === 1))
})))

test("non-serializable commands fail before ledger admission or agent work", () => run(Effect.gen(function*() {
  const h = yield* session
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const admission: AcpGateway.Admission = {
    window: h.gateway.window, operationId: "invalid-json",
    command: { _tag: "Open", profile: "test", options: circular }
  }
  expect(code(yield* Effect.exit(h.host.admit(identity, admission)))).toBe("Invalid")
  expect(code(yield* Effect.exit(h.host.operation(identity, { window: h.gateway.window, operationId: admission.operationId })))).toBe("NotFound")
  expect(h.opens()).toBe(1)
})))

test("corrupt retained connection and session state fail schema validation", () => run(Effect.gen(function*() {
  const h = yield* session
  yield* h.storage.save(`${h.gateway.prefix}:connection:test`, { epoch: h.gateway.window.epoch, operationId: 42 })
  const remote = yield* Remote.make(h.gateway, { profile: "test" })
  expect(code(yield* Effect.exit(remote.connect({ params: {} })))).toBe("Invalid")
  yield* h.handle.release
  yield* h.storage.save(`${h.gateway.prefix}:session:${h.descriptor.session}`, {
    cursor: { epoch: h.gateway.window.epoch, session: h.descriptor.session, sequence: 1 }, snapshot: { seq: "bad" }
  })
  expect(code(yield* Effect.exit(remote.attach(h.descriptor)))).toBe("Invalid")
  expect(h.opens()).toBe(1)
})))
