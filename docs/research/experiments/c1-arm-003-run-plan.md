# arm-003 run plan (TIF-90)

**Ready to execute the moment a window opens.** The design is in
`c1-arm-003-design.md`; this is the operating procedure and the go/no-go gates.

## What it is, in one line

The same 30 M1-013 tasks as arm-002, with the canonical task text that includes
the save requirement, to produce the first screenshot-baseline number that is
comparable to Myco's arm.

## Frozen inputs — do not substitute

| Input | Value | Source |
|---|---|---|
| Task manifest | `src/baseline/sweep-v3.json`, 30 rows | M1-013's list, byte-identical |
| Task text | `taskText()` output, `"…, and save the file."` | `src/tasks/task-text.ts:54` |
| Snapshot | `cua-c1-base` | same cold-reset path as arm-002 |
| Planner | `claude-sonnet-5-5`, fail-closed | `src/baseline/planner.ts` |
| Step budget | 30 | `c1-trial.ts` `STEP_BUDGET` |
| Trials | 30 | same denominator as arm-002 |

Verify the manifest hash before starting and after finishing; a changed list makes
the comparison invalid. The hash is recorded in `accounting.json` as
`manifestSha256`.

**Local models are not used.** Not Ollama, not any local vision model — the
planner is the paid Sonnet path and nothing else.

## Spend

**Cap: $9.00 on total committed spend, counted the way `charged()` counts it** —
every ledger entry, scored, omitted and reserved alike (`sweep.ts:83`). Not scored
alone: an omitted trial made real API calls before it died.

| Source | Booked |
|---|---|
| spike (`c1-spike/0.json`) | $0.076808 |
| arm-002 (`accounting.json`) | $1.555362 |
| **committed before arm-003** | **$1.632170** |

**Remaining headroom: $7.367830.** At arm-002's measured rate (~$0.054/trial) the
30 trials project to **~$1.61**, so the cap does not bind. If committed spend
passes **$4.00** mid-run, report before continuing — that would mean the per-trial
rate has roughly doubled and the cause is worth knowing.

Report **cash and booked separately**, never "$1.18" unqualified.

## Go / no-go gates

| Gate | Check | Fail action |
|---|---|---|
| Code landed | `taskText` contains "and save the file" (TIF-85) | do not start |
| Watchdog | `scripts/watch-c1-arm.sh` present and firing | run the manual protocol |
| Guest clean | no `soffice.bin`, `:8765` free | reap, then start |
| Lock free | `flock -n` on `/tmp/myco-win11.vm.lock` | wait; never retry in a loop |
| Spend | committed ≤ $9.00 | stop |
| **Manifest binding** | the recorded `manifestSha256` equals the hash of the manifest **at the commit the run executes** | **do not publish the comparison** |

### The manifest gate, and the method that makes it pass

The gate is real; the obvious way to check it is wrong. `sweep.ts:23` computes the
hash over the **parsed** object, not the file bytes:

```ts
const manifestSha256 = createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
```

So `shasum -a 256 src/baseline/sweep-v3.json` will **never** match — it gives
`4d651ba1…` while the ledger correctly records `bb256a9b…`, and that difference
says nothing about the run. An earlier note reported it as a discrepancy and has
been retracted (`docs/research/experiments/c1-parity.md`, "Retracted: the manifest
hash does bind").

Correct check, run before starting and again before publishing:

```
node --import tsx -e 'import h from "./src/baseline/sweep-v3.json" with { type: "json" };
import { createHash } from "node:crypto";
console.log(createHash("sha256").update(JSON.stringify(h)).digest("hex"))'
```

That must print the `manifestSha256` the arm records. **If it does not, the
comparison to Myco's arm is unverifiable and the number must not be published** —
the binding is the one property that makes this arm worth running.

There is **no AC or load gate** (standing rule). Power is recorded per row; load is
recorded for context. A `memory_pressure` warn/critical is the only host condition
that holds the run.

## Watching

`scripts/watch-c1-arm.sh` reports committed spend and exits 10 when
`progress.log` has not grown for the silent threshold. If it is unavailable, the
manual protocol in `c1-arm-003-design.md` applies — **two checks five minutes
apart with an identical byte count is the trigger.** One quiet sample is not
evidence: a cold reset legitimately takes ~180 s with no output.

**A stale log is a death, not a pause.**

## Reporting

At completion, generated from the ledger rather than hand-assembled:

```
node --import tsx scripts/c1-arm-report.ts <arm-dir>      # denominator, spend, reasons
node --import tsx scripts/audit-false-success.ts <arm-dir>/accounting.json
```

State the denominator as **scored / omitted / reserved**, never as "30". Break the
refutations out by reason (`modified`, `step-budget`, `persisted-mismatch`, …)
rather than reducing them to one number.

**On false successes:** report what the audit supports. If arm-003 produces
verified rows, the audit runs and a bound is possible. If it produces none, the
honest line is **"no verified rows, so false successes are unmeasurable"** — not
"zero false successes".

## Pre-mortem — what each failure means

| Signature | Read |
|---|---|
| `driver-unreachable` in trials 0–2 | stop; the 45 s budget did not fix the root cause |
| click band still ~99% at y≈146 | the task text was not the whole story; **TIF-97 is the real defect** — re-scope, do not re-run |
| `modified` persists despite "and save the file" | the planner is not reading the task line; inspect prompt assembly before spending more |
| committed > $4.00 mid-run | report the per-trial rate before continuing |

## What this arm cannot settle

It produces a **baseline** number under a corrected task text. It does not by
itself establish M1 criterion 7 unless Myco's own arm ran the identical tasks
under the identical initial state — that comparison is the Coordinator's to make,
and the manifest hash is what makes it checkable.
