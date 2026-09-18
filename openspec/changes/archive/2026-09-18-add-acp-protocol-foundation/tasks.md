# Tasks

## 1. Library and schema inputs

- [x] 1.1 Establish browser-safe library entry points, typecheck/test scripts, and matching development-only platform adapters; verify installation, typecheck, and a browser import smoke check.
- [x] 1.2 Add the pinned v1/v2 schema provenance manifest and generator input loader; verify hashes against ARCHITECTURE.md and reject an altered input fixture.
- [x] 1.3 Implement primitive, object, array, reference, optional/null, and constraint schema emission; verify emitted modules typecheck and match the source-dialect validator on representative valid/invalid fixtures.
- [x] 1.4 Implement union/intersection/negated-fallback emission and reviewed overrides; verify malformed known variants fail while permitted unknown variants and metadata round-trip.
- [x] 1.5 Generate baseline v1/v2 modules and method maps with a drift-check command; verify two generations are identical and unsupported validation keywords fail explicitly.

## 2. Transport contract and ACP peer

- [x] 2.1 Add scoped framed-text transport/connector contracts, typed errors, and paired in-memory transports; verify ordered duplex exchange and cleanup of blocked readers/writers.
- [x] 2.2 Implement JSON parsing, envelope validation, notification dispatch, and method codecs; verify parse/invalid-request/method-not-found errors and absence of notification responses.
- [x] 2.3 Add directional pending-request registries and independently scoped incoming handlers; verify reverse requests with colliding IDs complete without deadlock.
- [x] 2.4 Implement batch dispatch and response assembly; verify empty, mixed, all-notification, invalid-entry, and out-of-order response fixtures.
- [x] 2.5 Add explicit version policy and initialization selection; verify opt-in v2, valid v1 downgrade, strict version-specific payload validation, and unsupported-version cleanup against independently parsed transcripts.
- [x] 2.6 Add request cancellation, deadlines, capacity bounds, and terminal failure propagation; verify pending waits settle on closure and local interruption does not report false remote cancellation.

## 3. Spawned stdio

- [x] 3.1 Implement incremental UTF-8/newline framing with serialized writes and finite frame limits; verify fragmented code points, multiple frames per read, partial lines, and oversized frames.
- [x] 3.2 Connect framing to injected ChildProcessSpawner handles with independent bounded stderr draining; verify a subprocess exchanges ACP while producing heavy stderr.
- [x] 3.3 Wire process exit and owner-scope finalization to peer closure; verify crash, explicit close, blocked writes, and pending-call cleanup leave no owned child process.

## 4. Foundation integration

- [x] 4.1 Add independent v1/v2 protocol drivers and reusable conformance fixtures covering every foundation requirement; verify both in-memory and stdio compositions without private framework messages on the wire.
- [x] 4.2 Document version opt-in, custom transport construction, runtime injection, schema updates, and exposed limits; verify examples typecheck and run generation, type, test, and browser-import checks successfully.
