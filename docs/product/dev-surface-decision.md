# Developer surface: resolving GUI spec open question 3

Status: decision by MVP Discovery, 2026-11-21. Resolves `docs/design/gui-spec.md` §12 Q3.
Owner: discovery-owner. Runtime owner reviews before anything in `runtime/` changes.

## Question

Does the TypeScript SDK (`@myco/sdk`) wrap the Rust runtime over **MCP/stdio**, or
through a **native binding** (napi-rs or similar)?

## Decision

**MCP/stdio.** `@myco/sdk` spawns `myco-rt-mcp` and speaks JSON-RPC over stdio. No
native binding in v0 or v1.

## Why

1. **It is the thin-layer rule made literal (§10).** The SDK, the CLI and an agent's
   MCP client then all go through the same process and the same tool contract. There
   is no second path that can drift. A native binding would be a fourth door with its
   own marshalling.
2. **It already exists.** `runtime/crates/myco-rt-mcp` serves six ops (`create`,
   `observe`, `act`, `evidence`, `reset`, `destroy`) with a test pinning that list.
3. **Direction A's claim needs it.** MVD-001 acceptance 4 says an ordinary coding
   agent drives Myco with no custom harness. If the SDK uses the same MCP surface the
   agent uses, the SDK run is evidence for that claim; a binding run is not.
4. **Latency is irrelevant at this scale.** A stdio round trip is milliseconds. The
   operations it fronts take seconds (an act step) to ~21 s (the default reset;
   m2-05). Process spawn happens once per session.
5. **No build matrix.** A native module means per-OS, per-arch, per-Node-ABI builds
   and a packaging story. The spec already rejects native shells for v0/v1 for the
   same reason.

## What it costs, and what would reverse it

- Long operations need progress, not a blocked call. Use MCP progress notifications
  plus bounded blocking calls. Do **not** depend on MCP's experimental tasks
  mechanism (m2-02: moved to an extension and lost `tasks/result` in the 2026-07-28
  revision).
- Binary payloads (screenshots) travel base64 over stdio. Keep them as `artifacts/`
  files referenced by path and `sha256` (§6.4 `screenshot` event), never inline.
- Reopen this decision if Now-mode streaming (v1, §12 Q2) cannot be served by tailing
  the trace file or a local socket, or if a measured SDK overhead exceeds 5% of a
  median act step.

## Receipt rules carried from m2-02

- The verdict lives behind a separate operation from the actuator. `act` returns no
  field that can carry a verdict.
- Every receipt carries `application_commit: not_verified` unless the persisted file
  was read by the verifier.
- Gaps against §10: the runtime MCP lacks `verify`, `fork` and `replay`. `verify` is
  needed for Direction A; `fork` and `replay` wait for Direction C.
