import type { McpServer, ElicitationContent } from "./AcpApp.ts"
/**
 * The application-facing ACP session API.
 *
 * `AcpClient` opens scoped agent connections; each connection exposes the
 * session operations the negotiated peer actually supports, and hands back
 * `AcpSession` handles carrying immutable snapshots, ordered observations,
 * and typed commands.
 *
 * Ownership is explicit: a session's runtime belongs to the scope that
 * created it, not to whoever is currently looking at it. Releasing an
 * observation, or interrupting a wait, never closes, deletes, or cancels an
 * agent session — only the matching command does.
 *
 * `AcpLocalClient` implements this over a direct `AcpConnector` transport; a
 * hosted/remote implementation is expected to satisfy the same contract, so
 * nothing here exposes a value that cannot be serialized across a gateway.
 * Snapshots are data; everything that needs a callback lives on a handle.
 *
 */
import type { CommandError, GatewayError } from "./AcpGateway.ts"
import * as Context from "effect/Context"
import type * as Duration from "effect/Duration"
import type * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import type * as Stream from "effect/Stream"
import type {
  Capabilities,
  ContentLimits,
  InteractionId,
  ProvisionalLimits,
  SessionId,
  SessionSnapshot,
  SubmissionId,
  SubmissionSnapshot
} from "./AcpApp.ts"
import type {
  AcpConnectionClosed,
  AcpRequestError,
  AcpTimeoutError,
  AcpTransportError,
  AcpUnsupportedVersion
} from "./AcpError.ts"
import type * as AcpProtocol from "./AcpProtocol.ts"
import type {
  AcpCancellationUnconfirmed,
  AcpHistoryUnavailable,
  AcpProvisionalOverflow,
  AcpSessionBusy,
  AcpSubscriptionOverflow
} from "./AcpSessionError.ts"
import type * as V1 from "./protocol/v1/Schema.ts"
import type * as V2 from "./protocol/v2/Schema.ts"

// -----------------------------------------------------------------------------
// Observation
// -----------------------------------------------------------------------------

/**
 * One item of an incremental observation: the state after an applied event.
 *
 * Falling behind is not an item but a stream failure — see
 * `AcpSubscriptionOverflow` on `Observed.changes`.
 */
export type Observation = { readonly _tag: "snapshot"; readonly snapshot: SessionSnapshot }

/** An atomic snapshot plus the stream of everything after it. */
export interface Observed {
  /** State at the boundary. */
  readonly snapshot: SessionSnapshot
  /**
   * Updates strictly after `snapshot`. Registered before `snapshot` was
   * taken, so no update can slip through the gap between the two.
   *
   * Fails with `AcpSubscriptionOverflow` when this observer falls further
   * behind than its delivery capacity allows: the deltas it missed are gone,
   * so it must acquire a fresh boundary with `observe`. Reporting that is the
   * deliberate alternative to letting a slow observer backpressure the
   * protocol reader or grow memory without bound.
   */
  readonly changes: Stream.Stream<Observation, AcpSubscriptionOverflow | GatewayError>
}

// -----------------------------------------------------------------------------
// Interactions
// -----------------------------------------------------------------------------

/** How a caller answers a pending permission request. */
export type PermissionResolution =
  | { readonly _tag: "selected"; readonly optionId: string }
  | { readonly _tag: "cancelled" }

/** How a caller answers a pending elicitation request. */
export type ElicitationResolution =
  | { readonly _tag: "accept"; readonly content?: ElicitationContent }
  | { readonly _tag: "decline" }
  | { readonly _tag: "cancel" }

export type InteractionResolution = PermissionResolution | ElicitationResolution

// -----------------------------------------------------------------------------
// Submissions
// -----------------------------------------------------------------------------

/**
 * A handle on one dispatched prompt.
 *
 * The three lifecycle points are deliberately separate, because the
 * protocols separate them: `dispatched` is local, `accepted` is the v2
 * insertion acknowledgement (unavailable on v1), and `outcome` is the end of
 * foreground work. Interrupting a wait here does not cancel the prompt.
 */
export interface Submission {
  readonly id: SubmissionId
  /** Current record, as it appears in the session snapshot. */
  readonly snapshot: Effect.Effect<SubmissionSnapshot>
  /**
   * Completes when the agent acknowledges insertion, carrying the agent's
   * message id. Fails with `AcpCapabilityUnsupported` on v1, where the
   * protocol has no insertion acknowledgement to report.
   */
  readonly accepted: Effect.Effect<string, OperationError>
  /**
   * Completes when this submission's foreground work ends: the v1 prompt
   * response, or the v2 completion signal.
   */
  readonly outcome: Effect.Effect<SubmissionSnapshot, OperationError>
}

