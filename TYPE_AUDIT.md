# Type and transport audit

Reviewed package-owned TypeScript under `src/`, `scripts/`, `examples/`, and
`test/`, including generated wire declarations. Vendored repositories were
read-only references. This records the audit; it does not establish new
repository conventions.

## Service structure

The reference is Effect v4's
[`McpServer`](repos/effect/packages/effect/src/unstable/ai/McpServer.ts) and
[`McpProtocol`](repos/effect/packages/effect/src/unstable/ai/McpProtocol.ts):
protocol consumers depend on a service, and concrete transport layers provide
that service.

- `AcpTransport.AcpTransport` is a `Context.Service` for one scoped duplex
  connection. Stdio, WebSocket, process stdio, and in-memory layers provide it.
- `AcpConnection.make` requires `AcpTransport`; `AcpConnection.layer` provides
  the JSON-RPC connection service. Agent serving requires the same transport.
- `AcpConnector.layer(transportLayer)` provides a lazy factory for clients that
  need multiple connections. It captures platform dependencies and builds a
  fresh transport layer in each caller's scope. Tests verify separate resource
  lifetimes, dependency injection, and acquisition only on connect.
- Bridges explicitly own two transport values, since each endpoint has its own
  acquisition and lifetime. Transport factories remain available for this use.

This replaces the previous arrangement where transport `layer` exports supplied
a connector factory while the transport itself was only a TypeScript interface.

## Types repaired

Known MCP server configurations, replay cursors, content, configuration values,
interaction requests/outcomes, session lists, initialization capabilities,
agent peers, and submission progress now retain their protocol types. Standard
client operations use typed method descriptors and results. Version-specific
initialization is decoded before modifying its capabilities. Reducer helpers
receive concrete tool, terminal, plan, and configuration types after validation.
Schema combinators preserve the base/value type where it can be inferred.

No explicit `any` type remains in package-owned TypeScript. Error and service
requirements are preserved rather than erased by asserting an entire Effect or
service object. Test doubles implement the actual service contract; the bridge
HTTP test now provides its spawner to request handlers through its layer graph.

Runtime regressions uncovered by these changes have dedicated coverage:

- v1 boolean configuration requests require `type: "boolean"`.
- v1 terminal-auth capability is `true`; v2 uses `{}`.
- v1 command input hints need adaptation to the v2 text-input snapshot variant.
- Malformed known updates stay observable in raw history without creating
  invalid projected records.
- Circular/BigInt payloads fail through the typed error channel and release
  pending request capacity; an invalid handler result does not lose batch peers.
- Malformed response envelopes are never answered as requests.

JSON-RPC envelopes are validated with Effect schemas. JSON encoding/decoding
returns Effect or Result failures; the runtime has no throwing `parse` wrapper.

## Retained `unknown` boundaries

These categories cover the remaining handwritten source occurrences, including
their internal queues, callbacks, and schema fields. Repeated generated fields
are covered by the final row.

