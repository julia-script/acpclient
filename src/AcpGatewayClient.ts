import { randomUUID } from "./internal/crypto.ts"
/**
 * Browser-safe gateway connection with application-provided refresh storage.
 */
import * as Effect from "effect/Effect"
import * as Clock from "effect/Clock"
import * as Semaphore from "effect/Semaphore"
import * as Deferred from "effect/Deferred"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Layer from "effect/Layer"
import * as RpcClient from "effect/rpc/RpcClient"
import * as RpcSerialization from "effect/rpc/RpcSerialization"
import * as Socket from "effect/socket/Socket"
import * as Schema from "effect/Schema"
import * as AcpGateway from "./AcpGateway.ts"

/**
 * Application-owned persistence for gateway identity, admissions, and retained session data.
 *
 * **When to use**
 *
 * Use when gateway recovery must survive a page refresh or client reconstruction.
 *
 * **Details**
 *
 * Return `undefined` from `load` for a missing key. Complete `save` only after the value is
 * available to subsequent loads; admissions are saved before the first network write. Storage keys
 * are namespaced by client options.
 *
 * @see {@link memoryStorage} for storage that lasts only for one instance.
 * @category models
 */
export interface Storage<SaveError = AcpGateway.GatewayError> {
  /**
   * Reads a retained value, returning undefined when the key has no value.
   */
  readonly load: (key: string) => Effect.Effect<unknown>
  /**
   * Persists a value before any admission depending on it is written to the network.
   */
  readonly save: (key: string, value: unknown) => Effect.Effect<void, SaveError>
  /**
   * Removes retained local state without cancelling host-side work.
   */
  readonly remove: (key: string) => Effect.Effect<void>
}
class StorageCloneFailure extends Schema.TaggedError<StorageCloneFailure>()("StorageCloneFailure", {
  cause: Schema.Defect()
}) {}

/**
 * Creates application storage backed by an in-memory map.
 *
 * **Details**
 *
 * Values are cloned when saved. State survives only while this storage instance remains reachable.
 *
 * **Gotchas**
 *
 * Non-cloneable values fail with gateway code `Invalid`.
 *
 * @category constructors
 */
export const memoryStorage = (): Storage => {
  const values = new Map<string, unknown>()
  return {
    load: (key) => Effect.sync(() => values.get(key)),
    save: (key, value) => Effect.try({
      try: () => structuredClone(value),
      catch: (cause) => new StorageCloneFailure({ cause })
    }).pipe(
      Effect.catch((failure) => failure.cause instanceof DOMException && failure.cause.name === "DataCloneError"
        ? Effect.fail(new AcpGateway.GatewayError({
          code: "Invalid",
          message: `Failed to save gateway state at ${key}: ${String(failure.cause)}`
        }))
        : Effect.die(failure.cause)),
      Effect.flatMap((cloned) => Effect.sync(() => { values.set(key, cloned) }))
    ),
    remove: (key) => Effect.sync(() => { values.delete(key) })
  }
}
type RpcApi = RpcClient.FromGroup<typeof AcpGateway.Gateway, import("effect/rpc/RpcClientError").RpcClientError>
// Gateway operations always await replies and consume attachment Streams. The
// transport client's discard/asQueue overloads are not part of this interface.
const responseApi = (client: RpcApi) => ({
  Hello: (input: Parameters<RpcApi["Hello"]>[0]) => client.Hello(input),
  Admit: (input: Parameters<RpcApi["Admit"]>[0]) => client.Admit(input),
  Operation: (input: Parameters<RpcApi["Operation"]>[0]) => client.Operation(input),
  List: (input: Parameters<RpcApi["List"]>[0]) => client.List(input),
  Closed: (input: Parameters<RpcApi["Closed"]>[0]) => client.Closed(input),
  Attach: (input: Parameters<RpcApi["Attach"]>[0]) => client.Attach(input)
})
/**
 * Response-oriented gateway RPC calls and the session attachment stream.
 *
 * @category models
 */
