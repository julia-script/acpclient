# acp-protocol-peer Specification

## Purpose

Provide scoped bidirectional ACP communication with correct version negotiation, request correlation, cancellation, and failure behavior.

## Requirements

### Requirement: Explicit protocol negotiation
The peer SHALL send the highest enabled protocol version, select one supported version from initialization, and validate subsequent messages against it. V2 SHALL require explicit enablement while draft. Unsupported versions SHALL close the connection with a typed failure; an active connection SHALL NOT be silently reinitialized.

#### Scenario: V2 preference with v1 response
- **WHEN** versions 2 and 1 are enabled and the agent returns a valid v1 initialization response
- **THEN** the peer uses v1 codecs and the capabilities actually negotiated on that connection

#### Scenario: Unsupported negotiated version
- **WHEN** the agent selects a version outside the enabled set
- **THEN** initialization fails and the transport is released without sending session requests

### Requirement: Independent bidirectional requests
Each side SHALL be able to initiate requests while other requests are pending. Responses SHALL correlate by ID within the correct direction, and notifications SHALL NOT receive responses.

#### Scenario: Reverse request during prompt
- **WHEN** an agent requests permission while a client request with the same numeric ID is pending
- **THEN** each request is handled and resolved independently without deadlock or collision

#### Scenario: Notification dispatch
- **WHEN** a valid notification reaches the peer
- **THEN** it is dispatched without creating a response or pending-response entry

### Requirement: ACP JSON-RPC wire behavior
The peer SHALL implement the selected ACP baseline's JSON-RPC envelopes, error codes, and batch rules without emitting private framework control messages. Invalid JSON SHALL be distinguishable from an invalid request; invalid notifications SHALL never receive method error responses.

#### Scenario: Mixed batch
- **WHEN** a nonempty batch contains a request, a notification, and an invalid entry
- **THEN** the response contains the request result and invalid-entry error but no notification response

#### Scenario: Empty and notification-only batches
- **WHEN** the peer receives an empty batch or a valid notification-only batch
- **THEN** it returns a single invalid-request error for the empty batch and no response for the notification-only batch

#### Scenario: Malformed JSON and unknown request method
- **WHEN** a frame contains malformed JSON or a request names an unsupported method
- **THEN** the peer emits the corresponding parse-error or method-not-found response according to JSON-RPC rules

### Requirement: Cancellation and connection termination
The peer SHALL expose request cancellation separately from session cancellation, maintain correlation until resolution or terminal cleanup, and settle pending requests when their connection closes. A cancelled local wait SHALL NOT be represented as confirmed remote cancellation.

#### Scenario: Peer ignores cancellation
- **WHEN** a caller stops waiting and the remote side has not confirmed cancellation
- **THEN** the caller observes the local interruption or deadline and no successful remote cancellation is fabricated

#### Scenario: Transport exits with pending calls
- **WHEN** the transport closes while requests are pending
- **THEN** every pending caller receives a terminal failure and owned handler resources are released

### Requirement: Bounded communication resources
The peer SHALL provide finite configured frame and pending-request limits. Exceeding a limit SHALL produce an explicit failure or admission rejection without silent message loss or unbounded allocation.

#### Scenario: Request capacity reached
- **WHEN** a caller sends a new request after pending-request capacity is exhausted
- **THEN** admission fails explicitly and no untracked request is sent
