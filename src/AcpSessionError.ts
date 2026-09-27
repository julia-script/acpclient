/**
 * Typed failures for the AcpClient/AcpSession surface and its runtime.
 *
 */
import * as Schema from "effect/Schema"
import type { SessionVersion } from "./AcpApp.ts"

/** An operation was rejected before dispatch because the peer lacks support. */
export class AcpCapabilityUnsupported extends Schema.TaggedError<AcpCapabilityUnsupported>()(
  "AcpCapabilityUnsupported",
  {
    operation: Schema.String,
    version: Schema.Union([Schema.Literal(1), Schema.Literal(2)]),
    detail: Schema.optional(Schema.String)
  },
  { identifier: "effect-acp/AcpSessionError/AcpCapabilityUnsupported" }
) {}

/** A foreground submission was rejected while the session foreground is busy. */
export class AcpSessionBusy extends Schema.TaggedError<AcpSessionBusy>()("AcpSessionBusy", {
  message: Schema.String,
  submissionId: Schema.optional(Schema.String)
}, { identifier: "effect-acp/AcpSessionError/AcpSessionBusy" }) {}

/** An interaction was already resolved; only one resolution is accepted. */
export class AcpInteractionAlreadyResolved extends Schema.TaggedError<AcpInteractionAlreadyResolved>()(
  "AcpInteractionAlreadyResolved",
  { interactionId: Schema.String },
  { identifier: "effect-acp/AcpSessionError/AcpInteractionAlreadyResolved" }
) {}

/** A pending interaction expired before it could be resolved. */
export class AcpInteractionExpired extends Schema.TaggedError<AcpInteractionExpired>()(
  "AcpInteractionExpired",
  { interactionId: Schema.String },
  { identifier: "effect-acp/AcpSessionError/AcpInteractionExpired" }
) {}

/**
 * Session cancellation was not confirmed within the configured window: the
 * agent may still be processing. Final updates already received are applied.
 */
export class AcpCancellationUnconfirmed extends Schema.TaggedError<AcpCancellationUnconfirmed>()(
  "AcpCancellationUnconfirmed",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
  { identifier: "effect-acp/AcpSessionError/AcpCancellationUnconfirmed" }
) {}

/** History replay was requested but is not available for the negotiated peer. */
export class AcpHistoryUnavailable extends Schema.TaggedError<AcpHistoryUnavailable>()(
  "AcpHistoryUnavailable",
  {
    sessionId: Schema.String,
    operation: Schema.Literals(["load", "replay"]),
    detail: Schema.optional(Schema.String)
  },
  { identifier: "effect-acp/AcpSessionError/AcpHistoryUnavailable" }
) {}

/** Provisional update routing overflowed its configured bound. */
export class AcpProvisionalOverflow extends Schema.TaggedError<AcpProvisionalOverflow>()(
  "AcpProvisionalOverflow",
  { sessionId: Schema.String, limit: Schema.Finite },
  { identifier: "effect-acp/AcpSessionError/AcpProvisionalOverflow" }
) {}

/** A runtime capacity limit was exceeded by explicit wiring. */
export class AcpSubscriptionOverflow extends Schema.TaggedError<AcpSubscriptionOverflow>()(
  "AcpSubscriptionOverflow",
  { message: Schema.String },
  { identifier: "effect-acp/AcpSessionError/AcpSubscriptionOverflow" }
) {}

/** Failure set of library-driven foreground submission and interaction calls. */
export type AcpClientCallError =
  | AcpCapabilityUnsupported
  | AcpSessionBusy
  | AcpInteractionAlreadyResolved
  | AcpInteractionExpired

export type SessionVersionType = SessionVersion
