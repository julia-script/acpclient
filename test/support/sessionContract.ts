import { connectOptions } from "./connectOptions.ts"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import type { AcpAgentConnection, AcpSession, ConnectOptions } from "../../src/AcpClient.ts"
import { type ConnectError, AcpClient } from "../../src/AcpClient.ts"
import * as AcpLocalClient from "../../src/AcpLocalClient.ts"
import { type ScriptedAgent, scriptedAgent } from "./sessionAgent.ts"
import { singleFailureOf } from "./failure.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>) => Effect.scoped(effect)

export interface Harness {
  readonly agent: ScriptedAgent
  readonly connection: AcpAgentConnection
}

/** Opens a client against a scripted agent of the given version. */
export const harness = (
  version: 1 | 2,
  options: {
    readonly agent?: Parameters<typeof scriptedAgent>[0]
    readonly connect?: Partial<ConnectOptions>
  } = {}
): Effect.Effect<Harness, ConnectError | import("effect/unstable/rpc/RpcClientError").RpcClientError, Scope.Scope> =>
  Effect.gen(function*() {
    const agent = yield* scriptedAgent({ version, ...options.agent })
    const client = yield* Effect.provide(
      AcpClient,
      AcpLocalClient.layer.pipe(Layer.provide(agent.connector))
    )
    const connection = yield* client.connect(connectOptions(version, options.connect))
    return { agent, connection }
  })


export const text = (value: string) => ({ type: "text" as const, text: value })
type SessionSnapshot = Effect.Success<AcpSession["snapshot"]>

/** Observes the current state and then waits for the first matching change. */
export const awaitSnapshot = (session: AcpSession, predicate: (snapshot: SessionSnapshot) => boolean) =>
  Effect.scoped(Effect.gen(function*() {
    const observed = yield* session.observe
    if (predicate(observed.snapshot)) return observed.snapshot
    const event = yield* Stream.runHead(Stream.filter(observed.changes, (change) => predicate(change.snapshot)))
    if (Option.isNone(event)) throw new Error("Session observation ended before the expected change")
    return event.value.snapshot
  }))

export const failureOf = singleFailureOf

/** A prompt-response body appropriate to the version. */
export const promptResult = (version: 1 | 2) => version === 2 ? { messageId: "m-1" } : { stopReason: "end_turn" }


