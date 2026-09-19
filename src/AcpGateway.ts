import { McpServer, ElicitationContent, SessionListEntry } from "./AcpApp.ts"
/** Package-owned application protocol. This is not an ACP transport. */
import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"
import * as AcpSessionError from "./AcpSessionError.ts"
import * as V1 from "./protocol/v1/Schema.ts"
import * as V2 from "./protocol/v2/Schema.ts"
import { Capabilities, SessionSnapshot } from "./AcpApp.ts"

export const version = 1 as const
export class GatewayError extends Schema.TaggedError<GatewayError>()("AcpGatewayError", {
  code: Schema.Literals(["UnsupportedVersion", "Unauthorized", "HostRestarted", "NotFound", "Conflict", "StaleController", "WindowExpired", "Capacity", "ResyncRequired", "Closed", "Invalid", "AgentFailure", "OutcomeUnknown"]),
  message: Schema.String
}) {}
export const failure = (code: GatewayError["code"]): GatewayError => new GatewayError({ code, message: code })
export const Identity = Schema.Struct({ principalId: Schema.String })
export type Identity = typeof Identity.Type
export const Window = Schema.Struct({ token: Schema.String, epoch: Schema.String, clientId: Schema.String, workspace: Schema.String, expiresAt: Schema.Finite })
export type Window = typeof Window.Type
export const Cursor = Schema.Struct({ epoch: Schema.String, session: Schema.String, sequence: Schema.Int })
export type Cursor = typeof Cursor.Type
const Advertised = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), params: V1.InitializeRequest }),
  Schema.Struct({ version: Schema.Literal(2), params: V2.InitializeRequest })
])
export const Negotiated = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), advertised: Advertised, response: V1.InitializeResponse }),
  Schema.Struct({ version: Schema.Literal(2), advertised: Advertised, response: V2.InitializeResponse })
])
export const ConnectionDescriptor = Schema.Struct({ connection: Schema.String, capabilities: Capabilities, negotiated: Negotiated })
export const SessionDescriptor = Schema.Struct({ epoch: Schema.String, session: Schema.String, sessionId: Schema.String, version: Schema.Literals([1, 2]) })
export type SessionDescriptor = typeof SessionDescriptor.Type
export const SubmissionResult = Schema.Struct({ submissionId: Schema.String, agentMessageId: Schema.NullOr(Schema.String), acceptanceUnavailable: Schema.Boolean })
export const Resolution = Schema.Union([
  Schema.TaggedStruct("selected", { optionId: Schema.String }), Schema.TaggedStruct("cancelled", {}),
  Schema.TaggedStruct("accept", { content: Schema.optionalKey(ElicitationContent) }), Schema.TaggedStruct("decline", {}), Schema.TaggedStruct("cancel", {})
])
export const SessionOptions = Schema.Struct({ cwd: Schema.String, additionalDirectories: Schema.optionalKey(Schema.Array(Schema.String)), mcpServers: Schema.optionalKey(Schema.Array(McpServer)) })
export const Command = Schema.Union([
  Schema.TaggedStruct("Open", { profile: Schema.String, options: Schema.Unknown }),
  Schema.TaggedStruct("NewSession", { connection: Schema.String, options: SessionOptions }),
  Schema.TaggedStruct("ResumeSession", { connection: Schema.String, options: Schema.Struct({ ...SessionOptions.fields, sessionId: Schema.String, replayFrom: Schema.optionalKey(V2.ReplayFrom) }) }),
  Schema.TaggedStruct("Authenticate", { connection: Schema.String, methodId: Schema.String }),
  Schema.TaggedStruct("Logout", { connection: Schema.String }),
  Schema.TaggedStruct("Submit", { session: Schema.String, prompt: Schema.Array(V2.ContentBlock) }),
  Schema.TaggedStruct("Cancel", { session: Schema.String }),
  Schema.TaggedStruct("Close", { session: Schema.String }),
  Schema.TaggedStruct("Delete", { session: Schema.String }),
  Schema.TaggedStruct("Configure", { session: Schema.String, configId: Schema.String, value: Schema.Union([Schema.String, Schema.Boolean]) }),
  Schema.TaggedStruct("Mode", { session: Schema.String, modeId: Schema.String }),
  Schema.TaggedStruct("Resolve", { session: Schema.String, interactionId: Schema.String, resolution: Resolution }),
  Schema.TaggedStruct("Extension", { connection: Schema.String, method: Schema.String, params: Schema.Unknown, controllers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Int)) })
])
export type Command = typeof Command.Type
export const Admission = Schema.Struct({ window: Window, operationId: Schema.String, generation: Schema.optionalKey(Schema.Int), command: Command })
export type Admission = typeof Admission.Type
/** Admission is independent of the later agent result. Results contain data, never handles. */
export const CommandError = Schema.Union([GatewayError, AcpSessionError.AcpCapabilityUnsupported, AcpSessionError.AcpSessionBusy, AcpSessionError.AcpInteractionAlreadyResolved, AcpSessionError.AcpInteractionExpired, AcpSessionError.AcpHistoryUnavailable])
export type CommandError = typeof CommandError.Type
export const Operation = Schema.Struct({ operationId: Schema.String, status: Schema.Literals(["admitted", "succeeded", "failed", "outcomeUnknown"]), result: Schema.Unknown, error: Schema.NullOr(CommandError) })
export type Operation = typeof Operation.Type
export const AttachmentRequest = Schema.Struct({ epoch: Schema.String, workspace: Schema.String, session: Schema.String, clientId: Schema.String, takeover: Schema.optionalKey(Schema.Boolean), cursor: Schema.optionalKey(Cursor) })
export type AttachmentRequest = typeof AttachmentRequest.Type
export const Frame = Schema.Union([
  Schema.TaggedStruct("Attached", { cursor: Cursor, generation: Schema.Int, resync: Schema.Boolean, snapshot: Schema.NullOr(SessionSnapshot) }),
  Schema.TaggedStruct("Event", { cursor: Cursor, snapshot: SessionSnapshot })
])
export type Frame = typeof Frame.Type
export const Gateway = RpcGroup.make(
  Rpc.make("Hello", { payload: { version: Schema.Int, clientId: Schema.String, workspace: Schema.String }, success: Window, error: GatewayError }),
  Rpc.make("Admit", { payload: Admission, success: Operation, error: GatewayError }),
  Rpc.make("Operation", { payload: { window: Window, operationId: Schema.String }, success: Operation, error: GatewayError }),
  Rpc.make("List", { payload: { epoch: Schema.String, workspace: Schema.String, connection: Schema.String, cwd: Schema.optionalKey(Schema.String) }, success: Schema.Array(SessionListEntry), error: GatewayError }),
  Rpc.make("Closed", { payload: { epoch: Schema.String, workspace: Schema.String, connection: Schema.String }, success: Schema.Void, error: GatewayError }),
  Rpc.make("Attach", { payload: AttachmentRequest, success: Frame, error: GatewayError, stream: true })
)
