# Tasks

## 1. Handler construction

- [x] 1.1 Consume the foundation and define AcpAgent handler groups with Effect environment inference and injectable store/execution contracts; verify type tests preserve author dependencies and reject incompatible handler results.
- [x] 1.2 Validate versioned capability advertisements against required/optional handlers; verify incomplete v2 session and authentication groups fail before serving.
- [x] 1.3 Implement initialization and lifecycle handler dispatch for both enabled versions; verify independent strict protocol drivers select the advertised surface and unsupported versions close cleanly.

## 2. Session execution and interactions

- [x] 2.1 Implement separate prompt insertion and owned foreground execution phases; verify v2 never acknowledges queued-only input and execution continues after acknowledgement while v1 waits for turn completion.
- [x] 2.2 Add typed update emission and store-backed replay helpers; verify canonical IDs, full replacements, chunk resets, and version-specific update validation.
- [x] 2.3 Add permission/elicitation calls with capability checks and tracked waits; verify reverse requests do not block other traffic and absent optional capabilities reject calls before dispatch.
- [x] 2.4 Implement request/session cancellation and safe handler failure mapping; verify final updates precede cancellation completion and internal defects do not leak sensitive causes.

## 3. Serving and conformance

- [x] 3.1 Add the current-process Stdio adapter and AcpAgent serving layer over shared framing/peer logic; verify stdout contains only ACP frames and shutdown settles execution and interaction fibers.
- [x] 3.2 Add a deterministic example agent with injected in-memory storage and no model credentials; verify create/prompt/permission/cancel/resume flows using the local client and an independent driver.
- [x] 3.3 Document handler obligations, storage guarantees, v1/v2 differences, and runtime injection; verify examples typecheck and client-only imports do not load authoring/server modules.
