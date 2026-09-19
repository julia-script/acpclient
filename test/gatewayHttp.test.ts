import { expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as Gateway from "../src/AcpGateway.ts"
import * as Host from "../src/AcpHost.ts"
import * as GatewayHttp from "../src/server/GatewayHttp.ts"
import { policy } from "./support/host.ts"

for (const denial of ["origin", "authentication"] as const) test(`gateway rejects ${denial} before upgrading or launching`, () => Effect.runPromise(Effect.gen(function*() {
  let launches = 0
  const route = GatewayHttp.route({ allowOrigin: () => denial !== "origin",
    authenticate: () => Effect.fail(Gateway.failure("Unauthorized")) })
  const application = HttpRouter.addAll([route]).pipe(Layer.provideMerge(Host.layer({ policy, authorize: () => Effect.void,
    open: () => Effect.sync(() => { launches++; throw new Error("must not launch") }) })), Layer.provideMerge(HttpRouter.layer))
  const app = HttpRouter.toWebHandler(application, { disableLogger: true })
  try {
    const response = (yield* Effect.promise(() => app.handler(new Request("http://localhost/acp/gateway"))))
    expect(response.status).toBe(denial === "origin" ? 403 : 401)
    expect(launches).toBe(0)
  } finally { (yield* Effect.promise(() => app.dispose()))}
})))
