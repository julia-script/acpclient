# Design

## Context

See [proposal.md](proposal.md) for motivation. The current package contains only `src/index.ts`, Bun configuration, and Effect `4.0.0-rc.115`. No existing library API or tests need migration. The vendored ACP schemas contain 170 v1 and 175 v2 definitions, including references, unions, intersections, and negated constraints used by fallback variants. The vendored Effect MCP implementation demonstrates schema-backed operations and scoped transport layers, but its default RPC serializer also emits Effect-specific control messages.

## Goals / Non-Goals

**Goals:** Establish a role-neutral duplex peer with strict ACP wire behavior, separate version surfaces, browser-safe contracts, and runtime-injected subprocess access. Make every resource lifetime explicit.

**Non-Goals:** Session presentation state, remote hosting, generic JSON Schema tooling, a standard HTTP transport, or a model-provider abstraction.

## Decisions

### A dedicated ACP peer built with public Effect primitives

Implement correlation and dispatch in `AcpConnection` using `Effect`, scoped fibers, `Deferred`, and bounded queues. Requests have a direction-specific registry, so an incoming request and an outgoing request can use the same ID. Method declarations bind request/result/error codecs and whether the operation is a request or notification. This borrows the structure of Effect's MCP declarations without importing its internal runtime.

Alternative: adapt Effect RPC's default JSON-RPC serialization. Its `@effect/rpc/*` controls, error encoding, streaming chunks, and acknowledgement behavior would require an additional compatibility layer. A small explicit peer makes ACP behavior reviewable; reserve Effect RPC for the owned gateway. Revisit only if a public ACP-compatible adapter demonstrably reduces code without weakening the specifications.

### Static generated schemas with a bounded upstream vocabulary

Add a development-only generator that reads the pinned v1/v2 baseline JSON schemas and emits separate static Effect Schema modules. Implement the JSON Schema constructs actually present, including `$ref`, `allOf`, `anyOf`, `oneOf`, and `not`; fail generation on unsupported validation keywords instead of silently broadening acceptance. Preserve optionality, nullability, numeric/string constraints, and the upstream dialect's treatment of formats. Keep refinements that require handwritten interpretation in small reviewed overrides keyed to upstream definitions.

Generated outputs and a provenance manifest are checked in; `generate:check` regenerates to temporary output and fails on drift. The manifest records schema paths, hashes from ARCHITECTURE.md, generator version, and selected baseline/draft surfaces. Runtime consumers do not read vendored files or fetch schemas. Add a development-only JSON Schema validator configured for the source dialect as an independent codec-conformance oracle.

Alternative: handwritten copies of every wire schema would be easy to start but hard to keep aligned across two evolving versions. Runtime-only JSON Schema conversion would not provide the same static public types. The generator is deliberately ACP-specific, not a new general JSON Schema product.

### Separate framing from envelope and payload interpretation

Define the transport boundary as complete UTF-8 JSON text frames; stdio strips/adds newline delimiters, while other adapters preserve their own message framing. JSON parsing and recoverable parse-error responses remain in the peer. A frame can contain one JSON-RPC message or a batch. This resolves the architecture's need to distinguish malformed JSON from invalid envelopes without turning every recoverable parse error into a fatal transport failure.

Serialize writes; process responses immediately and dispatch incoming request handlers to scoped fibers so a reverse request cannot deadlock a pending call. Route notifications without responses. Assemble batch responses only for request/invalid entries and preserve standard JSON-RPC empty-batch/error behavior. Apply bounded frame and pending-request limits, with typed capacity/closure errors; do not drop messages silently.

### Version policy and bootstrap

Default supported versions to v1 while v2 remains draft; callers opt into `[2, 1]` or v2-only explicitly. Send the highest enabled version and select exactly one adapter from the response. Keep the raw initialize response until its protocol version is known, then validate with that version's codec. Keep baseline support separate from unstable feature enablement.

The v1/v2 initialization field shapes differ. Preserve the actual advertisement sent, and never claim v1 client execution capabilities that were absent from it. Accept compliant downgrade responses; callers needing v1-only capabilities can select a fresh v1 connection deliberately. Do not silently repeat initialization after an invalid response or transport failure. Verify with strict independently parsed v1/v2 transcripts, not only the new peer talking to itself.

### Runtime boundaries and verification setup

`AcpConnector` is a `Context.Service` that opens scoped transport values. Stdio depends on public `ChildProcessSpawner` services, with matching Node/Bun platform layers used only by examples/tests and supplied by applications. In-memory paired transports exercise the same peer contract. Keep browser entry points free of Node/Bun imports.

Use the existing Bun toolchain for checks and tests, add Effect-compatible deterministic clock/concurrency tests, and introduce library export/typecheck configuration as part of this change. No package publishing is performed by these tasks.

## Risks / Trade-offs

- Schema unions can accept malformed known variants through fallback branches -> preserve `not` exclusions and test each known discriminator against malformed payloads.
- A new peer duplicates some RPC machinery -> keep it restricted to ACP and verify with independent protocol fixtures, including bidirectional IDs and batches.
- Draft drift -> pin inputs and review generation diffs explicitly; do not infer compatibility from protocol version alone.
- Stdio backpressure and stderr can stall a child -> drain stderr separately, serialize writes, bound input, and settle all pending calls on process exit.

## Migration Plan

Replace the starter entry point with library exports only after implementing the foundation. Add new modules and tooling without modifying `repos/`. Run generation, type, protocol, subprocess, and browser-import checks before making dependent changes consume the API. Rollback consists of reverting these additive library/tooling changes; there is no persisted data migration.