export type Api = ReturnType<typeof responseApi>
/**
 * Workspace, persistence adapter, storage namespace, and disconnection signal for a gateway client.
 *
 * @category configuration
 */
export interface Options<SaveError = AcpGateway.GatewayError> {
  /**
   * Workspace included in the gateway handshake and command admission window.
   */
  readonly workspace: string
  /**
   * Application-owned persistence for identity, admissions, and session recovery.
   */
  readonly storage: Storage<SaveError>
  /**
   * Storage namespace prefix. Defaults to `effect-acp:` followed by the workspace.
   */
  readonly storageKey?: string
  /**
   * Signal that the connection is lost. Defaults to an effect that never completes.
   */
  readonly disconnected?: Effect.Effect<void>
}
/**
 * Creates a gateway client from application-supplied RPC calls and persistence.
 *
 * **Details**
 *
 * Restores or creates a client identity, performs `Hello` , and persists admissions before writing
 * them to the network. `retry` first queries the retained operation before attempting admission
 * again.
 *
 * **Gotchas**
 *
 * `wait` polls until an operation leaves `admitted` ; callers needing a deadline must apply one.
 * Forgetting an operation removes local recovery data and does not cancel host work.
 *
 * @category constructors
 */
export const fromApi = <SaveError>(api: Api, options: Options<SaveError>) => Effect.gen(function*() {
  const prefix = options.storageKey ?? `effect-acp:${options.workspace}`
  const saved = yield* options.storage.load(`${prefix}:identity`)
  const clientId = typeof saved === "string" ? saved : (yield* randomUUID.pipe(Effect.mapError(() => AcpGateway.failure("Invalid"))))
  yield* options.storage.save(`${prefix}:identity`, clientId)
  let window = yield* api.Hello({ version: AcpGateway.version, workspace: options.workspace, clientId })
  yield* options.storage.save(`${prefix}:window`, window)
  const storageLock = Semaphore.makeUnsafe(1)
  const pendingOperations = Effect.map(options.storage.load(`${prefix}:operations`), (value) => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [])
  const renew = Effect.gen(function*() {
    window = yield* api.Hello({ version: AcpGateway.version, workspace: options.workspace, clientId })
    yield* options.storage.save(`${prefix}:window`, window)
    return window
  })
  const submit = (command: AcpGateway.Command, generation?: number, requestedOperationId?: string) => Effect.gen(function*() {
    const operationId = requestedOperationId ?? (yield* randomUUID.pipe(Effect.mapError(() => AcpGateway.failure("Invalid"))))
    if (window.expiresAt <= (yield* Clock.currentTimeMillis)) yield* renew
    const admission: AcpGateway.Admission = { window, operationId, command, ...(generation === undefined ? {} : { generation }) }
    // Persist before the first network write. A refresh can retry this exact operation.
    yield* Semaphore.withPermit(storageLock, Effect.gen(function*() {
      yield* options.storage.save(`${prefix}:operation:${operationId}`, admission)
      const pending = yield* pendingOperations
      if (!pending.includes(operationId)) yield* options.storage.save(`${prefix}:operations`, [...pending, operationId])
    }))
    return yield* api.Admit(admission)
  })
  const wait = (operationId: string, retainedWindow?: AcpGateway.Window) => Effect.gen(function*() {
    const saved = yield* options.storage.load(`${prefix}:operation:${operationId}`)
    const original = retainedWindow ?? (saved ? (yield* importSchemaAdmission(saved)).window : window)
    while (true) {
      const operation = yield* api.Operation({ window: original, operationId })
      if (operation.status !== "admitted") return operation
      yield* Effect.sleep("10 millis")
    }
  })
  const retry = (operationId: string, generation?: number) => Effect.gen(function*() {
    const saved = yield* options.storage.load(`${prefix}:operation:${operationId}`)
    const admission = yield* importSchemaAdmission(saved)
    // First look up an admitted operation; takeover does not cancel accepted work.
    const existing = yield* api.Operation({ window: admission.window, operationId }).pipe(Effect.catchTag("AcpGatewayError", (error) => error.code === "NotFound" ? Effect.void : Effect.fail(error)))
    if (existing) return existing
    return yield* api.Admit({ ...admission, ...(generation === undefined ? {} : { generation }) })
  })
  return { api, clientId, get window() { return window }, renew, pendingOperations,
    forget: (operationId: string) => Semaphore.withPermit(storageLock, Effect.gen(function*() {
      yield* options.storage.remove(`${prefix}:operation:${operationId}`)
      yield* options.storage.save(`${prefix}:operations`, (yield* pendingOperations).filter((id) => id !== operationId))
    })), prefix, disconnected: options.disconnected ?? Effect.never, storage: options.storage, submit, wait, retry,
    command: (command: AcpGateway.Command, generation?: number) => submit(command, generation).pipe(Effect.filterOrElse((op) => op.status !== "admitted", (op) => wait(op.operationId))) }
})
const importSchemaAdmission = (value: unknown) => Schema.decodeUnknownEffect(AcpGateway.Admission)(value).pipe(Effect.mapError(() => AcpGateway.failure("Invalid")))
/**
 * Gateway client with persisted command admissions, explicit recovery, and result polling.
 *
 * **Details**
 *
 * - `submit` persists an admission before sending and returns its current operation state.
 * - `wait` polls the operation's original window until it leaves `admitted`.
 * - `command` combines submission with waiting; a failed operation is returned as data.
 * - `retry` looks up retained work before reusing the saved admission.
 * - `pendingOperations` lists locally retained operation identities; `forget` removes recovery data.
 * - `renew` obtains and persists a fresh admission window, exposed through `window`.
 * - `api` exposes direct RPC calls; `clientId`, `prefix`, and `storage` identify the retained client state.
 * - `disconnected` signals transport loss independently of command outcomes.
 *
 * **Gotchas**
 *
 * A retained pending identity is not proof that the host is still running the operation. Forgetting
 * local state does not cancel host work. Apply a deadline to unbounded waits when needed.
 *
 * @see {@link fromApi} for acquisition and persistence behavior.
 * @category models
 */
