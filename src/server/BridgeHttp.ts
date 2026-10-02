/**
 * Mountable HTTP route that bridges browser WebSocket clients to spawned stdio ACP agents.
 *
 * **Details**
 *
 * `route` adds a single `GET` upgrade route to an application-provided
 * `HttpRouter`. The application supplies authentication, an origin policy, and
 * a launch-profile resolver; the route runs all of them, plus a check for the
 * required `effect-acp-jsonrpc-v1` subprotocol offer, BEFORE upgrading the
 * socket or spawning a process. Denied requests and disallowed launch
 * selections therefore never create a server-side agent.
 *
 * After the checks pass, the socket is upgraded, the resolved command is
 * spawned as a stdio peer inside an owned child scope, and an `AcpBridge`
 * relays frames in both directions until either side ends. The bridge's
 * `release` closes the child scope exactly once, terminating the process; the
 * enclosing request scope then closes the upgraded socket, so the browser
 * observes a disconnection. There is no reconnect and no session recovery
 * promised after connection loss.
 *
 * The module imports nothing from Node/Bun or their platform packages: the
 * process runtime and HTTP server are injected as services at the server
 * boundary, and this entry point stays browser-bundle compatible.
 */
import type * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import type * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServerRequest from "effect/http/HttpServerRequest"
import * as HttpServerResponse from "effect/http/HttpServerResponse"
import * as HttpStatus from "effect/http/HttpStatus"
import * as AcpBridge from "../AcpBridge.ts"
import * as Stdio from "../transport/Stdio.ts"
import * as WebSocket from "../transport/WebSocket.ts"

/**
 * The launch selection carried by a browser request, apart from the profile.
 *
 * @category models
 */
export interface LaunchSelection {
  /**
   * The requested launch profile name, if any.
   */
  readonly profile: string | undefined
  /**
   * Remaining search parameters besides `profile`.
   */
  readonly params: Readonly<Record<string, string | ReadonlyArray<string>>>
}

/**
 * The route refused the request or launch before any process was created.
 *
 * @category errors
 */
export class Rejected extends Schema.TaggedError<Rejected>()("BridgeHttpRejected", {
  /**
   * HTTP status for the denial. Defaults to 403.
   */
  status: Schema.optional(Schema.Finite),
  /**
   * Human-readable reason, sent as the response body.
   */
  message: Schema.String,
  /**
   * Which boundary refused the request: `profile`, `origin`, `auth`, or `launch`.
   */
  reason: Schema.optional(Schema.String)
}, { identifier: "effect-acp/server/BridgeHttp/Rejected" }) {}

/**
 * Authentication, origin, launch-profile, and transport policies for a WebSocket-to-stdio bridge.
 *
 * @category configuration
 */
export interface Options<A, AuthR = never, LaunchR = never> {
  /**
   * Path to mount the upgrade route on. Default `/acp`.
   */
  readonly path?: `/${string}` | undefined
  /**
   * Resolves the authenticated principal for an upgrade request. Its failure is reported as HTTP
   * 401 and never spawns a process. Returning a launch error with a status overrides the denial
   * status.
   */
  readonly authenticate: (request: HttpServerRequest.HttpServerRequest) => Effect.Effect<A, Rejected, AuthR>
  /**
   * Origin policy applied before upgrade. Receives the `Origin` header value (`undefined` when
   * absent) and returns whether it may connect. Required explicitly.
   */
  readonly allowOrigin: (origin: string | undefined) => boolean
  /**
   * Authorizes the browser's launch selection against the caller's allowed profiles and returns the
   * exact command to spawn. Arbitrary browser payloads never select executable paths: the resolver
   * maps profile names to permitted commands. Its failure is reported as HTTP 403 (or its own
   * status) and never spawns a process.
   */
  readonly resolveLaunch: (principal: A, selection: LaunchSelection) => Effect.Effect<ChildProcess.Command, Rejected, LaunchR>
  /**
   * Largest frame accepted on either hop, in bytes. Default 16 MiB.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Frames buffered by the WebSocket hop before reading pauses. Default 64.
   */
  readonly buffer?: number | undefined
  /**
   * Maximum time a forward write may stay blocked. Default 10 seconds.
   */
  readonly pressureDeadline?: Duration.Input | undefined
  /**
   * stderr policy for the spawned peer.
   */
  readonly stderr?: { readonly maxBytes?: number } | undefined
}

