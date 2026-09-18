# Spec Delta

## Purpose

Keep host-owned ACP sessions usable through browser disconnects and restore retained state and interactions with explicit recovery limits.

## ADDED Requirements

### Requirement: Session lifetime independent of attachment
Hosted sessions SHALL continue processing agent messages and admitted commands after a browser attachment closes, for the configured retention interval. The host SHALL require finite retention, interaction, shutdown, event, and content policies.

#### Scenario: Refresh during output
- **WHEN** a browser refreshes while its retained agent session is producing output
- **THEN** the host continues applying output and the browser can reattach without starting another agent or sending ACP initialization again

#### Scenario: Reattach before expiry
- **WHEN** an authorized attachment returns before the final retention deadline
- **THEN** the host cancels expiry and preserves the existing session owner

### Requirement: Atomic snapshot and ordered event recovery
Attachments SHALL receive a consistent snapshot or retained event replay followed by live events without a gap. Events SHALL have identities scoped to host lifetime and hosted session. Duplicate delivery SHALL NOT apply a state transition twice.

#### Scenario: Update races with snapshot attachment
- **WHEN** an update is processed while an attachment snapshot is captured
- **THEN** it appears either in the snapshot or after its sequence boundary, without being omitted or applied twice

#### Scenario: Retained cursor replay
- **WHEN** a client reconnects with a valid retained cursor and its previous state
- **THEN** only subsequent events are replayed before live delivery continues

#### Scenario: Cursor falls behind retention
- **WHEN** a valid client cursor predates the retained journal
- **THEN** the host returns a fresh snapshot and explicit resynchronization metadata rather than an incomplete delta stream

#### Scenario: Subscriber overflows
- **WHEN** a subscriber cannot keep up within its configured delivery capacity
- **THEN** it is instructed to resynchronize and does not indefinitely block other sessions or the agent reader

### Requirement: Explicit host and agent recovery boundaries
Host restart SHALL invalidate prior host-epoch handles and recovery tokens. Agent connection loss SHALL be distinguished from browser detachment. Uncertain prompt outcomes SHALL remain uncertain unless protocol evidence resolves them; absence from replay SHALL NOT prove nonexecution.

#### Scenario: Old handle after host restart
- **WHEN** a browser reattaches using a handle from a previous host lifetime
- **THEN** it receives a restarted/unavailable result instead of a claim that the old live session was restored

#### Scenario: ACP response lost after dispatch
- **WHEN** the host loses its ACP connection before receiving a prompt result
- **THEN** it records an uncertain outcome and does not resend the prompt automatically

### Requirement: Single controller and owned interactions
Each session SHALL have at most one active controller generation. Authorized takeover SHALL revoke stale control. Pending interactions SHALL survive detach within their deadline and accept only one valid resolution; disconnection SHALL NOT grant permission.

#### Scenario: Refresh during permission prompt
- **WHEN** an attachment disappears while a permission request is pending and returns before expiry
- **THEN** the same pending interaction is available to the new controller and can produce only one agent response

#### Scenario: Stale controller response
- **WHEN** an old controller resolves an interaction after authorized takeover
- **THEN** its response is rejected without affecting the current interaction

#### Scenario: Interaction expires while detached
- **WHEN** the configured interaction deadline passes without a response
- **THEN** the host settles it with the applicable cancellation outcome and later user replies are rejected as stale

### Requirement: Bounded cleanup respects shared ownership
After retention expires, the host SHALL stop admitting new mutations, cancel or close retained work using negotiated behavior, and release owned resources within its cleanup deadline. Closing one session SHALL NOT silently terminate a healthy connection still owned by other sessions.

#### Scenario: One of two sessions expires
- **WHEN** a detached session expires while another session on the connection remains owned
- **THEN** the expired session is cleaned up without intentionally terminating the other session's healthy process

#### Scenario: Agent ignores shutdown
- **WHEN** the final connection owner expires and its agent does not cooperate with cleanup
- **THEN** the host releases its owned process at the configured deadline and reports termination to remaining waits
