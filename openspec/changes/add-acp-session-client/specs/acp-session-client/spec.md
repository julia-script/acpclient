# Spec Delta

## Purpose

Give applications a transport-independent session API with observable agent state, typed operations, and explicit v1/v2 compatibility limits.

## ADDED Requirements

### Requirement: Capability-aware session operations
The client SHALL expose session creation, listing, resumption, closure, deletion, prompting, configuration, and authentication where supported, and SHALL reject unsupported operations or content before dispatch. It SHALL expose negotiated version and capability data.

#### Scenario: Unsupported session operation
- **WHEN** an application invokes an operation the negotiated peer does not support
- **THEN** it receives a typed capability failure and no corresponding ACP request is sent

#### Scenario: Version-aware history request
- **WHEN** history is requested on a v2 session or a v1 session with load support
- **THEN** the client uses the negotiated replay operation and reports when requested history recovery is unavailable

### Requirement: Distinct submission and foreground lifecycles
The client SHALL distinguish local submission, agent acceptance, and session foreground completion. It SHALL reconcile v2 updates and acknowledgements by request and agent message identity regardless of arrival order. Busy sessions SHALL reject additional library-driven foreground submissions until the current submission/work is released by protocol evidence or terminal failure.

#### Scenario: User update precedes acknowledgement
- **WHEN** a v2 user-message update arrives before its prompt response
- **THEN** acknowledgement associates the submission with the same message without adding a duplicate or marking foreground work complete

#### Scenario: V1 prompt remains pending
- **WHEN** a v1 agent is processing a prompt
- **THEN** early agent acceptance is represented as unavailable and inferred foreground state is distinguishable from agent-reported state

#### Scenario: Busy submission race
- **WHEN** two callers submit foreground prompts concurrently to an idle session
- **THEN** at most one is admitted and the other receives a typed busy result without an extra prompt being sent

### Requirement: Complete observable session projection
The client SHALL expose immutable snapshots and ordered observations of messages, tool calls, plans, display terminals, configuration, available commands, usage, and interactions. State updates SHALL follow the negotiated protocol's patch, replacement, clearing, and chunk semantics. Raw versioned updates and permitted unknown variants SHALL remain observable.

#### Scenario: Replace accumulated chunks
- **WHEN** chunks append content and a subsequent whole-message update replaces that content
- **THEN** the snapshot contains the replacement followed only by chunks received after it

#### Scenario: Terminal snapshot and byte chunks
- **WHEN** a terminal replacement snapshot is followed by independently encoded byte chunks
- **THEN** the terminal projection replaces prior output and appends decoded bytes in order without exposing a client execution handle

#### Scenario: Update during new or resume
- **WHEN** updates arrive before the session lifecycle request completes
- **THEN** the client retains them within configured bounds and includes them in the established session observation

### Requirement: Honest v1 compatibility
The client SHALL preserve v1-specific modes, optional lifecycle methods, and installed filesystem/terminal handlers. Locally synthesized IDs and inferred states SHALL be marked as such and SHALL NOT claim durable agent identity or v2 acceptance guarantees.

#### Scenario: Missing message ID during replay
- **WHEN** a v1 replay contains messages without agent IDs
- **THEN** the client uses explicitly local identities and does not match unrelated submissions by identical content

#### Scenario: Execution handler absent
- **WHEN** a v1 connection has no installed terminal handler
- **THEN** it does not advertise terminal execution support

### Requirement: One-shot user interactions
Permissions and supported elicitation requests SHALL be exposed as pending data with exactly one accepted resolution. Waiting for user input SHALL NOT block other session updates or request responses. Deadlines and cancellation SHALL use the interaction's applicable protocol response.

#### Scenario: Duplicate interaction response
- **WHEN** two callers attempt to resolve the same interaction
- **THEN** only one resolution is sent and the other receives an already-resolved result

#### Scenario: User input is delayed
- **WHEN** an interaction is awaiting a user response
- **THEN** unrelated protocol messages continue to be processed and a configured deadline can settle the request

### Requirement: Distinct cancellation and observation ownership
Releasing observations or interrupting a local wait SHALL NOT implicitly close, delete, or cancel an agent session. Explicit session cancellation SHALL resolve pending permission requests appropriately, continue accepting final updates, and distinguish confirmed cancellation from timeout or connection failure.

#### Scenario: Unsubscribe during foreground work
- **WHEN** the last UI observer unsubscribes while its owning connection remains open
- **THEN** agent processing continues and the session runtime continues applying updates

#### Scenario: Updates after cancel
- **WHEN** the client requests cancellation and receives tool updates before the negotiated completion signal
- **THEN** those updates are applied and cancellation is not confirmed prematurely

### Requirement: Bounded observations and content
The client SHALL enforce finite configured subscriber and content limits, expose truncation, and report when an incremental observer must resynchronize. Snapshot acquisition with subsequent observation SHALL not omit an update at the handoff boundary.

#### Scenario: Slow observer exceeds capacity
- **WHEN** an observer falls behind beyond its delivery capacity
- **THEN** it receives an explicit resynchronization condition while protocol processing continues

#### Scenario: Transcript exceeds retained-content budget
- **WHEN** retained content exceeds its configured budget
- **THEN** the snapshot reports its truncation and memory growth remains bounded
