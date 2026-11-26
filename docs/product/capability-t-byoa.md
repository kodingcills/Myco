# Capability T (bring your own app): proposed pre-registered measurement bar

**Status: proposal, pre-measurement.** Nothing here has been run and no result is claimed. It
follows the shared rules of `docs/product/capability-spec.md` (#525: §1 rules, §1.5
statistics, §3 pre-registration, §4 constraints). If #525 has not landed when this is read,
the bar below is the proposal for the spec to adopt as its section T. Once ratified and
frozen, it changes only by a new version.

**Why (Tiffany, 2026-11-26 10:29 / 10:41 ET):** Myco must add capabilities to desktop agents,
and the baseline exists to measure how much. T's claim is: *with a third-party plugin's state
reader, an agent completes more tasks in an app Myco does not support natively, and the
plugin's oracle never says `verified` when the independent grader does not pass.*

## What is measured

- **T-reader (agent capability).** Does giving the agent a registered plugin's state reader
  raise the verified rate in a third-party app?
- **T-oracle (oracle safety).** Over every captured document of the T-reader runs, does the
  registered plugin's oracle ever say `verified` when the independent grader says `fail` or
  `ungradable`?

## Arms (same harness, Claude Ultra, §1.3)

| | Arm | Tool surface |
|---|---|---|
| Primary | `C1+T` vs `C1` | screenshot-only C1 vocabulary, plus one capability tool `plugin_state({path})` that runs the registered reader over the saved document at `path` under the guest read root and returns its typed state (served by `myco-cap`, lands with track I) |
| Secondary, reported, not part of the bar | `hcu+shell+T` vs `hcu+shell` | the shell can already `cat` a CSV, so little lift is expected; reported to show it |

Same tasks, fixtures, instruction text, model id, step budget (30), output ceiling, retry
budget (0) in both arms; `plugin_state` spends a step like any tool. Neither arm calls the gate
(the gate stays CSV-for-Calc only and does not take plugins). Seeded ABBA assignment per task.

## Task set (new): `byoa-ledger-v1`

- 72 tasks over the example ledger app (`examples/plugins/csv-ledger/`): the ledger file opened
  in a plain text editor in the guest (Notepad on the Windows path; a text editor on the Linux
  path first, where possible).
- **60 satisfiable** edits ("set column C of the row with id K to V") across 12 fixtures of 5 to
  40 rows, columns spread evenly; **12 invalid-target** tasks (the id does not exist) as a
  false-done guardrail.
- Built deterministically by a build script with a SHA-256 manifest and a byte-identical test,
  like fc-v1, and frozen before measurement.
- **Grader:** a new entry `ledger-csv/1` in `src/benchmark/grade/`, written independently of
  the plugin (no shared code; `test/benchmark/independence.test.ts` already enforces both
  directions for `src/plugins/` and `examples/plugins/`). It reads the captured bytes against
  the pinned pristine fixture and the intent, including a whole-document collateral check the
  plugin oracle does not make.

## Pre-registered bar

**T-reader (fixed sequence, §1.5, alpha 0.05 each):**

1. Exact one-sided McNemar on verified (grader `pass` with a done claim) over the 60
   satisfiable tasks, `C1+T` better than `C1`, p ≤ 0.05 with at least 5 discordant tasks.
2. Only if 1 is shown: steps per verified task, paired bootstrap (10,000 resamples,
   pre-registered seed), one-sided 95% upper bound of `C1+T`/`C1` below 1.0.

**T-oracle (zero-tolerance, both arms pooled, all 144 trials):**

3. Zero trials where the plugin oracle says `verified` and the grader says `fail` or
   `ungradable`. One such trial fails T-oracle. The Wilson 95% upper bound of the false-verified
   rate is reported with its denominator.

**Guardrails (any breach: "not shown"):**

- False DONEs on the 12 invalid-target tasks no higher in `C1+T` than in `C1`.
- Every `plugin_state` output passes the per-row scan: no host path, no digest, no fixture value
  outside the document the agent itself opened.
- The pack records the plugin's registration (`manifestSha256`, `treeSha256`) and its R5
  self-test report, and the registration is the one frozen in the pre-registration.
- Plugin results stay `evidenceClass: "plugin-experiment"`; T packs are experiment rows, never R1
  evidence (spec §3.4), with their own arm values added by a reviewed schema change.

## Sample size

60 satisfiable tasks, k = 1. With a C1 verified rate around 0.5 and a plausible `C1+T` rate of
0.75, the expected discordant pairs are about 0.3 and 0.05 of 60, so d ≈ 21 with about 18
favouring `C1+T`; the critical count at d = 20 is 15 (spec §1.5 table), so the test has
reasonable power at that effect. A smaller effect (0.5 to 0.6) will likely be "underpowered at
n", and is reported as such with the discordant count, never rounded to a win.

## Not in scope here

- No measurement run is part of the T PR. Runs wait for the integrity fixes (#518, the xlsx
  replacement for #503, the #494 tests-only follow-up) and the lead's GO, on Claude Ultra only.
- The guest-side `plugin_state` tool and the `byoa-ledger-v1` build are queued separately
  (see the T PR's TO FILE list); VM parts are local, single-owner, under the VM lock.
