# Tasks

## 1. Contracts and ownership

- [x] 1.1 Consume the implemented foundation and add AcpClient/AcpSession contracts plus application schemas for identities, provenance, capabilities, snapshots, submissions, and interactions; verify contract type tests and schema round trips.
- [x] 1.2 Implement AcpLocalClient and scoped session routing, including bounded provisional updates during new/resume; verify updates arriving before lifecycle responses are retained and invalid excess routing fails explicitly.
- [x] 1.3 Implement capability-aware session/authentication/configuration operations and negotiated MCP configuration validation; verify unsupported operations are rejected before wire dispatch.

## 2. Versioned state and submissions

- [x] 2.1 Implement v2 message, tool-call, and plan reducers with omit/null/value and chunk rules; verify replacement, clearing, unknown variants, and raw-update observation fixtures.
- [x] 2.2 Implement display terminal byte/snapshot, commands, configuration, and usage projections; verify terminal replacement and independently encoded chunks plus each remaining update family.
- [x] 2.3 Implement submission records, acknowledgement correlation, and exclusive admission; verify update-before-response reconciliation, v2 completion separation, and concurrent-submit busy rejection.
- [x] 2.4 Implement v1 lifecycle/state adaptation, optional modes, replay rebuilding, and local identity provenance; verify missing message IDs never cause text-based submission matching or false v2 guarantees.

## 3. Interactions and observations

- [x] 3.1 Implement one-shot permission/elicitation registries and deadlines; verify duplicate resolution, incoming cancellation, expiry, and continued unrelated protocol traffic.
- [x] 3.2 Add opt-in v1 filesystem/terminal handler composition and terminal-authentication callback support where advertised; verify capabilities match installed handlers and absent handlers are not advertised.
- [x] 3.3 Implement explicit session cancellation and independent observation/wait release; verify final updates are applied before confirmation and unconfirmed deadlines remain distinguishable.
- [x] 3.4 Add atomic snapshot/subscription boundaries, bounded subscriber delivery, and transcript/terminal retention limits; verify handoff races, slow-subscriber resync, and visible truncation under deterministic scheduling.

## 4. Client integration

- [x] 4.1 Create a reusable local/remote session contract suite and run its local cases over both protocol versions; verify all acp-session-client scenarios are covered.
- [x] 4.2 Add a direct CLI example and API guidance for ownership, v1 limitations, draft opt-in, and interactions; verify the example against a subprocess fixture and run type, test, and browser-import checks.