/** Drives a submission to completion the way its protocol does. */
export const completePrompt = (agent: ScriptedAgent, version: 1 | 2, sessionId = "sess-1") =>
  Effect.gen(function*() {
    yield* agent.respond("session/prompt", promptResult(version))
    if (version === 2) {
      // v2 ends foreground work with an idle state update, not the response.
      yield* agent.update(sessionId, { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" })
    }
  })


// -----------------------------------------------------------------------------
// Version-independent contract
// -----------------------------------------------------------------------------

export const sessionContract = (
  version: 1 | 2,
  factory: typeof harness = harness,
  name = "local",
  services: "test" | "live" = "test"
) => {
  const check = services === "live" ? it.live : it.effect
  const harness = factory
  const withSession = (version: 1 | 2, options: Parameters<typeof harness>[1] = {}) => Effect.gen(function*() {
    const open = yield* harness(version, options)
    const session = yield* open.connection.newSession({ cwd: "/work" })
    return { ...open, session }
  })
  describe(`${name} v${version} contract`, () => {
    check("creates a session and exposes negotiated capabilities", () =>
      run(Effect.gen(function*() {
        const { connection, session } = yield* withSession(version)
        expect(session.sessionId).toBe("sess-1")
        expect(session.version).toBe(version)
        expect(connection.capabilities.version).toBe(version)
        expect(connection.capabilities.session.prompt).toBe(true)
        const snapshot = yield* session.snapshot
        expect(snapshot.metadata.cwd).toBe("/work")
      })))

    check("boolean configuration changes include their wire discriminator", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        const setting = yield* Effect.forkChild(session.setConfigOption("flag", true))
        expect(yield* agent.awaitRequest("session/set_config_option")).toEqual({
          sessionId: "sess-1", configId: "flag", type: "boolean", value: true
        })
        yield* agent.respond("session/set_config_option", { configOptions: [] })
        yield* Fiber.join(setting)
      })))

    check("agent updates are applied to the snapshot in order", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-1" } : {}),
          content: text("one")
        })
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-1" } : {}),
          content: text("two")
        })
        const snapshot = yield* awaitSnapshot(session, (snapshot) =>
          snapshot.messages.length === 1 && snapshot.messages[0]!.content.length === 2)
        expect(snapshot.messages).toHaveLength(1)
        expect(snapshot.messages[0]!.content).toEqual([text("one"), text("two")])
      })))

    // Spec: "Update during new or resume".
    check("updates arriving before the lifecycle response are retained", () =>
      run(Effect.gen(function*() {
        const agent = yield* scriptedAgent({ version, holdNewSession: true })
        const client = yield* Effect.provide(
          AcpClient,
          AcpLocalClient.layer.pipe(Layer.provide(agent.connector))
        )
        const connection = yield* client.connect(connectOptions(version))

        const opening = yield* Effect.forkChild(connection.newSession({ cwd: "/work" }))
        yield* agent.awaitRequest("session/new")
        // The agent starts reporting before it has answered session/new.
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "early" } : {}),
          content: text("early")
        })
        yield* agent.releaseNewSession({ sessionId: "sess-1" })

        const session = yield* Fiber.join(opening)
        const snapshot = yield* session.snapshot
        // The early update is part of the established session's state.
        expect(snapshot.messages).toHaveLength(1)
        expect(snapshot.messages[0]!.content).toEqual([text("early")])
      })))

    check("submitting dispatches one prompt and records it", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        const submission = yield* session.submit([text("hello")])
        const params = yield* agent.awaitRequest("session/prompt")
        expect(params).toMatchObject({ sessionId: "sess-1" })
        expect(params).toMatchObject({ prompt: [text("hello")] })

        const snapshot = yield* session.snapshot
        expect(snapshot.submissions[submission.id]!.status).toEqual({ _tag: "dispatched" })
        expect(snapshot.activeSubmissionId).toBe(submission.id)
      })))

    // Spec: "Busy submission race".
    check("a concurrent second submission is rejected without sending a prompt", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        const [first, second] = yield* Effect.all([
          Effect.exit(session.submit([text("one")])),
          Effect.exit(session.submit([text("two")]))
        ], { concurrency: 2 })
        yield* agent.awaitRequest("session/prompt")

        const admitted = [first, second].filter(Exit.isSuccess)
        const rejected = [first, second].filter(Exit.isFailure)
        expect(admitted).toHaveLength(1)
        expect(rejected).toHaveLength(1)
        expect(failureOf(rejected[0]!)).toMatchObject({ _tag: "AcpSessionBusy" })

        const sent = yield* agent.received
        expect(sent.filter((message) => message.method === "session/prompt")).toHaveLength(1)
      })))

    check("the session accepts a new submission once the previous one completes", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        const first = yield* session.submit([text("one")])
        yield* agent.awaitRequest("session/prompt")
        yield* completePrompt(agent, version)
        yield* Fiber.join(yield* Effect.forkChild(first.outcome))

        const second = yield* session.submit([text("two")])
        expect(second.id).not.toBe(first.id)
      })))

    check("a prompt failure records the failure and frees the session", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        const submission = yield* session.submit([text("boom")])
        yield* agent.awaitRequest("session/prompt")
        yield* agent.respondError("session/prompt", -32603, "Internal error")
        const snapshot = yield* awaitSnapshot(session, (snapshot) =>
          snapshot.submissions[submission.id]?.status._tag === "failed")
        expect(snapshot.submissions[submission.id]!.status).toMatchObject({
          _tag: "failed",
          failure: { _tag: "remote", code: -32603 }
        })
        // The foreground is released, so the next submission is admitted.
        expect(yield* Effect.exit(session.submit([text("again")]))).toSatisfy(Exit.isSuccess)
      })))

    // Spec: "Duplicate interaction response".
    check("only one caller resolves a permission request", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* session.submit([text("edit")])
        yield* agent.awaitRequest("session/prompt")
        yield* agent.send({
          jsonrpc: "2.0",
          id: "perm-1",
          method: "session/request_permission",
          params: {
            sessionId: "sess-1",
            title: "Edit file",
            ...(version === 1 ? { toolCall: { toolCallId: "t-1", title: "Edit file" } } : {}),
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
          }
        })
        const pending = Object.values((yield* awaitSnapshot(session, (snapshot) =>
          Object.values(snapshot.interactions).some((interaction) => interaction.status === "pending"))).interactions)
        expect(pending).toHaveLength(1)
        const interactionId = pending[0]!.interactionId

        const [a, b] = yield* Effect.all([
          Effect.exit(session.resolveInteraction(interactionId, { _tag: "selected", optionId: "allow" })),
          Effect.exit(session.resolveInteraction(interactionId, { _tag: "selected", optionId: "allow" }))
        ], { concurrency: 2 })
        const reply = yield* agent.awaitReply("perm-1")

        expect([a, b].filter(Exit.isSuccess)).toHaveLength(1)
        expect(failureOf([a, b].find(Exit.isFailure)!)).toMatchObject({ _tag: "AcpInteractionAlreadyResolved" })

        // Exactly one response went on the wire.
        const sent = yield* agent.received
        expect(sent.filter((message) => message.id === "perm-1")).toHaveLength(1)
        expect(reply.result).toEqual({
          outcome: { outcome: "selected", optionId: "allow" }
        })
        expect((yield* session.snapshot).interactions[interactionId]!.status).toBe("resolved")
      })))

    // Spec: "User input is delayed".
    check("unrelated traffic keeps flowing while an interaction waits", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* session.submit([text("edit")])
        yield* agent.awaitRequest("session/prompt")
        yield* agent.send({
          jsonrpc: "2.0",
          id: "perm-1",
          method: "session/request_permission",
          params: {
            sessionId: "sess-1",
            title: "Edit file",
            ...(version === 1 ? { toolCall: { toolCallId: "t-1", title: "Edit file" } } : {}),
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }]
          }
        })
        yield* awaitSnapshot(session, (snapshot) =>
          Object.values(snapshot.interactions).some((interaction) => interaction.status === "pending"))

        // Nobody has answered the permission request yet.
        const before = yield* agent.received
        expect(before.filter((message) => message.id === "perm-1")).toHaveLength(0)

        // Updates still arrive and are still applied.
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-9" } : {}),
          content: text("still working")
        })
        expect((yield* awaitSnapshot(session, (snapshot) => snapshot.messages.length === 1)).messages).toHaveLength(1)
        expect(Object.values((yield* session.snapshot).interactions)[0]!.status).toBe("pending")
      })))

    // Spec: "Unsubscribe during foreground work".
    check("releasing an observation does not close, delete, or cancel the session", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* session.submit([text("work")])
        yield* agent.awaitRequest("session/prompt")

        const observerScope = yield* Scope.make()
        yield* Scope.provide(session.observe, observerScope)
        yield* Scope.close(observerScope, Exit.void)
        // The runtime keeps applying updates after the observer is gone.
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-1" } : {}),
          content: text("after")
        })
        expect((yield* awaitSnapshot(session, (snapshot) => snapshot.messages.length === 1)).messages).toHaveLength(1)
        // Processing advanced after unsubscribe without sending lifecycle traffic.
        const sent = yield* agent.received
        for (const method of ["session/cancel", "session/close", "session/delete"]) {
          expect(sent.filter((message) => message.method === method)).toHaveLength(0)
        }
      })))

    check("observe delivers a snapshot and the changes after it with no gap", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-1" } : {}),
          content: text("before")
        })
        yield* awaitSnapshot(session, (snapshot) => snapshot.messages.length === 1)

        const observed = yield* session.observe
        expect(observed.snapshot.messages).toHaveLength(1)

        const collecting = yield* Effect.forkChild(Stream.runCollect(Stream.take(observed.changes, 1)))
        yield* agent.update("sess-1", {
          sessionUpdate: "agent_message_chunk",
          ...(version === 2 ? { messageId: "m-2" } : {}),
          content: text("after")
        })
        const events = yield* Fiber.join(collecting)
        expect(events).toHaveLength(1)
        expect(events[0]!._tag).toBe("snapshot")
        // The observed change is strictly later than the boundary snapshot.
        expect(events[0]!.snapshot.seq).toBeGreaterThan(observed.snapshot.seq)
      })))

    // Spec: "Slow observer exceeds capacity".
    check("an observer that falls behind is told to resynchronize", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version, { connect: { observerCapacity: 2 } })
        const observed = yield* session.observe

        // Publish well past the observer's capacity without draining it.
        for (let index = 0; index < 8; index++) {
          yield* agent.update("sess-1", {
            sessionUpdate: "agent_message_chunk",
            ...(version === 2 ? { messageId: `m-${index}` } : {}),
            content: text(String(index))
          })
        }
        // Wait for the reducer to catch up rather than assuming a fixed
        // number of yields is enough.
        yield* awaitSnapshot(session, (snapshot) => snapshot.seq >= 8)

        const collected = yield* Effect.exit(Stream.runCollect(observed.changes))
        // Falling behind surfaces as an explicit typed failure, not silence.
        expect(failureOf(collected)).toMatchObject({ _tag: "AcpSubscriptionOverflow" })
        // Protocol processing was never blocked by the stalled observer: every
        // update was still applied. (Counting `seq` rather than messages,
        // because v1 folds same-role chunks into one local message.)
        expect((yield* session.snapshot).seq).toBeGreaterThanOrEqual(8)

        // A fresh boundary recovers: that is what resync asks the caller to do.
        const resumed = yield* session.observe
        expect(resumed.snapshot.seq).toBeGreaterThanOrEqual(8)
      })))

    // Spec: "Updates after cancel".
    check("updates after cancel are applied and cancellation waits for completion", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version)
        yield* session.submit([text("long")])
        yield* agent.awaitRequest("session/prompt")

        const cancelArrived = yield* Effect.forkChild(agent.awaitRequest("session/cancel"))
        const cancelling = yield* Effect.forkChild(session.cancel)
        yield* Fiber.join(cancelArrived)
        const sent = yield* agent.received
        expect(sent.filter((message) => message.method === "session/cancel")).toHaveLength(1)

        // A late tool update still lands, and cancel is not yet confirmed.
        yield* agent.update("sess-1", { sessionUpdate: "tool_call_update", toolCallId: "t-1", status: "completed" })
        expect((yield* awaitSnapshot(session, (snapshot) => snapshot.toolCalls["t-1"]?.status === "completed")).toolCalls["t-1"]!.status).toBe("completed")
        expect(cancelling.pollUnsafe()).toBeUndefined()

        yield* completePrompt(agent, version)
        expect(yield* Fiber.join(cancelling)).toBeUndefined()
      })))

    check("lists sessions where the agent supports it", () =>
      run(Effect.gen(function*() {
        const { agent, connection } = yield* harness(version)
        const listing = yield* Effect.forkChild(connection.listSessions())
        yield* agent.awaitRequest("session/list")
        yield* agent.respond("session/list", {
          sessions: [{ sessionId: "sess-1", cwd: "/work", title: "One" }]
        })
        expect(yield* Fiber.join(listing)).toEqual([
          { sessionId: "sess-1", cwd: "/work", title: "One", updatedAt: null }
        ])
      })))

    // Spec: "Unsupported session operation".
    check("an unsupported operation fails before anything is sent", () =>
      run(Effect.gen(function*() {
        const { agent, connection } = yield* harness(version, {
          agent: {
            version,
            // An agent advertising no optional session capabilities at all.
            initialize: version === 2
              ? { protocolVersion: 2, info: { name: "bare", version: "1" }, capabilities: { session: {} } }
              : { protocolVersion: 1, agentCapabilities: {} }
          }
        })
        expect(connection.capabilities.session.delete).toBe(false)

        const session = yield* connection.newSession({ cwd: "/work" })
        const exit = yield* Effect.exit(session.delete)
        expect(failureOf(exit)).toMatchObject({ _tag: "AcpCapabilityUnsupported" })

        const sent = yield* agent.received
        expect(sent.filter((message) => message.method === "session/delete")).toHaveLength(0)
      })))

    check("unsupported prompt content is rejected before dispatch", () =>
      run(Effect.gen(function*() {
        const { agent, session } = yield* withSession(version, {
          agent: {
            version,
            initialize: version === 2
              ? { protocolVersion: 2, info: { name: "bare", version: "1" }, capabilities: { session: {} } }
              : { protocolVersion: 1, agentCapabilities: {} }
          }
        })
        const exit = yield* Effect.exit(session.submit([{ type: "image", data: "", mimeType: "image/png" }]))
        expect(failureOf(exit)).toMatchObject({ _tag: "AcpCapabilityUnsupported" })
        const sent = yield* agent.received
        expect(sent.filter((message) => message.method === "session/prompt")).toHaveLength(0)
      })))

    check("an unsupported MCP server configuration is rejected before dispatch", () =>
      run(Effect.gen(function*() {
        const { agent, connection } = yield* harness(version)
        const exit = yield* Effect.exit(
          connection.newSession({ cwd: "/work", mcpServers: [{ type: "http", name: "test", url: "https://example.test", headers: [] }] })
        )
        expect(failureOf(exit)).toMatchObject({ _tag: "AcpCapabilityUnsupported" })
        const sent = yield* agent.received
        expect(sent.filter((message) => message.method === "session/new")).toHaveLength(0)
      })))

    check("authentication is restricted to advertised methods", () =>
      run(Effect.gen(function*() {
        const { agent, connection } = yield* harness(version)
        expect(connection.capabilities.auth.methods).toEqual(["oauth"])
        const exit = yield* Effect.exit(connection.authenticate("invented"))
        expect(failureOf(exit)).toMatchObject({ _tag: "AcpCapabilityUnsupported" })

        const authenticating = yield* Effect.forkChild(connection.authenticate("oauth"))
        const method = version === 2 ? "auth/login" : "authenticate"
        yield* agent.awaitRequest(method)
        yield* agent.respond(method, {})
        yield* Fiber.join(authenticating)
      })))
  })
}
