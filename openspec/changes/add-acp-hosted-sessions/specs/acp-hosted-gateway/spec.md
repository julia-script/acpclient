# Spec Delta

## Purpose

Expose retained host sessions to remote applications through a versioned command and event protocol with safe retry and ownership behavior.

## ADDED Requirements

### Requirement: Independent gateway compatibility and client parity
The gateway SHALL negotiate its own application protocol version independently of ACP and expose the supported behaviors of the common session API. It SHALL identify itself as a package-owned gateway rather than a standard ACP endpoint.

#### Scenario: Unsupported gateway version
- **WHEN** a client requests an unsupported gateway version
- **THEN** the connection fails before any agent command is admitted

#### Scenario: Same supported session operation locally and remotely
- **WHEN** an application performs a supported session operation using either implementation
- **THEN** it observes equivalent session semantics, including v1 limitations and v2 acceptance/completion separation

### Requirement: Host-owned command admission
Mutating commands SHALL be recorded before execution, have stable client operation identities, and continue independently of the initiating RPC after admission. Host admission SHALL NOT be presented as agent acceptance.

#### Scenario: Browser disconnects after admission
- **WHEN** the gateway admits a prompt and the browser loses its RPC connection
- **THEN** the host continues owning the submission and a later authorized lookup returns its current outcome

#### Scenario: Agent has not acknowledged insertion
- **WHEN** the host has accepted a command but no v2 prompt result has arrived
- **THEN** the client sees host acceptance without an invented agent message ID or acceptance confirmation

### Requirement: Bounded command retry guarantees
Within a valid server-issued retry window, a repeated operation identity with the same payload SHALL return the retained operation rather than execute again. Reuse with a different payload SHALL fail. Expired or previous-host windows SHALL be rejected without dispatch, and live retry records SHALL NOT be evicted to admit additional commands.

#### Scenario: Response lost and command retried
- **WHEN** a client repeats a command in its valid retry window after losing the gateway response
- **THEN** at most one ACP mutation is forwarded and the existing operation status is returned

#### Scenario: Operation ID reused with another payload
- **WHEN** a retained operation ID is submitted with different command data
- **THEN** the gateway returns a conflict without changing or rerunning the operation

#### Scenario: Retry after outcome eviction
- **WHEN** a command's retry window has expired and its outcome has been evicted
- **THEN** a replay with that window is rejected rather than treated as a new command

#### Scenario: Ledger reaches capacity
- **WHEN** admitting a new command would exceed configured capacity while existing records remain retryable
- **THEN** admission fails explicitly without evicting those records or dispatching the new mutation

### Requirement: Authorization on every session surface
The gateway SHALL bind session metadata, attachments, cursors, command windows, operations, and interaction responses to authenticated ownership and current control authority. Process launch configuration SHALL come from authorized host profiles. The HTTP route SHALL apply an explicit origin policy before accepting browser connections.

#### Scenario: Another user's handle or token
- **WHEN** a principal presents another owner's session handle, event cursor, or command token
- **THEN** access is denied without exposing retained content or admitting work

#### Scenario: Revoked controller sends a command
- **WHEN** a controller whose generation has been replaced attempts a new mutation
- **THEN** admission is rejected even if its connection remains open

### Requirement: Browser-safe remote integration and sanitized errors
The remote client SHALL run without process/server dependencies and SHALL mount through application-provided server integration. Serialized errors SHALL retain actionable categories without leaking internal causes or credentials; default telemetry SHALL exclude content bodies and secrets.

#### Scenario: Host handler fails with sensitive context
- **WHEN** an internal handler fails while holding a credential or filesystem payload
- **THEN** the client receives a safe typed failure and default logs do not include the sensitive payload
