# Spec Delta

## Purpose

Allow browser and desktop-renderer clients to reach stdio ACP agents through a documented bidirectional WebSocket transport bridge.

## ADDED Requirements

### Requirement: Documented custom WebSocket profile
The adapter SHALL negotiate the `effect-acp-jsonrpc-v1` WebSocket subprotocol and carry one complete JSON text frame per WebSocket message. The profile SHALL be identified as custom and independent of the negotiated ACP version. Binary frames and oversized messages SHALL cause explicit transport closure.

#### Scenario: Supported profile and ACP v2
- **WHEN** a WebSocket selects the custom profile and its ACP initialization negotiates v2
- **THEN** the connection uses the same framing profile while carrying v2 messages

#### Scenario: Missing profile or binary frame
- **WHEN** the peer fails to select the required subprotocol or sends a binary frame
- **THEN** the adapter rejects or closes the connection instead of interpreting incompatible data

### Requirement: Transparent bidirectional relay
The bridge SHALL preserve request IDs, method payloads, response errors, notifications, batches, and extension data in both directions, apart from transport delimiters. It SHALL NOT initialize on behalf of endpoints, rewrite protocol versions, or filter agent-initiated requests.

#### Scenario: Permission request during prompt
- **WHEN** the agent sends a permission request while the browser's prompt is pending
- **THEN** the browser receives the request and its response reaches the agent unchanged

#### Scenario: Unknown extension batch
- **WHEN** a batch includes an unknown extension method and nested metadata
- **THEN** the receiving endpoint gets the original payload and batch structure

### Requirement: Authorized composable route mounting
Applications SHALL be able to mount the bridge on an existing HTTP server with application-supplied authentication, origin policy, and authorized launch-profile resolution. Authorization SHALL occur before process creation.

#### Scenario: Unauthorized upgrade
- **WHEN** an upgrade request fails authentication, origin policy, or workspace authorization
- **THEN** the request is rejected and no agent process is spawned

#### Scenario: Browser supplies an arbitrary executable
- **WHEN** a browser attempts to select a command outside its permitted host launch profiles
- **THEN** the route rejects the selection rather than executing that command

### Requirement: Connection-scoped cleanup and bounded relay
The bridge SHALL preserve per-direction order, bound buffering, and close owned resources when either side terminates or cannot make progress within configured limits. It SHALL NOT reconnect automatically or claim session recovery after browser loss.

#### Scenario: Browser disconnects
- **WHEN** the browser closes a connection-scoped bridge
- **THEN** the bridge releases its owned child connection and reports closure without promising retained session state

#### Scenario: Stalled writer
- **WHEN** a downstream writer remains blocked beyond the configured pressure deadline
- **THEN** the bridge fails explicitly and releases both owned sides without silent frame dropping