// -----------------------------------------------------------------------------
// Session
// -----------------------------------------------------------------------------

/**
 * A handle on one agent session.
 *
 * The handle references a runtime owned by the scope that opened the
 * connection. Holding a handle does not keep the session alive, and dropping
 * one does not end it.
 */
export interface AcpSession {
  /** Releases local session routing after explicit owner cleanup. Sends no ACP mutation. */
  readonly release: Effect.Effect<void>
  readonly sessionId: SessionId
  readonly version: AcpProtocol.Version
  /** The current state. Always a complete, immutable projection. */
  readonly snapshot: Effect.Effect<SessionSnapshot>
  /**
   * An atomic snapshot together with the changes after it. Prefer this over
   * `snapshot` followed by `changes`: taken separately, an update applied
   * between the two calls would be missed by both.
   */
  readonly observe: Effect.Effect<Observed, never, Scope.Scope>
  /**
   * Incremental observations only. Bounded per subscriber; a subscriber that
   * falls behind fails with `AcpSubscriptionOverflow`.
   */
  readonly changes: Stream.Stream<Observation, AcpSubscriptionOverflow | GatewayError, Scope.Scope>

  /**
   * Submits a prompt as foreground work. At most one library-driven
   * foreground submission is admitted at a time: a second concurrent submit
   * fails with `AcpSessionBusy` and sends nothing.
   */
  readonly submit: (
    prompt: ReadonlyArray<V2.ContentBlock>
  ) => Effect.Effect<Submission, AcpSessionBusy | OperationError>

  /**
   * Asks the agent to cancel current work. Updates keep being applied until
   * the negotiated completion signal arrives; if it does not arrive within
   * the configured window this fails with `AcpCancellationUnconfirmed`
   * rather than reporting a cancellation that may not have happened.
   */
  readonly cancel: Effect.Effect<void, OperationError>

  /** Answers a pending interaction. Exactly one resolution is accepted. */
  readonly resolveInteraction: (
    interactionId: InteractionId,
    resolution: InteractionResolution
  ) => Effect.Effect<void, OperationError>

  /** Sets a session configuration option, where supported. */
  readonly setConfigOption: (
    configId: string,
    value: string | boolean
  ) => Effect.Effect<void, OperationError>

  /** Sets the current mode. v1 only; fails with a capability error on v2. */
  readonly setMode: (
    modeId: string
  ) => Effect.Effect<void, OperationError>

  /** Closes the session on the agent, where supported. */
  readonly close: Effect.Effect<void, OperationError>

  /** Deletes the session on the agent, where supported. */
  readonly delete: Effect.Effect<void, OperationError>
}

// -----------------------------------------------------------------------------
// Connection
// -----------------------------------------------------------------------------

export interface NewSessionOptions {
  readonly cwd: string
  readonly additionalDirectories?: ReadonlyArray<string> | undefined
  readonly mcpServers?: ReadonlyArray<McpServer> | undefined
}

export interface ResumeSessionOptions extends NewSessionOptions {
  readonly sessionId: SessionId
  /** v2 only: where replay should start. */
  readonly replayFrom?: V2.ReplayFrom
}

/** A summary entry from `session/list`. */
export interface SessionListEntry {
  readonly sessionId: SessionId
  readonly cwd: string | null
  readonly title: string | null
  readonly updatedAt: string | null
}

export type OperationError = AcpProvisionalOverflow | CommandError | AcpRequestError | AcpTimeoutError | AcpCancellationUnconfirmed

/**
 * An initialized connection to one agent.
 *
 * Every session created here shares this connection's negotiated version and
 * capabilities, and every session runtime is owned by the scope that opened
 * the connection.
 */
export interface AcpAgentConnection {
  /** Terminal connection failure; independent of observation ownership. */
  readonly closed: Effect.Effect<AcpConnectionClosed>
  /** Explicit raw extension call. Hosted implementations apply normal command admission. */
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, OperationError>
  /** Normalized capabilities plus the raw negotiated response. */
  readonly capabilities: Capabilities
  readonly negotiated: AcpProtocol.Negotiated

