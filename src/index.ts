/**
 * Effect-native Agent Client Protocol foundation.
 *
 * Every module here is browser-safe: process access is injected through
 * `ChildProcessSpawner` rather than imported.
 *
 * @since 0.1.0
 */
export * as AcpConnection from "./AcpConnection.ts"
export * as AcpConnector from "./AcpConnector.ts"
export * as AcpError from "./AcpError.ts"
export * as AcpProtocol from "./AcpProtocol.ts"
export * as AcpSchema from "./AcpSchema.ts"
export type * as AcpTransport from "./AcpTransport.ts"
export * as V1 from "./protocol/v1/Schema.ts"
export * as V2 from "./protocol/v2/Schema.ts"
export * as InMemory from "./transport/InMemory.ts"
export * as Stdio from "./transport/Stdio.ts"
