/**
 * Route authorization: the upgrade route runs the subprotocol check, origin
 * policy, authentication, and launch resolution BEFORE upgrading the socket or
 * spawning a process. Every denial path asserts the injected spawner was never
 * invoked, which is the security-critical claim of the bridge route.
 */
import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, make as makeSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BridgeHttp from "../src/server/BridgeHttp.ts"
import * as WebSocket from "../src/transport/WebSocket.ts"

/** A principal standing in for an application's authenticated user. */
interface Principal {
  readonly id: string
}

const principal: Principal = { id: "julia" }

const allowedCommand = ChildProcess.make("acp-agent", [])

/**
 * A spawner that records every spawn attempt and never starts a real process.
 * Any call at all means the route failed to deny before process creation.
 */
const trackingSpawner = () => {
  const spawns: Array<ChildProcess.Command> = []
  const fail = (command: ChildProcess.Command) => {
    spawns.push(command)
    return Effect.die(new Error("spawner must not be called for a denied request"))
  }
  return { spawns, layer: Layer.succeed(ChildProcessSpawner, makeSpawner(fail)) }
}

const handlerFor = (
  options: Partial<BridgeHttp.Options<Principal>> & { readonly spawnerLayer: Layer.Layer<ChildProcessSpawner> }
) => {
  // The route requires only the spawner: the principal is a plain value the
  // application's `authenticate` produces, never a service to provide.
  const route = BridgeHttp.route<Principal>({
    authenticate: options.authenticate ?? (() => Effect.succeed(principal)),
    resolveLaunch: options.resolveLaunch ?? (() => Effect.succeed(allowedCommand)),
    allowOrigin: options.allowOrigin ?? (() => true)
  })
  const appLayer = HttpRouter.addAll([route]).pipe(
    Layer.provideMerge(options.spawnerLayer),
    Layer.provideMerge(HttpRouter.layer)
  )
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer, { disableLogger: true })
  return Object.assign(
    (request: Request) => handler(request),
    { dispose }
  )
}

const upgradeRequest = (
  url: string,
  headers: Record<string, string> = { "sec-websocket-protocol": WebSocket.profile }
) => new Request(url, { headers })

describe("BridgeHttp route authorization", () => {
  test("rejects a request that does not offer the required subprotocol without spawning", () => Effect.runPromise(Effect.gen(function*() {
    const spawner = trackingSpawner()
    const handler = handlerFor({ spawnerLayer: spawner.layer })

    const response = (yield* Effect.promise(() => handler(upgradeRequest("http://localhost/acp", {}))))

    expect(response.status).toBe(426)
    expect(spawner.spawns).toEqual([])
  })))

  test("rejects a disallowed origin without spawning", () => Effect.runPromise(Effect.gen(function*() {
    const spawner = trackingSpawner()
    const handler = handlerFor({
      spawnerLayer: spawner.layer,
      allowOrigin: (origin) => origin === "https://allowed.example"
    })

    const response = (yield* Effect.promise(() => handler(upgradeRequest("http://localhost/acp", {
      "sec-websocket-protocol": WebSocket.profile,
      origin: "https://evil.example"
    }))))

    expect(response.status).toBe(403)
    expect(spawner.spawns).toEqual([])
  })))

  test("rejects a failed authentication with 401 and without spawning", () => Effect.runPromise(Effect.gen(function*() {
    const spawner = trackingSpawner()
    const handler = handlerFor({
      spawnerLayer: spawner.layer,
      authenticate: () => Effect.fail(new BridgeHttp.Rejected({ message: "no token" }))
    })

    const response = (yield* Effect.promise(() => handler(upgradeRequest("http://localhost/acp"))))

    expect(response.status).toBe(401)
    expect(spawner.spawns).toEqual([])
  })))

  test("rejects a browser-supplied executable outside the permitted profiles without spawning", () => Effect.runPromise(Effect.gen(function*() {
    const spawner = trackingSpawner()
    const handler = handlerFor({
      spawnerLayer: spawner.layer,
      // Only named profiles resolve; an arbitrary command never reaches a spawn.
      resolveLaunch: (_principal, selection) =>
        selection.profile === "trusted"
          ? Effect.succeed(allowedCommand)
          : Effect.fail(new BridgeHttp.Rejected({ message: `unknown profile ${selection.profile}` }))
    })

    const response = (yield* Effect.promise(() => handler(
      upgradeRequest("http://localhost/acp?profile=/bin/sh&args=-c")
    )))

    expect(response.status).toBe(403)
    expect((yield* Effect.promise(() => response.text()))).toContain("/bin/sh")
    expect(spawner.spawns).toEqual([])
  })))

  test("passes the browser's launch selection to the resolver, profile separated from params", () => Effect.runPromise(Effect.gen(function*() {
    const spawner = trackingSpawner()
    let seen: BridgeHttp.LaunchSelection | undefined
    const handler = handlerFor({
      spawnerLayer: spawner.layer,
      resolveLaunch: (_principal, selection) => {
        seen = selection
        return Effect.fail(new BridgeHttp.Rejected({ message: "stop before spawn" }))
      }
    })

    yield* Effect.promise(() => handler(upgradeRequest("http://localhost/acp?profile=trusted&workspace=demo")))

    expect(seen?.profile).toBe("trusted")
    expect(seen?.params).toEqual({ workspace: "demo" })
    expect(spawner.spawns).toEqual([])
  })))
})