| Location | Why the value is unknown | Where it becomes concrete |
| --- | --- | --- |
| `AcpConnection` raw requests, raw handlers, pending responses, notification queue and route dispatch | Method names are runtime strings; the peer may send custom methods. A shared pending map holds results of different methods. | Typed `request`, `onRequest`, and `onNotification` use each method's parameter/result codecs. Standard session methods use these typed APIs. |
| `internal/jsonRpc` classifier input and result/error bodies | An envelope may be invalid; result and error-data shapes depend on the method. Outgoing raw payloads have not yet been serialized. | Envelope schemas validate structure; method codecs validate payloads. Classified request parameters retain their validated object/array/null shape. |
| `AcpClient.request`, `AcpAgent.Emit.raw` and agent raw dispatch/notification helpers | Explicit extension APIs and incoming protocol boundaries. | Selected-version schemas validate known requests and updates before handlers or writes. |
| `AcpLocalClient` incoming callbacks, provisional update buffers and record guards | A raw dispatcher routes methods by string; updates must survive until their session has been created. | Method schemas validate incoming notifications; interaction schemas and reducer variant schemas supply concrete types. |
| `AcpSessionState.Event.update`, raw dispatch records and discriminator inspection | The pure reducer accepts raw input and retains future/custom or undecodable updates for observation. | Component schemas validate known variants before typed projection. |
| `AcpApp` raw updates, tool raw input/output, and remote error data | ACP leaves these payloads open to tool and protocol extensions. | They remain opaque data; applications may decode their own extension schema. |
| `AcpGateway.Open.options`, `AcpHost.Options.open`, `AcpRemoteClient.profileOptions` | Launch profile configuration belongs to the application. | The application's profile resolver validates its own configuration. |
| Gateway `Extension.params`, `Operation.result`, host command execution and remote command runner | The command ledger also carries arbitrary extension results; there is no single closed result type. | Known remote operations decode `ConnectionDescriptor`, `SessionDescriptor`, or `SubmissionResult`; extension results remain raw. Submission progress itself is typed. |
| `AcpGatewayClient.Storage` and admission loader | Storage keys hold heterogeneous application-persisted values that may be stale or corrupt. | Admission and retained connection/session schemas validate reads before reuse. |
| `internal/json` and host canonicalization | Serialization is a boundary accepting caller values, including invalid values such as cycles. | Encoding failures are explicit; parsed JSON and canonical traversal use `Schema.Json`. |
| Error `data`, unsupported-version `received`, store/WebSocket causes and failure-normalization helpers | Error data is open, peer version values may be invalid, and defects may contain any thrown value. | Guards identify known errors; unknown causes remain diagnostic ancestry or become redacted boundary errors. |
| `AcpSchema` generic method defaults | An unspecified generic does not identify a payload type. | Method declarations supply concrete parameter and result types. |
| `internal/capabilities.present` | A cross-version property check must distinguish absent/null values, v1 booleans, and v2 capability objects. | The helper only returns a boolean; normalized capabilities and negotiated responses retain their concrete types. |
| `internal/wire` additional properties, generator correlation and refinement predicates | Upstream JSON Schema permits extra fields; refinement schemas may validate different shapes. | Declared object fields and base/value codec types remain inferred. The generator correlation is the assertion described below. |
| Generated `protocol/v1` and `protocol/v2` declarations | Upstream unconstrained `_meta`, error data, tool payloads, extensible envelopes and JSON Schema `true` deliberately have no fixed application type. | Generated schemas preserve upstream constraints and unknown-field round trips; oracle tests compare them against pinned upstream JSON Schema. |

Scripts keep unknown input at JSON Schema/compiler and VM boundaries. Tests keep
unknown for adversarial schema fixtures, raw extension payloads and generic
failure inspection. Parsed peer frames use `Schema.Json`; request ids,
capabilities, deferred handler outcomes, and lifecycle events use their actual
types.

## Remaining assertions

There is one non-const type assertion in `src/`:
[`internal/wire.ts`](src/internal/wire.ts), `def<T>`. It correlates the
generator's separately emitted TypeScript type with its identity codec.
JSON Schema intersections and exclusion refinements are checked at runtime but
cannot all be inferred by TypeScript. This remains a generator trust boundary,
documented at its definition and checked by upstream-schema oracle and
round-trip tests; it is not a claim of compile-time proof.

Two `as never` assertions remain in tests, explicitly marked as invalid-input
probes: a missing agent create handler and a text prompt missing its required
text. They deliberately exercise runtime validation for untyped callers.
Other assertions are `as const` literals/tuples; namespace imports are not type
assertions. No unchecked service-object, method-function, or Effect assertion
remains.

## Verification

`bun run check` runs generated-schema drift checking, TypeScript, lint with
warnings denied, the complete test suite, and browser export smoke checks.
Transport service tests, schema/oracle tests, and raw peer tests cover the
changed boundaries independently of application examples.
