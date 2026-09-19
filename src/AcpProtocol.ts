import { AcpTransport } from "./AcpTransport.ts"
/**
 * Protocol version policy, initialization, and version selection.
 *
 * ACP v2 is a draft, so only v1 is enabled by default. Enable v2 explicitly
 * with `versions: [2, 1]` (prefer v2, accept a v1 downgrade) or `[2]`.
 * Enabling v2 enables only its baseline: nothing beyond the supplied
 * `initialize` params is advertised.
 *
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as AcpConnection from "./AcpConnection.ts"
import { AcpConnector } from "./AcpConnector.ts"
import {
  type AcpConnectionClosed,
  AcpProtocolError,
  type AcpRequestError,
  type AcpTimeoutError,
  type AcpTransportError,
  AcpUnsupportedVersion
} from "./AcpError.ts"
import * as V1 from "./protocol/v1/Schema.ts"
import * as V2 from "./protocol/v2/Schema.ts"

export type Version = 1 | 2

/** Versioned wire modules by protocol version. */
export const schemas = { 1: V1, 2: V2 } as const

/** Versions enabled when none are given. */
export const defaultVersions: readonly [1] = [1]

export type InitializeOptions =
  | {
    /** Enabled versions; defaults to `[1]`. */
    readonly versions?: readonly [1] | undefined
    readonly params: Omit<V1.InitializeRequest, "protocolVersion">
    readonly timeout?: AcpConnection.RequestOptions["timeout"]
  }
  | {
    readonly versions: readonly [2] | readonly [2, 1]
    readonly params: Omit<V2.InitializeRequest, "protocolVersion">
    readonly timeout?: AcpConnection.RequestOptions["timeout"]
  }

/** The advertisement actually sent, whichever version is later selected. */
export type Advertised =
  | { readonly version: 1; readonly params: V1.InitializeRequest }
  | { readonly version: 2; readonly params: V2.InitializeRequest }

/** Result of a successful initialization; the connection speaks `version` from now on. */
export type Negotiated =
  | { readonly version: 1; readonly advertised: Advertised; readonly response: V1.InitializeResponse }
  | { readonly version: 2; readonly advertised: Advertised; readonly response: V2.InitializeResponse }

export type InitializeError = AcpRequestError | AcpTimeoutError | AcpUnsupportedVersion

const initialized = new WeakSet<AcpConnection.Service>()

/**
 * Sends `initialize` with the highest enabled version and selects the version
 * the agent answers with, validating the response with that version's codec.
 * A connection is initialized at most once, even if the attempt fails.
 */
export const initialize = (
  connection: AcpConnection.Service,
  options: InitializeOptions
): Effect.Effect<Negotiated, InitializeError> =>
  Effect.gen(function*() {
    if (initialized.has(connection)) {
      return yield* new AcpProtocolError({ message: "Connection has already been initialized" })
    }
    initialized.add(connection)
    const enabled: ReadonlyArray<Version> = options.versions ?? defaultVersions
    if (enabled.length === 0 || !enabled.every((v) => v === 1 || v === 2)) {
      return yield* new AcpProtocolError({ message: "Invalid version policy" })
    }
    const offered = enabled.includes(2) ? 2 : 1
    const input = { ...options.params, protocolVersion: offered }
    const invalidParams = (error: Schema.SchemaError) => new AcpProtocolError({ message: `Invalid initialize params: ${error.message}` })
    const advertised: Advertised = offered === 2
      ? { version: 2, params: yield* Schema.encodeUnknownEffect(V2.InitializeRequest)(input).pipe(Effect.mapError(invalidParams)) }
      : { version: 1, params: yield* Schema.encodeUnknownEffect(V1.InitializeRequest)(input).pipe(Effect.mapError(invalidParams)) }
    const raw = yield* connection.requestRaw("initialize", advertised.params, { timeout: options.timeout })
    const received = typeof raw === "object" && raw !== null && "protocolVersion" in raw ? raw.protocolVersion : undefined
    const version = enabled.find((v) => v === received)
    if (version === undefined) {
      return yield* new AcpUnsupportedVersion({ requested: offered, received, supported: [...enabled] })
    }
    const invalidResponse = (error: Schema.SchemaError) => new AcpProtocolError({ message: `Invalid v${version} initialize response: ${error.message}`, cause: error })
    if (version === 2) return { version, advertised, response: yield* Schema.decodeUnknownEffect(V2.InitializeResponse)(raw).pipe(Effect.mapError(invalidResponse)) }
    return { version, advertised, response: yield* Schema.decodeUnknownEffect(V1.InitializeResponse)(raw).pipe(Effect.mapError(invalidResponse)) }
  })

export type ConnectOptions = InitializeOptions & {
  /** Incoming handlers for the negotiated version; none means every request gets Method not found. */
  readonly handlers?: ((negotiated: Negotiated) => AcpConnection.Handlers) | undefined
  readonly connection?: Omit<AcpConnection.Options, "handlers"> | undefined
}

export interface Connected {
  readonly connection: AcpConnection.Service
  readonly negotiated: Negotiated
}

/**
 * Opens a transport with `AcpConnector`, initializes it, and installs the
 * handlers for the negotiated version. On any failure the transport is
 * released before the error is returned; nothing else is sent.
 */
export const connect = (
  options: ConnectOptions
): Effect.Effect<Connected, AcpTransportError | AcpConnectionClosed | InitializeError, AcpConnector | Scope.Scope> =>
  Effect.gen(function*() {
    const child = yield* Scope.fork(yield* Scope.Scope)
    return yield* Effect.gen(function*() {
      const connector = yield* AcpConnector
      const transport = yield* connector.connect
      const connection = yield* AcpConnection.make(options.connection).pipe(Effect.provideService(AcpTransport, transport))
      const negotiated = yield* initialize(connection, options)
      yield* connection.setHandlers(options.handlers?.(negotiated) ?? {})
      return { connection, negotiated }
    }).pipe(
      Scope.provide(child),
      Effect.onExit((exit) => Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)
    )
  })
