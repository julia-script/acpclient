/**
 * Ways to reach the fixture agent: in-process over paired in-memory
 * transports, or as a spawned subprocess over stdio.
 */
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as AcpConnector from "../../src/AcpConnector.ts"
import * as InMemory from "../../src/transport/InMemory.ts"
import * as Stdio from "../../src/transport/Stdio.ts"
import { type AgentOptions, createAgent } from "../fixtures/agent.ts"

export interface Composition {
  readonly name: string
  readonly connector: Layer.Layer<AcpConnector.AcpConnector>
  /** Completes once the agent side has been released (EOF seen or process gone). */
  readonly released: Effect.Effect<void>
}

export type Compose = (options: AgentOptions) => Effect.Effect<Composition>

export const agentPath = join(import.meta.dir, "..", "fixtures", "agent.ts")

export const inMemory: Compose = (options) =>
  Effect.gen(function*() {
    const released = yield* Deferred.make<void>()
    const connect = Effect.gen(function*() {
      const pair = yield* InMemory.make()
      // The agent lives outside the client's scope, like a separate process.
      const agentScope = yield* Scope.make()
      const agentEnd = yield* Scope.provide(pair.right, agentScope)
      const outbox = yield* Queue.unbounded<string>()
      const onLine = createAgent({
        ...options,
        exit: () => void Effect.runFork(Scope.close(agentScope, Exit.void))
      }, (line) => void Queue.offerUnsafe(outbox, line))
      yield* Stream.fromQueue(outbox).pipe(Stream.runForEach(agentEnd.send), Effect.ignore, Effect.forkIn(agentScope))
      yield* agentEnd.incoming.pipe(
        Stream.runForEach((line) => Effect.sync(() => onLine(line))),
        Effect.exit,
        Effect.andThen(Deferred.succeed(released, undefined)),
        Effect.andThen(Scope.close(agentScope, Exit.void)),
        Effect.forkDetach
      )
      return yield* pair.left
    })
    return { name: "in-memory", connector: AcpConnector.layer(connect), released: Deferred.await(released) }
  })

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until the process recorded in `pidfile` no longer exists. */
export const processGone = (pidfile: string) =>
  Effect.gen(function*() {
    const pid = Number(yield* Effect.promise(() => Bun.file(pidfile).text()))
    for (let i = 0; i < 100 && isRunning(pid); i++) yield* Effect.sleep("20 millis")
    if (isRunning(pid)) return yield* Effect.die(`process ${pid} still running`)
  })

export const stdioCommand = (options: AgentOptions, pidfile: string) =>
  ChildProcess.make("bun", [agentPath, String(options.version), options.mode ?? "normal"], {
    env: { ACP_FIXTURE_PIDFILE: pidfile },
    extendEnv: true
  })

export const stdio: Compose = (options) =>
  Effect.sync(() => {
    const pidfile = join(mkdtempSync(join(tmpdir(), "acp-agent-")), "pid")
    return {
      name: "stdio",
      connector: Stdio.layer(stdioCommand(options, pidfile)).pipe(Layer.provide(BunServices.layer)),
      released: processGone(pidfile)
    }
  })
