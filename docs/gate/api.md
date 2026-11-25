# Myco gate API (`myco.gate/v1`)

The gate decides whether a task is done by reading the app's **persisted state**, not by
believing the agent. A coding agent (Claude Code) calls it when it thinks it is finished.
"Done" counts only when the gate returns `verified`.

Source: `src/gate/`. CLI: `pnpm myco-gate`. Issue: TIF-265 (M2-02).

## The contract in one paragraph

You send a **task id** and a **run id**. The gate looks up what "done" means for that task
in the operator's registry, reads that run's persisted state from the operator's evidence
location, runs the task family's oracle, and returns `verified`, `refuted` or `uncertain`
with reason codes and a digest of what it read. You cannot send expected values, file
contents, paths or a verdict. A request that tries is rejected with `ORACLE_INPUT_REJECTED`
and the oracle does not run.

## Who controls what

| Input | Who sets it | How |
|---|---|---|
| `taskId`, `runId`, `claim` | the agent | the gate request (the MCP tool's arguments) |
| Task registry: what "done" means for each task, and the oracle family | the operator | built-in `myco-run` tasks, plus `--tasks <file>` |
| Evidence location: where persisted state is read | the operator | `--evidence-root <dir>`; the gate reads `<dir>/<runId>/<stateFile>` |
| Decision log | the operator | `--audit <file>`, one JSON line per decision |

The registry and the evidence location never come from a request. TIF-266 (verdict
integrity) builds on this split: it makes the evidence location unwritable from the agent's
tools. The gate is already a separate process from the actuator: the gate is `myco-gate`,
and the actuator is `myco-rt-mcp` (server name `myco-rt`).

## Request

```jsonc
{
  "apiVersion": "myco.gate/v1", // optional; if present it must be exactly this
  "taskId": "df-s01",           // required; [A-Za-z0-9._-], 1-128 chars, starts alnum, no ".."
  "runId": "run-42",            // required; same alphabet
  "claim": "All 4 items saved." // optional; recorded, max 4000 chars, never read by the oracle
}
```

Any other field is rejected:

- names that would be oracle inputs (`items`, `expected`, `spec`, `params`, `store`,
  `state`, `cells`, `path`, `stateFile`, `evidenceRoot`, `oracle`, `verdict`, `accepted`,
  and similar; the full list is `ORACLE_INPUT_FIELDS` in `src/gate/api.ts`) give
  `ORACLE_INPUT_REJECTED`;
- any other unknown field gives `UNKNOWN_FIELD`.

## Result

```jsonc
{
  "apiVersion": "myco.gate/v1",
  "verdict": "refuted",                 // "verified" | "refuted" | "uncertain"
  "accepted": false,                    // true exactly when verdict is "verified"
  "reasonCodes": ["ORACLE_FAIL", "CLAIM_RECORDED"],
  "reasons": ["not persisted: bug: login page crashes on save, BUG: token expires too early"],
  "evidenceRefs": [
    { "kind": "persisted-state", "runId": "run-42", "path": ".myco-todo.json",
      "sha256": "…", "bytes": 98 }
  ],
  "request": { "taskId": "df-s02", "runId": "run-42", "claim": "All 4 items saved." },
  "oracle": { "family": "todo-items", "version": "1", "specSha256": "…" }, // only when an oracle decided
  "checkedAt": "2026-11-25T20:00:00.000Z"
}
```

A harness should gate on `accepted` and nothing else. `reasons` is for people and may
change wording. `reasonCodes` is the stable, machine-readable explanation.

## Verdicts and reason codes

| Code | Verdict | Meaning |
|---|---|---|
| `ORACLE_PASS` | verified | The oracle ran on persisted state and passed. **The only route to `verified`.** |
| `ORACLE_FAIL` | refuted | The oracle ran and found the effect provably absent. Fix and call again. |
| `ORACLE_UNCERTAIN` | uncertain | The oracle ran but could not decide (for example the target cell is absent). |
| `ORACLE_ERROR` | uncertain | The oracle threw. |
| `ORACLE_INVALID_OUTPUT` | uncertain | The oracle returned something that is not a well-formed verdict. |
| `STATE_MISSING` | uncertain | No persisted state at `<root>/<runId>/<stateFile>`. |
| `STATE_UNREADABLE` | uncertain | The file exists but cannot be read, is not a regular file, is over 16 MiB, or resolves outside the evidence root (a symlink out). |
| `STATE_CORRUPT` | uncertain | The file does not parse as the family's format. |
| `INVALID_REQUEST` | uncertain | The request is not an object, lacks `taskId`/`runId`, or a field has the wrong form. |
| `UNSUPPORTED_API_VERSION` | uncertain | `apiVersion` is present and is not `myco.gate/v1`. |
| `UNKNOWN_FIELD` | uncertain | The request has a field the API does not define. |
| `ORACLE_INPUT_REJECTED` | uncertain | The request tried to supply an oracle input. Counted apart from `UNKNOWN_FIELD` so a tamper attempt is visible (M2-10). |
| `UNKNOWN_TASK` | uncertain | `taskId` is not in the registry. |
| `AUDIT_FAILED` | uncertain | The decision log could not be written. The gate fails closed. |
| `CLAIM_RECORDED` | (any) | Informational: the claim was recorded. It never changes the verdict. |

`uncertain` means "could not look". It is never folded into `verified` or `refuted`
(ADR-0002).

## Task families

| Family | Oracle | State file | Spec |
|---|---|---|---|
| `todo-items` | `persistedStoreOracle` (the oracle `myco-run` uses) | the app's JSON store | `{ "items": ["…", …] }` |
| `calc-record-edit` | `calcRecordEditVerifier` (M1's Calc oracle) | the saved sheet as CSV | `{ "fixtureSeed", "rowKey", "column", "newValue" }` |

The built-in tasks are `myco-run`'s `df-s01` (clean, verifies) and `df-s02` (the app
silently drops `BUG` items while its status line says "saved 4"; refutes). Their state
file is `.myco-todo.json`. Register more with a tasks file:

```json
{
  "tasks": [
    {
      "id": "calc-emp-0002-name",
      "family": "calc-record-edit",
      "stateFile": "sheet.csv",
      "spec": { "fixtureSeed": "gate-seed", "rowKey": "EMP-0002", "column": "name", "newValue": "Gate Ops" }
    }
  ]
}
```

A bad entry (unknown family, a `stateFile` with `..` or an absolute path, a spec the family
rejects) stops the gate at startup with exit 3. It never becomes a verdict.

## In-process API

```ts
import { buildRegistry, createGate, fileEvidenceReader } from "./src/gate/gate.ts";
import { builtinTasks } from "./src/gate/tasks.ts";

const gate = createGate({
  tasks: buildRegistry(builtinTasks()),        // operator-only
  reader: fileEvidenceReader("/srv/myco/evidence"), // operator-only
  onDecision: (result) => ledger.append(result),    // optional; a throw fails closed
});
const result = await gate.check({ taskId: "df-s01", runId: "run-42" }); // never throws
if (result.accepted) { /* done */ }
```

`EvidenceReader` is an interface: `read(runId, stateFile)` returns the bytes, or
`missing` / `unreadable`. M2-12's live reader implements it over the runtime's `read_file`.

## CLI

```
pnpm myco-gate check --evidence-root <dir> --task <id> --run <id> [--claim <text>] [--json]
pnpm myco-gate mcp   --evidence-root <dir> [--tasks <file>] [--no-builtin] [--audit <file>]
pnpm myco-gate demo  --transport mock [--out <dir>] [--json]
```

`check` exits 0 on verified, 1 on refuted, 2 on uncertain and 3 on a usage error (the same
0/1/2 as `bin/myco`). `mcp` serves stdio until stdin closes.

## MCP server for Claude Code

`myco-gate mcp` is a stdio MCP server (JSON-RPC 2.0, one message per line; protocol
versions 2025-06-18, 2025-03-26 and 2024-11-05). It has exactly one tool:

- **`myco_gate_check`**: input is the request above (`additionalProperties: false`);
  output is the result as `structuredContent` and as JSON text. It is annotated read-only.
  `isError` is true only when the request was rejected (bad form, unknown field, oracle
  input). A `refuted` verdict is a normal answer, not an error.

The actuator tools (`create`, `observe`, `act`, `read_file`, …) belong to `myco-rt-mcp`.
The gate shares no tool with it and has no tool that acts, reads a path or takes one.

### Wiring it into Claude Code

Use absolute paths: Claude Code starts the server from its own working directory. Replace
`/path/to/Myco` and the evidence directory with yours.

```sh
claude mcp add --scope project myco-gate -- \
  /path/to/Myco/node_modules/.bin/tsx /path/to/Myco/scripts/myco-gate.ts mcp \
  --evidence-root /path/to/evidence --audit /path/to/gate-decisions.jsonl
```

Or put the same thing in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "myco-gate": {
      "type": "stdio",
      "command": "/path/to/Myco/node_modules/.bin/tsx",
      "args": [
        "/path/to/Myco/scripts/myco-gate.ts", "mcp",
        "--evidence-root", "/path/to/evidence",
        "--audit", "/path/to/gate-decisions.jsonl"
      ]
    }
  }
}
```

Tell the agent its `taskId` and `runId` in the task prompt. The server's `instructions`
already tell it that only `verified` counts as done.

### End-to-end on the mock transport (no VM, no model)

```sh
pnpm myco-gate demo --transport mock
```

This plays every role with fakes, the same way the real flow will work:

1. A scripted fake agent drives the mock desktop (the double `myco-run --transport mock`
   uses) through `df-s01` and `df-s02`, and claims "All 4 items added and saved."
2. The harness writes the mock app's saved store to `<out>/evidence/<runId>/.myco-todo.json`.
   The agent never writes there.
3. The gate runs as a separate process, started the way Claude Code starts it. The fake
   agent calls `myco_gate_check` over stdio.
4. The harness accepts "done" only on `accepted: true`.

Expected output: `df-s01` gives verified and is accepted. `df-s02` gives refuted and is
rejected, although the UI said "saved 4 item(s)" both times. A tamper attempt (the agent
sends the two items it wants checked) gives `ORACLE_INPUT_REJECTED` and is rejected. The
command exits 0 only when all three behave as expected. Every row is labelled `mock`; none
of it is evidence.

## Versioning

`myco.gate/v1` is the version of the request and result shapes and the reason-code
meanings. Adding a reason code or an optional result field is additive and stays `v1`.
Removing or renaming anything, or changing what a code means, needs `v2`. The oracle's
own decision rule is versioned per family (`oracle.version`), and `oracle.specSha256` pins
the exact task spec used, so a ledger row (R1) records which rule and spec decided it.

## What this does not do yet

- **Enforcing the gate inside Claude Code.** The gate answers, and a harness that reads
  `accepted` enforces it. A Claude Code hook that blocks "done" without a logged `verified`
  belongs with the evaluation runs (M2-12).
- **Isolation.** The agent cannot pass oracle inputs through the gate. Stopping the agent
  from writing the evidence location by other routes (its actuator tools, a shell) is
  TIF-266.
- **Live reads.** The evidence reader here is file-based. A reader over the runtime's
  `read_file` on the real guest comes with M2-12.
