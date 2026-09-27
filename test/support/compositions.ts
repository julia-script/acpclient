import { AcpTransport } from "../../src/AcpTransport.ts"
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
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { fileURLToPath } from "node:url"
import * as AcpConnector from "../../src/AcpConnector.ts"
import * as InMemory from "../../src/transport/InMemory.ts"
import * as Stdio from "../../src/transport/Stdio.ts"
import { type AgentOptions, createAgent } from "../fixtures/agent.ts"

const path = Effect.runSync(Effect.provide(Path.Path, Path.layer))
const join = (...segments: string[]) => path.join(...segments)

export interface Composition {
  readonly name: string
  readonly connector: Layer.Layer<AcpConnector.AcpConnector>
  /** Completes once the agent side has been released (EOF seen or process gone). */
  readonly released: Effect.Effect<void>
}

export type Compose = (options: AgentOptions) => Effect.Effect<Composition, never, Scope.Scope>

export const agentPath = join(fileURLToPath(new URL(".", import.meta.url)), "..", "fixtures", "agent.ts")

export const inMemory: Compose = (options) =>
  Effect.gen(function*() {
    const released = yield* Deferred.make<void>()
    const fixtureScope = yield* Scope.fork(yield* Scope.Scope)
    const connect = Effect.gen(function*() {
      const pair = yield* InMemory.make()
      // The agent lives outside the client's scope, like a separate process.
      const agentScope = yield* Scope.fork(fixtureScope)
      const agentEnd = yield* Scope.provide(pair.right, agentScope)
      const outbox = yield* Queue.unbounded<string>()
      const runFork = Effect.runForkWith(yield* Effect.context())
      const onLine = createAgent({
        ...options,
        exit: () => { void runFork(Effect.forkIn(Scope.close(agentScope, Exit.void), fixtureScope)) }
      }, (line) => void Queue.offerUnsafe(outbox, line), (effect) => {
        void runFork(Effect.forkIn(effect, agentScope))
      })
      yield* Stream.fromQueue(outbox).pipe(Stream.runForEach(agentEnd.send), Effect.ignore, Effect.forkIn(agentScope))
      yield* agentEnd.incoming.pipe(
        Stream.runForEach((line) => Effect.sync(() => onLine(line))),
        Effect.exit,
        Effect.andThen(Scope.close(agentScope, Exit.void)),
        Effect.andThen(Deferred.succeed(released, undefined)),
        Effect.forkIn(fixtureScope)
      )
      return yield* pair.left
    })
    return { name: "in-memory", connector: AcpConnector.layer(Layer.effect(AcpTransport, connect)), released: Deferred.await(released) }
  })

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Waits until the fixture records a process ID, including under runner load. */
export const processStarted = (pidfile: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    for (let i = 0; i < 100 && !(yield* fs.exists(pidfile)); i++) yield* Effect.sleep("20 millis")
    if (!(yield* fs.exists(pidfile))) return yield* Effect.die(`fixture pidfile never appeared: ${pidfile}`)
    return Number(yield* fs.readFileString(pidfile))
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie)

/** Waits until the process recorded in `pidfile` no longer exists. */
export const processGone = (pidfile: string) =>
  Effect.gen(function*() {
    const pid = yield* processStarted(pidfile)
    for (let i = 0; i < 100 && isRunning(pid); i++) yield* Effect.sleep("20 millis")
    if (isRunning(pid)) return yield* Effect.die(`process ${pid} still running`)
  })

export const stdioCommand = (options: AgentOptions, pidfile: string) =>
  ChildProcess.make("bun", [agentPath, String(options.version), options.mode ?? "normal"], {
    env: { ACP_FIXTURE_PIDFILE: pidfile },
    extendEnv: true
  })

export const stdio: Compose = (options) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const pidfile = join(yield* fs.makeTempDirectoryScoped({ prefix: "acp-agent-" }), "pid")
    return {
      name: "stdio",
      connector: AcpConnector.layer(Stdio.layer(stdioCommand(options, pidfile))).pipe(Layer.provide(BunServices.layer)),
      released: processGone(pidfile)
    }
  }).pipe(Effect.provide(BunServices.layer), Effect.orDie)