  /** Creates a new session. Updates arriving before the response are retained. */
  readonly newSession: (options: NewSessionOptions) => Effect.Effect<AcpSession, OperationError>

  /**
   * Resumes an existing session, replaying history where the negotiated peer
   * supports it. Fails with `AcpHistoryUnavailable` when history recovery was
   * requested but the peer cannot provide it.
   */
  readonly resumeSession: (
    options: ResumeSessionOptions
  ) => Effect.Effect<AcpSession, OperationError | AcpHistoryUnavailable>

  /** Lists sessions, where supported. */
  readonly listSessions: (cwd?: string) => Effect.Effect<ReadonlyArray<SessionListEntry>, OperationError>

  /** Authenticates with one of the advertised methods. */
  readonly authenticate: (methodId: string) => Effect.Effect<void, OperationError>

  /** Ends the authenticated session, where supported. */
  readonly logout: Effect.Effect<void, OperationError>
}

// -----------------------------------------------------------------------------
// Handlers and options
// -----------------------------------------------------------------------------

/**
 * Opt-in v1 client handlers.
 *
 * These are compatibility surfaces: v1 agents may ask the client to read and
 * write files or to run terminals. Capabilities are derived from what is
 * actually installed here, so an absent handler is never advertised.
 */
export interface V1Handlers {
  readonly readTextFile?: (
    params: V1.ReadTextFileRequest
  ) => Effect.Effect<V1.ReadTextFileResponse, never>
  readonly writeTextFile?: (
    params: V1.WriteTextFileRequest
  ) => Effect.Effect<V1.WriteTextFileResponse, never>
  readonly createTerminal?: (
    params: V1.CreateTerminalRequest
  ) => Effect.Effect<V1.CreateTerminalResponse, never>
  readonly terminalOutput?: (
    params: V1.TerminalOutputRequest
  ) => Effect.Effect<V1.TerminalOutputResponse, never>
  readonly waitForTerminalExit?: (
    params: V1.WaitForTerminalExitRequest
  ) => Effect.Effect<V1.WaitForTerminalExitResponse, never>
  readonly killTerminal?: (
    params: V1.KillTerminalRequest
  ) => Effect.Effect<V1.KillTerminalResponse, never>
  readonly releaseTerminal?: (
    params: V1.ReleaseTerminalRequest
  ) => Effect.Effect<V1.ReleaseTerminalResponse, never>
}

/**
 * Reproduces an agent-described terminal authentication invocation.
 *
 * Advertising terminal authentication without being able to run the command
 * the agent describes would be a lie, so this callback is required before
 * `auth` methods of type `terminal` are reported as usable.
 */
export type TerminalAuthCallback = (method: V1.AuthMethodTerminal | V2.AuthMethodTerminal) => Effect.Effect<void, never>

export type ConnectOptions = AcpProtocol.InitializeOptions & {
  /** Opt-in v1 filesystem/terminal handlers. Ignored on v2. */
  readonly v1Handlers?: V1Handlers | undefined
  /** Enables advertising terminal authentication methods. */
  readonly terminalAuth?: TerminalAuthCallback | undefined
  /** Retained-content budgets. Defaults are finite; see `defaultContentLimits`. */
  readonly limits?: Partial<ContentLimits> | undefined
  /** Provisional update-routing bounds during new/resume. */
  readonly provisional?: Partial<ProvisionalLimits> | undefined
  /** Events buffered per observer before it is told to resynchronize. Default 256. */
  readonly observerCapacity?: number | undefined
  /** How long a pending interaction may wait before it expires. Default: no deadline. */
  readonly interactionTimeout?: Duration.Input | undefined
  /** How long `cancel` waits for confirmation. Default 10 seconds. */
  readonly cancelTimeout?: Duration.Input | undefined
}

export type ConnectError =
  | GatewayError
  | AcpTransportError
  | AcpConnectionClosed
  | AcpRequestError
  | AcpTimeoutError
  | AcpUnsupportedVersion

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

/**
 * Opens scoped agent connections.
 *
 * The connection, and every session runtime under it, is owned by the
 * caller's scope. Putting that scope in a host later is what makes the same
 * contract usable from a hosted client without touching protocol code.
 */
export class AcpClient extends Context.Service<AcpClient, {
  readonly connect: (
    options: ConnectOptions
  ) => Effect.Effect<AcpAgentConnection, ConnectError, Scope.Scope>
}>()("effect-acp/AcpClient") {}
