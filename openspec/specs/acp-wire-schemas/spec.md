# acp-wire-schemas Specification

## Purpose

Provide versioned, runtime-validated ACP data contracts that applications can use without losing protocol distinctions or extension data.

## Requirements

### Requirement: Separate versioned baseline contracts
The package SHALL expose independently identifiable v1 and v2 baseline request, result, notification, and error codecs with corresponding static types. Enabling v2 SHALL NOT enable additional unstable features implicitly.

#### Scenario: Version-specific prompt responses
- **WHEN** a consumer decodes a v1 completion response and a v2 insertion acknowledgement
- **THEN** each is validated against its own version's contract and the consumer can distinguish their meanings

#### Scenario: Draft feature isolation
- **WHEN** a connection enables the v2 baseline without an unstable feature
- **THEN** the feature is not advertised or sent solely because v2 was selected

### Requirement: Lossless patch and extension semantics
Codecs SHALL preserve omitted fields, explicit nulls, concrete values, metadata, and unknown variants where the upstream schema permits them. Malformed known variants SHALL fail validation instead of matching an unknown-variant fallback.

#### Scenario: Three-state update round trip
- **WHEN** updates respectively omit content, clear it with null, and replace it with a value
- **THEN** decoding and encoding preserve all three distinct states

#### Scenario: Known variant is malformed
- **WHEN** a known discriminator is paired with invalid required fields
- **THEN** validation fails even if the enclosing type supports future variants

#### Scenario: Forward-compatible data round trip
- **WHEN** a permitted unknown variant containing nested raw data and metadata is decoded and encoded
- **THEN** its payload and discriminator are preserved

### Requirement: Reproducible schema provenance
Published codecs SHALL identify their upstream schema inputs and revisions. Regeneration SHALL detect drift and fail on unsupported validation constructs rather than silently weakening validation.

#### Scenario: Unsupported upstream keyword
- **WHEN** an updated schema introduces a validation construct the generator cannot represent
- **THEN** generation fails with the affected definition and construct identified

#### Scenario: Repeatable generation
- **WHEN** the same pinned inputs and generator are used twice
- **THEN** outputs are identical and the provenance manifest identifies those inputs

### Requirement: Runtime-independent contract imports
Consumers SHALL be able to import wire contracts and core types in a browser runtime without loading process or server implementations.

#### Scenario: Browser-only schema consumer
- **WHEN** a browser application imports the versioned schema entry points
- **THEN** no Node/Bun process API or filesystem access is required
