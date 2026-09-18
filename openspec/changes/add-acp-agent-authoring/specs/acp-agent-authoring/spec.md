# Spec Delta

## Purpose

Let developers construct ACP agents from typed effectful handlers while preserving negotiated protocol behavior and injectable application dependencies.

## ADDED Requirements

### Requirement: Handler capabilities are validated before serving
Agent construction SHALL reject advertisements that require missing handlers. Advertised session, authentication, and optional feature surfaces SHALL match the negotiated protocol version and actual installed support.

#### Scenario: Incomplete v2 session baseline
- **WHEN** an agent advertises v2 sessions without a required baseline lifecycle handler
- **THEN** construction fails with the missing handler identified before accepting connections

#### Scenario: Authentication methods without logout
- **WHEN** an agent advertises v2 authentication methods but lacks the required logout handler
- **THEN** configuration fails rather than serving an inconsistent capability surface

### Requirement: Prompt insertion precedes v2 acknowledgement
The agent API SHALL separate message insertion from foreground execution. V2 acknowledgement SHALL follow successful insertion and include the agent-generated message ID; processing and updates SHALL continue after that acknowledgement. V1 prompt responses SHALL follow their turn-completion semantics.

#### Scenario: Queued but not inserted input
- **WHEN** a prompt has only been queued and insertion has not succeeded
- **THEN** no successful v2 insertion acknowledgement is emitted

#### Scenario: Processing continues after acknowledgement
- **WHEN** insertion succeeds and foreground execution subsequently emits messages
- **THEN** the v2 response returns its canonical message ID and later output/completion is delivered through session updates

### Requirement: Version-aware updates and retained replay
Agent helpers SHALL validate emitted updates and replay against the negotiated version. Retained v2 messages SHALL preserve agent identities, and replayed chunks SHALL use the required reset/replacement semantics. Storage retention guarantees SHALL remain explicit properties of the supplied store.

#### Scenario: Replay a retained message as chunks
- **WHEN** a v2 agent replays a retained message from its beginning using chunks
- **THEN** it preserves the message ID and resets prior content before appending replay chunks

### Requirement: Client interactions and cancellation are scoped
The agent SHALL provide typed permission and supported elicitation calls without blocking unrelated message handling. Session cancellation SHALL cancel owned foreground work and emit the correct version-specific completion after final updates; cancelling an individual request SHALL remain distinct.

#### Scenario: Cancel a running v2 session
- **WHEN** session cancellation succeeds while execution has pending final updates
- **THEN** those updates are emitted before the idle state carrying the cancelled stop reason

#### Scenario: Optional client capability absent
- **WHEN** an author requests an elicitation mode not advertised by the client
- **THEN** the helper rejects the operation before sending an unsupported request

### Requirement: Model-independent serving and protocol-only stdout
Authors SHALL be able to supply application services and serve over current-process stdio without a model-provider dependency. Stdout SHALL contain only ACP frames, with diagnostics separated onto stderr or configured telemetry.

#### Scenario: Deterministic example agent
- **WHEN** the example agent is launched without model credentials
- **THEN** it can negotiate, create a session, emit deterministic output, handle permission/cancellation, and keep diagnostics off protocol stdout