/**
 * The default mounted path.
 *
 * @category constants
 */
export const defaultPath = "/acp"

const unauthorized = HttpStatus.fromLiteral("Unauthorized")
const badRequest = HttpStatus.fromLiteral("BadRequest")
const forbidden = HttpStatus.fromLiteral("Forbidden")
const upgradeRequired = HttpStatus.fromLiteral("UpgradeRequired")


const launchSelection = (
  params: Readonly<Record<string, string | ReadonlyArray<string>>>
): LaunchSelection => {
  const profile = typeof params["profile"] === "string" ? params["profile"] : undefined
  const rest: Record<string, string | ReadonlyArray<string>> = { ...params }
  delete rest["profile"]
  return { profile, params: rest }
}

/**
 * Adds the bridge upgrade route to the current `HttpRouter` . `A` is the principal value
 * `authenticate` produces and `resolveLaunch` consumes; it is an ordinary value, not a service. The
 * route requires the services used by those callbacks and a `ChildProcessSpawner` when matched.
 * Mount it with `HttpRouter.addAll` on a server that provides them.
 *
 * @category running
 */
export const route = <A, AuthR = never, LaunchR = never>(
  options: Options<A, AuthR, LaunchR>
): HttpRouter.Route<never, ChildProcessSpawner | AuthR | LaunchR> =>
  HttpRouter.route("GET", options.path ?? defaultPath, handler(options))

const handler = <A, AuthR, LaunchR>(options: Options<A, AuthR, LaunchR>): Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  Scope.Scope | HttpServerRequest.HttpServerRequest | ChildProcessSpawner | AuthR | LaunchR
> =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const scope = yield* Scope.Scope

    if (!WebSocket.requested(request.headers)) {
      return yield* new Rejected({
        status: upgradeRequired,
        message: `Expected the ${WebSocket.profile} WebSocket subprotocol`,
        reason: "profile"
      })
    }

    const allowOrigin = options.allowOrigin
    if (!allowOrigin(request.headers["origin"])) {
      return yield* new Rejected({
        status: forbidden,
        message: "Origin not permitted",
        reason: "origin"
      })
    }

    const principal = yield* options.authenticate(request).pipe(
      Effect.mapError(() => new Rejected({
        status: unauthorized,
        message: "Authentication failed",
        reason: "auth"
      }))
    )

    // Parsed from the request URL rather than the `ParsedSearchParams` service
    // so mounting the route does not require that service in its context.
    const url = yield* Effect.try({
      try: () => new URL(request.url, "http://localhost"),
      catch: () => new Rejected({
        status: badRequest,
        message: "Invalid request URL",
        reason: "launch"
      })
    })
    const selection = launchSelection(HttpServerRequest.searchParamsFromURL(url))
    const launch = yield* options.resolveLaunch(principal, selection).pipe(
      Effect.mapError((rejected) =>
        rejected.status === undefined
          ? new Rejected({
            status: forbidden,
            message: `Launch denied: ${rejected.message}`,
            reason: "launch"
          })
          : rejected)
    )

    const socket = yield* Effect.orDie(request.upgrade)
    const browser = yield* WebSocket.fromSocket(Effect.succeed(socket), {
      maxFrameBytes: options.maxFrameBytes,
      buffer: options.buffer
    })
    const childScope = yield* Scope.fork(scope)
    const peer = yield* Scope.provide(
      Stdio.make(launch, {
        maxFrameBytes: options.maxFrameBytes,
        stderr: options.stderr
      }),
      childScope
    )
    const bridge = yield* AcpBridge.make({
      browser,
      peer,
      pressureDeadline: options.pressureDeadline,
      release: Scope.close(childScope, Exit.void)
    })
    yield* bridge.closed
    return HttpServerResponse.empty()
  }).pipe(
    Effect.catchTags({
      BridgeHttpRejected: (rejected) => Effect.succeed(HttpServerResponse.text(rejected.message, { status: rejected.status ?? forbidden })),
      // After upgrade, release the scope and end the hijacked exchange.
      AcpTransportError: () => Effect.succeed(HttpServerResponse.empty())
    })
  )
