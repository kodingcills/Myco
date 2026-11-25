# Verdict integrity (TIF-266, M2-03, scorecard row R4)

Status: foundation landed with TIF-266. The gate API that calls it is TIF-265 (M2-02).
The "agent tampers with oracle inputs" fault class that runs it under live faults is
TIF-272 (M2-10).

R4 asks that the agent cannot write the oracle, the fixtures, the ground truth or the run
artifacts, and that a CI test proves the agent's tool surface has no path to them. This
document maps today's surface, names every path the map finds, and describes the
mechanism that closes them.

## 1. Today's surface (map, as of main `81cd59d1`)

### 1.1 Tools the agent side can call

| Surface | Tool / op | Reaches | Notes |
|---|---|---|---|
| `myco-rt-mcp` (Linux runtime, `runtime/crates/myco-rt-mcp`) | `create`, `observe`, `act`, `read_file`, `write_file`, `launch_process`, `kill_process`, `relaunch_process`, `reset`, `destroy` | Guest only | `act:launch` and `launch_process` run **any** guest command, so the whole guest is agent-controlled. `read_file`/`write_file` are confined beneath an opt-in guest `read_root` (`write_file` also needs `allow_write`); the confinement limits the tool, not the agent, because a launched shell can reach any guest path. The `observe` screenshot path is a guest path. |
| `myco-rt-mcp` | `evidence` | **Host write**, fixed path | Writes the session's `trace.jsonl` and `result.json` into the host `<workspace>/runs/<session>/`. The agent picks neither the path nor the content, but it chooses when the files are written and can trigger rewrites. `destroy` deletes that host run dir. |
| `myco-agent` (Windows guest, `agent/myco_agent/ops.py`) | `ping`, `session_info`, `launch`, `uia_tree`, `uia_invoke`, `screenshot`, `read_file`, `write_file`, `kill`, `uno_eval` | Guest only | Only the host harness speaks this protocol today. `read_file`/`write_file` are **unconfined** inside the guest; `launch` runs any argv. `uno_eval` is read-only. |
| Claude Code built-ins | `Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Glob`, `Grep`, `LS`, `Task`/`Agent`, `BashOutput`, `KillShell` | **Whole host** (as the operator's user) | Not granted to M2 agents. A Claude Code session runs as the same Unix user as the harness, so file permissions alone cannot stop a granted host tool. Denying these tools is the boundary. |
| Claude Code built-ins | `WebFetch`, `WebSearch` | Host network | Not a write path; denied to keep the surface closed. |
| TIF-265 gate (not yet landed) | e.g. `verdict` | Gate | Must take a run id only. If it accepted an intent or an expected value from the agent, the agent could pick the expected value. |

### 1.2 Oracle inputs, expected values, fixtures and artifacts

"Agent can" means: can the agent reach it through the M2 surface (the guest tools plus
the gate). "Worst case" means: with a host tool granted by mistake.

| Item | Where it lives today | Agent can read | Agent can write | Worst case |
|---|---|---|---|---|
| Expected value (calc-record-edit) | Recomputed host-side from the intent params (`groundTruth(params)`, `src/tasks/intent.ts`) | Only if the gate accepts params from the agent | Same: **through the gate's arguments** | read/write |
| Intent params / ground truth file | In memory in the harness (`src/integration/trial.ts`); no sealed copy | No | No (but see the row above) | read/write |
| Pristine fixture | Generated host-side from the seed (`generateFixture`) | No | No | read/write |
| Guest fixture copy | Windows: `C:\myco\runs\<nonce>\fixture.xlsx`; Linux: under the guest `read_root` | **Yes** | **Yes** | read/write |
| Persisted output (the saved document) | Guest file | **Yes** | **Yes** (that is the task) | read/write |
| Oracle read path for the persisted file | M1 Windows verifier check (c): guest `soffice --convert-to csv` into a guest nonce dir, read back with `read_file` | **Yes** | **Yes**: a guest-side converter and its outdir are agent-controllable | read/write |
| Live UNO readback (checks (a), (b)) | Guest LibreOffice process | Yes | Yes: it is the app the agent drives | read/write |
| Oracle source | `src/tasks/*.ts`, `src/verify/*.ts` in the repo | No | No | read/write |
| `result.json`, `trace.jsonl` (M1 harness) | Host `runs/<runId>/` (`writeRunEvidence`) | No | No | read/write |
| `result.json`, `trace.jsonl` (Linux runtime session) | Host `<workspace>/runs/<session>/` | Paths returned by `evidence` | **Triggers rewrite/delete** (`evidence`, `destroy`) | read/write |
| Ledger | Host `runs/<evalId>/ledger.jsonl` (`writeLedgerRows`), plain appends, no integrity check | No | No | read/write, undetectable |
| Screenshots | Guest path from `observe` | Yes | Yes | read/write |

### 1.3 Paths the map finds

- **P1. The guest is agent-controlled in full.** The guest fixture copy, the persisted
  output, the screenshot files and any guest-side oracle read (the M1 soffice convert)
  are all agent-writable.
- **P2. The expected value can come in through the gate's arguments** if the gate accepts
  an intent from the caller.
- **P3. `evidence`/`destroy` give the agent a timing-controlled host write and delete**
  over the Linux runtime's `result.json` and `trace.jsonl`.
- **P4. Nothing records what was sealed.** Fixtures, ground truth and oracle source have
  no recorded hash, so a change before verdict time would go unseen.
- **P5. The ledger has no integrity check**, so an edited row would look like any other row.
- **P6. A granted host built-in reaches everything** (same Unix user).

## 2. Design

Code: `src/integrity/` (`vault.ts`, `gate.ts`, `ledger.ts`, `surface.ts`). Tests:
`test/integrity/` (CI, no VM).

**Principle: tampering cannot produce `verified`.** The oracle never reads a path the
agent could reach. It reads bytes the harness copied into a host-side vault, read once and
hash-checked, so a swap after the check cannot reach it. Any check that fails returns
`uncertain` with an `integrity:<code>` reason. That is "could not look" in ADR-0002's
sense, so it is never counted as success and never as a refutation.

### 2.1 Lifecycle

```
harness                                     agent
───────                                     ─────
vault = new VerdictVault({root, key, agentRoots})   (refuses a root inside any agent root)
receipt = vault.seal(runId, {groundTruth, fixtures, oracle})   ← before the agent starts
stage guest copies ─────────────────────────▶ acts in the guest
                                             (may call the gate: run id only)
agent stops ◀────────────────────────────────
vault.markAgentStopped(runId)
vault.capture(runId, {"persisted/out.csv": hostCopy, "result.json": …, "trace.jsonl": …})
gatedVerdict(vault, runId, receipt, oracle)  → oracle(VerdictInputs) or uncertain
```

### 2.2 Vault layout (`<vaultRoot>/<runId>/`, dir 0700, files 0400)

| File | Content | Protection |
|---|---|---|
| `seal.json` | run id, sha256 of every sealed file, oracle id and the sha256 of each oracle source file | HMAC-SHA256 with the vault key; its sha256 is the **receipt** the harness keeps in memory |
| `sealed/ground-truth.json` | canonical JSON of what the expected value is computed from (for Calc: the intent params) | hash in `seal.json` |
| `sealed/fixtures/<name>` | pristine fixtures | hash in `seal.json` |
| `stop.json` | stop time, digest of `seal.json` | HMAC; bound to this seal |
| `capture.json` | sha256 of every captured file, digest of `stop.json` | HMAC; bound to this stop marker |
| `captured/persisted/<name>` | persisted output, copied host-side after stop: **the only captured files the oracle sees** | hash in `capture.json` |
| `captured/<other>` | `result.json`, `trace.jsonl`, screenshots: audit only, never oracle input | hash in `capture.json` |

### 2.3 Checks (each returns `uncertain` with an `integrity:<code>` reason)

| Code | Catches |
|---|---|
| `vault-reachable` | vault inside an agent-reachable root, or the reverse (also refused at construction) |
| `vault-permissions` | vault root or run dir not a 0700 directory |
| `seal-missing` / `seal-malformed` / `seal-signature` | no seal, a seal naming another run (replay), a seal whose MAC fails (ground truth edited together with its manifest hash) |
| `receipt-mismatch` | seal differs from the digest kept since seal time (covers a leaked key) |
| `sealed-file-{missing,not-regular,writable,hash}` | edited, replaced, symlinked, hard-linked or re-permissioned fixture or ground truth |
| `oracle-source-{missing,hash}` | oracle source edited after seal |
| `agent-not-stopped` / `stop-signature` | no stop marker; forged marker; a marker replayed from another run |
| `capture-missing` / `capture-signature` | nothing captured; forged capture manifest; capture replayed from another run or written before stop |
| `captured-file-{missing,not-regular,writable,hash}` | captured output, result or trace edited or swapped |
| `unexpected-file` | any file in the run dir that no manifest lists (a dropped `result.json`) |

`capture()` also refuses (throws `VaultError("not-stopped")`) until a valid stop marker exists.

### 2.4 How each path is closed

| Path | Closed by |
|---|---|
| P1 guest | The oracle reads `captured/persisted/*` only: bytes the harness copied to the host **after** `markAgentStopped`. Guest fixture copies and screenshots are never oracle input. A guest-side read (the M1 soffice convert) must move to a host-side parse of the captured bytes: see follow-up F1. |
| P2 gate arguments | The oracle's intent comes from `sealed/ground-truth.json` (`VerdictInputs.groundTruth`). The TIF-265 gate must take a run id only. |
| P3 `evidence`/`destroy` | `evidence` is classified `host-write-fixed` and the surface audit rejects it; the harness exports evidence itself after stop. The oracle never reads `result.json`/`trace.jsonl`, and their captured copies are hash-checked. |
| P4 nothing sealed | `seal()` hashes and MACs ground truth, fixtures and oracle sources before the agent starts. |
| P5 ledger | `appendChainedRow` / `checkChainedLedger`: each row carries an HMAC over the previous row's MAC and the row. Edits, deletions and reorders break the chain; a kept head also catches a truncated tail. |
| P6 host built-ins | `auditToolSurface(granted)` fails closed: an unknown tool, a host-fs or host-shell tool, a network tool, or `evidence` is a violation. A failing audit reports host root `/`, and a `VerdictVault` given that root refuses to construct. Catalog drift tests read the tool names from `myco-rt-mcp`'s `tool_defs()` and `ops.py`, so a new tool must be classified before CI passes. |

### 2.5 Key handling

The vault key is 32 random bytes (`newVaultKey()`), held in the harness process. If
the gate runs in another process, the key must reach it through a file outside every agent
root, at point of use (the `src/baseline/secret-file.ts` pattern), never through env or
argv. The receipt is the second line of defence: a gate in the harness process passes it,
and a re-signed seal (leaked key) then fails `receipt-mismatch`.

## 3. Seam for TIF-265 (gate API)

```ts
import { gatedVerdict, VerdictVault, type SealedOracle } from "src/integrity";

// yes/no:
vault.checkIntegrity(runId, receipt)  // → { ok: true, sealDigest } | { ok: false, violations[] }

// the gate's verdict for a run:
gatedVerdict(vault, runId, receipt, oracle)  // → Verdict (M1 three-valued type)
// oracle: (inputs: VerdictInputs) => Verdict, where inputs = { groundTruth, fixtures, persisted }
```

Contract for the gate:
1. The agent-facing tool takes a **run id only**.
2. The oracle reads only `VerdictInputs`, never a path.
3. `uncertain` with an `integrity:` reason is never accepted as done.
4. The gate's MCP tool is registered for the surface audit with reach `gate` via
   `auditToolSurface(granted, { extraServers: { "<server>": { <tool>: { reach: "gate", note } } } })`.

The verdict type is the M1 `Verdict` (`src/core/verify.ts`). The surface test stubs a
`myco-gate` / `verdict` registration locally until TIF-265 lands its real names.

## 4. What this does not do

- It does not stop the agent writing the **guest**. It makes guest state reach the oracle
  only as a host copy taken after stop. Whether the output is right is the oracle's job.
- It does not make permissions a boundary against a process running as the same user. The
  boundary is the tool surface (no host tools). Modes and hashes catch what gets past it.
- It does not run any fault live. TIF-272 (M2-10) adds the tamper fault class on top of
  `test/integrity/isolation.test.ts`.