export type Client<SaveError = AcpGateway.GatewayError> = Effect.Success<ReturnType<typeof fromApi<SaveError>>>
/**
 * Creates a gateway client using the injected Effect RPC protocol and application storage.
 *
 * @see {@link fromApi} for supplying RPC calls directly.
 *
 * @category constructors
 */
export const make = <SaveError>(options: Options<SaveError>) => Effect.flatMap(RpcClient.make(AcpGateway.Gateway), (api) => fromApi(responseApi(api), options))
/**
 * One socket lifetime; reconnection is explicit and never resends ACP commands.
 *
 * @category running
 */
export const connect = <SaveError>(url: string, options: Options<SaveError>) => Effect.gen(function*() {
  const scope = yield* Scope.Scope
  const disconnected = yield* Deferred.make<void>()
  yield* Effect.addFinalizer(() => Deferred.succeed(disconnected, undefined))
  const context = yield* Layer.buildWithScope(Layer.effect(RpcClient.Protocol, RpcClient.makeProtocolSocket({ retryTransientErrors: false, retryPolicy: Schedule.recurs(0) })).pipe(
    Layer.provide(Socket.layerWebSocket(url)), Layer.provide(RpcSerialization.layerNdjson), Layer.provide(Layer.succeed(RpcClient.ConnectionHooks, { onConnect: Effect.void, onDisconnect: Effect.asVoid(Deferred.succeed(disconnected, undefined)) }))), scope)
  return yield* make({ ...options, disconnected: Deferred.await(disconnected) }).pipe(Effect.provideContext(context))
})
