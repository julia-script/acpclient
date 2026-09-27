import { connectOptions } from "./connectOptions.ts"
import * as AcpGateway from "../../src/AcpGateway.ts"
import * as Schema from "effect/Schema"
import * as Clock from "effect/Clock"
import * as Stream from "effect/Stream"
import type * as TestClock from "effect/testing/TestClock"
import * as Scope from "effect/Scope"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Host from "../../src/AcpHost.ts"
import * as GatewayClient from "../../src/AcpGatewayClient.ts"
import * as Remote from "../../src/AcpRemoteClient.ts"
import * as Local from "../../src/AcpLocalClient.ts"
import { AcpClient, type AcpSession, type ConnectOptions } from "../../src/AcpClient.ts"
import { scriptedAgent } from "./sessionAgent.ts"
export const policy: Host.Policy = { retentionMs: 30000, interactionMs: 30000, shutdownMs: 50, retryMs: 60000,
  events: 256, eventBytes: 4 * 1024 * 1024, subscriberCapacity: 256, transcriptBytes: 1024 * 1024, terminalBytes: 8192, commands: 1024, connections: 16, sessions: 32 }
export const identity = { principalId: "alice" }
export const apiFor = (host: Host.Service, principal = identity): GatewayClient.Api => ({
  Hello: (input) => host.hello(principal, input), Admit: (input) => Schema.decodeUnknownEffect(AcpGateway.Admission)(input).pipe(Effect.mapError(() => AcpGateway.failure("Invalid")), Effect.flatMap((value) => host.admit(principal, value))),
  Operation: (input) => host.operation(principal, input), List: (input) => host.list(principal, input),
  Closed: (input) => host.closed(principal, input),
  Attach: (input) => host.attach(principal, input)
})
export const hostedHarness = (version: 1 | 2, options: {
  agent?: Parameters<typeof scriptedAgent>[0]; connect?: Partial<ConnectOptions>; policy?: Partial<Host.Policy>
  ownerScope?: Scope.Closeable; onLifecycle?: Host.Options["onLifecycle"]
  clock?: TestClock.TestClock
  onHostObservation?: (snapshot: Effect.Success<AcpSession["snapshot"]>) => Effect.Effect<void>
} = {}) => Effect.gen(function*() {
  const agent = yield* scriptedAgent({ version, ...options.agent })
  const local = yield* AcpClient.pipe(Effect.provide(Local.layer.pipe(Layer.provide(agent.connector))))
  let opens = 0
  const hostEffect = Host.make({ policy: { ...policy, ...options.policy },
    authorize: () => Effect.void,
    ...(options.onLifecycle === undefined ? {} : { onLifecycle: options.onLifecycle }),
    open: (_identity, _workspace, _profile, _options, enforced) => Effect.suspend(() => {
      opens++
      const client = opens === 1 ? Effect.succeed(local) : scriptedAgent({ version, ...options.agent }).pipe(Effect.flatMap((peer) => AcpClient.pipe(Effect.provide(Local.layer.pipe(Layer.provide(peer.connector))))))
      return client.pipe(Effect.flatMap((local) => {
        const connected = local.connect(connectOptions(version, { ...enforced, ...options.connect }))
        return (options.ownerScope === undefined ? connected : Scope.provide(connected, options.ownerScope)).pipe(
          Effect.map((connection) => options.onHostObservation === undefined ? connection : {
            ...connection,
            newSession: (input) => connection.newSession(input).pipe(Effect.map((session) => ({
              ...session,
              observe: session.observe.pipe(Effect.map((observed) => ({
                ...observed,
                changes: observed.changes.pipe(Stream.tap((event) => options.onHostObservation!(event.snapshot)))
              })))
            })))
          })
        )
      }))
    }) })
  const host = yield* (options.clock === undefined ? hostEffect : hostEffect.pipe(Effect.provideService(Clock.Clock, options.clock)))
  const timed = options.clock === undefined ? host : {
    ...host,
    hello: (...args: Parameters<typeof host.hello>) => host.hello(...args).pipe(Effect.provideService(Clock.Clock, options.clock!)),
    admit: (...args: Parameters<typeof host.admit>) => host.admit(...args).pipe(Effect.provideService(Clock.Clock, options.clock!)),
    operation: (...args: Parameters<typeof host.operation>) => host.operation(...args).pipe(Effect.provideService(Clock.Clock, options.clock!)),
    attach: (...args: Parameters<typeof host.attach>) => host.attach(...args).pipe(Stream.provideService(Clock.Clock, options.clock!)),
    list: (...args: Parameters<typeof host.list>) => host.list(...args).pipe(Effect.provideService(Clock.Clock, options.clock!)),
    closed: (...args: Parameters<typeof host.closed>) => host.closed(...args).pipe(Effect.provideService(Clock.Clock, options.clock!))
  } satisfies Host.Service
  const storage = GatewayClient.memoryStorage()
  const gateway = yield* GatewayClient.fromApi(apiFor(timed), { workspace: "work", storage })
  const remote = yield* Remote.make(gateway, { profile: "test",
    ...(options.connect?.observerCapacity === undefined ? {} : { observerCapacity: options.connect.observerCapacity }) })
  const connection = yield* remote.connect(connectOptions(version))
  return { agent, connection, gateway, remote, host: timed, storage, opens: () => opens }
})
