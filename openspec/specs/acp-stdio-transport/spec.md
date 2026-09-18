# acp-stdio-transport Specification

## Purpose

Allow applications to communicate with spawned ACP agents over standard input and output with reliable framing and scoped cleanup.

## Requirements

### Requirement: Newline framing across arbitrary byte boundaries
The transport SHALL read and write UTF-8 newline-delimited ACP frames, handling fragmented code points and lines without altering JSON content. Writes SHALL remain ordered and SHALL NOT interleave frames.

#### Scenario: Fragmented multibyte message
- **WHEN** a child's output splits a multibyte character and the final newline across separate reads
- **THEN** the receiver obtains one intact frame after the delimiter arrives

#### Scenario: Multiple and oversized frames
- **WHEN** one read contains multiple complete frames followed by a partial frame that exceeds the configured limit
- **THEN** complete frames remain ordered and the oversized partial frame terminates with an explicit framing failure

### Requirement: Independent diagnostics and process lifecycle
The transport SHALL keep stderr separate from ACP output, observe child exit, and release an owned process when its scope closes. Configured diagnostic capture SHALL be bounded; stdout SHALL never be interpreted as diagnostic text.

#### Scenario: Heavy stderr during interaction
- **WHEN** an agent writes diagnostics while answering a request
- **THEN** stderr handling does not contaminate protocol frames or prevent request completion

#### Scenario: Scope closes or process exits
- **WHEN** the owner closes the connection or the child exits unexpectedly
- **THEN** input/output resources are released and the peer is informed of terminal closure without leaving pending waits

### Requirement: Runtime-injected process execution
Consumers SHALL supply the process runtime and launch configuration. Importing the core client contracts SHALL NOT select or start a process implementation.

#### Scenario: No process runtime supplied
- **WHEN** an application attempts to construct a stdio connection without the required runtime capability
- **THEN** construction cannot succeed implicitly by falling back to a global process API
