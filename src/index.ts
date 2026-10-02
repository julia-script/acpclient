/**
 * Application identities, capabilities, session snapshots, and their runtime schemas.
 *
 * @category re-exports
 */
export * as AcpApp from "./AcpApp.ts"
/**
 * Application client and session handle contracts.
 *
 * @category re-exports
 */
export * as AcpClient from "./AcpClient.ts"
/**
 * Role-neutral JSON-RPC connections and incoming routes.
 *
 * @category re-exports
 */
export * as AcpConnection from "./AcpConnection.ts"
/**
 * Factories for independent scoped transport connections.
 *
 * @category re-exports
 */
export * as AcpConnector from "./AcpConnector.ts"
/**
 * Transport, protocol, and request failures.
 *
 * @category re-exports
 */
export * as AcpError from "./AcpError.ts"
/**
 * Application client implementation over direct ACP transports.
 *
 * @category re-exports
 */
export * as AcpLocalClient from "./AcpLocalClient.ts"
/**
 * ACP version policy and initialization.
 *
 * @category re-exports
 */
export * as AcpProtocol from "./AcpProtocol.ts"
/**
 * Version-neutral method declarations and JSON-RPC wire contracts.
 *
 * @category re-exports
 */
export * as AcpSchema from "./AcpSchema.ts"
/**
 * Session command and interaction failures.
 *
 * @category re-exports
 */
export * as AcpSessionError from "./AcpSessionError.ts"
/**
 * Pure version-aware session projection and retention.
 *
 * @category re-exports
 */
export * as AcpSessionState from "./AcpSessionState.ts"
/**
 * Scoped frame transport contract and service.
 *
 * @category re-exports
 */
export * as AcpTransport from "./AcpTransport.ts"
/**
 * Pinned ACP v1 payload types, schemas, and methods.
 *
 * @category re-exports
 */
export * as V1 from "./protocol/v1/Schema.ts"
/**
 * Pinned draft ACP v2 payload types, schemas, and methods.
 *
 * @category re-exports
 */
export * as V2 from "./protocol/v2/Schema.ts"
/**
 * Paired in-memory transports for tests and in-process peers.
 *
 * @category re-exports
 */
export * as InMemory from "./transport/InMemory.ts"
/**
 * Spawned-process transport with bounded stderr diagnostics.
 *
 * @category re-exports
 */
export * as Stdio from "./transport/Stdio.ts"

/**
 * Serializable hosted gateway commands and RPC protocol.
 *
 * @category re-exports
 */
export * as AcpGateway from "./AcpGateway.ts"
/**
 * Gateway RPC client with application-owned recovery storage.
 *
 * @category re-exports
 */
export * as AcpGatewayClient from "./AcpGatewayClient.ts"
/**
 * Application client implementation over the hosted gateway.
 *
 * @category re-exports
 */
export * as AcpRemoteClient from "./AcpRemoteClient.ts"
