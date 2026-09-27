import { describe, expect, it } from "tstyche"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as BridgeHttp from "../src/server/BridgeHttp.ts"

class AuthService extends Context.Service<AuthService, { readonly principal: string }>()("test/AuthService") {}
class LaunchService extends Context.Service<LaunchService, { readonly command: string }>()("test/LaunchService") {}

describe("bridge route service contracts", () => {
  it("retains the services required by authentication and launch resolution", () => {
    const route = BridgeHttp.route({
      authenticate: () => Effect.map(Effect.service(AuthService), (auth) => ({ id: auth.principal })),
      allowOrigin: () => true,
      resolveLaunch: () => Effect.map(Effect.service(LaunchService), (launch) => ChildProcess.make(launch.command, []))
    })

    expect(route).type.toBe<HttpRouter.Route<never, ChildProcessSpawner | AuthService | LaunchService>>()
    expect(route).type.not.toBeAssignableTo<HttpRouter.Route<never, ChildProcessSpawner>>()
  })

  it("keeps callback-free callers source compatible", () => {
    const options: BridgeHttp.Options<{ readonly id: string }> = {
      authenticate: () => Effect.succeed({ id: "user" }),
      allowOrigin: () => true,
      resolveLaunch: () => Effect.succeed(ChildProcess.make("agent", []))
    }

    expect(BridgeHttp.route(options)).type.toBe<HttpRouter.Route<never, ChildProcessSpawner>>()
  })
})
