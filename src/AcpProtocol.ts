import { AcpTransport } from "./AcpTransport.ts"
/**
 * Protocol version policy, initialization, and version selection.
 *
 * **Details**
 *
 * ACP v2 is a draft, so only v1 is enabled by default. Enable v2 explicitly
 * with `versions: [2, 1]` (prefer v2, accept a v1 downgrade) or `[2]`.
 * Enabling v2 enables only its baseline: nothing beyond the supplied
 * `initialize` params is advertised.
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

/**
 * ACP wire protocol versions supported by this library.
 *
 * @category models
 */
export type Version = 1 | 2

/**
 * Versioned wire modules by protocol version.
 *
 * @category constants
 */
export const schemas = { 1: V1, 2: V2 } as const

/**
 * Versions enabled when none are given.
 *
 * @category constants
 */
export const defaultVersions: readonly [1] = [1]

/**
 * Initialization payload and enabled version policy for one agent connection.
 *
 * **Details**
 *
 * The default policy enables v1 only. Use `[2]` to require draft v2 or `[2, 1]` to offer v2 and
 * allow a v1 downgrade. The library supplies `protocolVersion` .
 *
 * @category configuration
 */
export type InitializeOptions =
  | {
    /**
     * Enabled versions; defaults to `[1]`.
     */
    readonly versions?: readonly [1] | undefined
    /**
     * Client advertisement without the protocol version, which the library supplies.
     */
    readonly params: Omit<V1.InitializeRequest, "protocolVersion">
    /**
     * Local deadline covering the initialize request write and response wait.
     */
    readonly timeout?: AcpConnection.RequestOptions["timeout"]
  }
  | {
    /**
     * Enabled wire versions; offering draft v2 requires opting in explicitly.
     */
    readonly versions: readonly [2] | readonly [2, 1]
    /**
     * Client advertisement without the protocol version, which the library supplies.
     */
    readonly params: Omit<V2.InitializeRequest, "protocolVersion">
    /**
     * Local deadline covering the initialize request write and response wait.
     */
    readonly timeout?: AcpConnection.RequestOptions["timeout"]
  }

/**
 * The advertisement actually sent, whichever version is later selected.
 *
 * @category models
 */
export type Advertised =
  | { readonly version: 1; readonly params: V1.InitializeRequest }
  | { readonly version: 2; readonly params: V2.InitializeRequest }

/**
 * Result of a successful initialization; the connection speaks `version` from now on.
 *
 * @category models
 */
export type Negotiated =
  | { readonly version: 1; readonly advertised: Advertised; readonly response: V1.InitializeResponse }
  | { readonly version: 2; readonly advertised: Advertised; readonly response: V2.InitializeResponse }

/**
 * Failures from request exchange, initialization validation, or version selection.
 *
 * @category errors
 */
export type InitializeError = AcpRequestError | AcpTimeoutError | AcpUnsupportedVersion

const initialized = new WeakSet<AcpConnection.Service>()

/**
 * Sends initialization with the highest enabled ACP version and validates the peer's selected
 * version.
 *
 * **Details**
 *
 * Records the original advertisement separately from the selected version. A v2 offer can accept a
 * v1 response only when v1 is enabled. Payloads and responses are validated with the corresponding
 * version's codec.
 *
 * **Gotchas**
 *
 * A connection may be initialized only once, even if the attempt fails. Open a fresh connection to
 * retry. A response selecting a disabled version fails with `AcpUnsupportedVersion` .
 *
 * @see {@link connect} for acquiring and initializing a fresh transport together.
 * @category running
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

/**
 * Initialization options with connection limits and a handler factory for the negotiated version.
 *
 * @category configuration
 */
export type ConnectOptions = InitializeOptions & {
  /**
   * Incoming handlers for the negotiated version; none means every request gets Method not found.
   */
  readonly handlers?: ((negotiated: Negotiated) => AcpConnection.Handlers) | undefined
  /**
   * Request limits and notification buffering for the newly acquired connection.
   */
  readonly connection?: Omit<AcpConnection.Options, "handlers"> | undefined
}

/**
 * Initialized JSON-RPC connection paired with its negotiated protocol data.
 *
 * @category models
 */
export interface Connected {
  /**
   * Initialized peer whose lifetime belongs to the caller scope.
   */
  readonly connection: AcpConnection.Service
  /**
   * Selected version, original advertisement, and decoded peer response.
   */
  readonly negotiated: Negotiated
}

/**
 * Opens a transport with `AcpConnector` , initializes it, and installs the handlers for the
 * negotiated version. On any failure the transport is released before the error is returned;
 * nothing else is sent.
 *
 * @category running
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
