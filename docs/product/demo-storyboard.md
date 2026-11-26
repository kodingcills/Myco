# Demo storyboard: 90 seconds

Myco is solving desktop use for agents broadly. The gate (verified completion) is the first
proven piece, and this demo shows only that piece: an agent says it is done, and the gate
checks what the application actually saved.

Everything here runs with **no VM and no model**, on the mock transport. Every frame and every
verdict in it is `mock` and is **not evidence**. The M1 numbers are in
[docs/m1-scorecard.md](../m1-scorecard.md); this demo does not add to them and the narration
quotes none.

## Status of the pieces

| Piece | Where | On `main` today? |
|---|---|---|
| Gate CLI: `myco-gate demo`, `myco-gate check` | `src/gate/` | yes |
| Live watch view: `myco-watch` (frames + verdict timeline) | [#513](https://github.com/kodingcills/Myco/pull/513) | no (lands with #513) |
| Structured corrections: `myco-gate check --corrections` | [#514](https://github.com/kodingcills/Myco/pull/514) | no (lands with #514) |
| One-command setup: `bin/myco init` | [#512](https://github.com/kodingcills/Myco/pull/512) | no (lands with #512) |

Until #513 lands, record the terminal half of every beat and skip the watch view. Until #514
lands, beat 5 has no correction line; the refuted verdict and its reason codes still show.

## Operator commands

Run from the Myco checkout after `pnpm install --frozen-lockfile`.

**Runnable on `main` today** (`test/docs/demo-storyboard.test.ts` runs exactly these lines and
checks each exit code):

```sh
OUT=$(mktemp -d)
pnpm myco-gate demo --transport mock --out "$OUT/todo"  # exit 0
pnpm myco-gate check --evidence-root "$OUT/todo/evidence" --task df-s02 --run demo-df-s02 --claim "All 4 items added and saved."  # exit 1
pnpm myco-gate demo --transport mock --family calc-multi-step --out "$OUT/calc"  # exit 0
pnpm myco-gate check --evidence-root "$OUT/calc/evidence" --tasks "$OUT/calc/tasks.json" --no-builtin --task calc-ms-demo --run ms-slip-then-repair-no-retry --claim "All 3 edits saved."  # exit 1
pnpm myco-gate check --evidence-root "$OUT/calc/evidence" --tasks "$OUT/calc/tasks.json" --no-builtin --task calc-ms-demo --run ms-slip-then-repair-retry --claim "All 3 edits saved."  # exit 0
```

A refuted verdict exits 1 on purpose: `check` exits 0 verified, 1 refuted, 2 uncertain.

**Pending** (do not run on `main`; each line names the PR it needs):

```sh
pnpm myco-watch --demo todo-items  # lands with #513; serves http://127.0.0.1:8740/ (use --port 0 if 8740 is taken)
pnpm myco-watch --demo calc-multi-step  # lands with #513; same page, the multi-step Calc runs
pnpm myco-gate check --evidence-root "$OUT/calc/evidence" --tasks "$OUT/calc/tasks.json" --no-builtin --task calc-ms-demo --run ms-slip-then-repair-no-retry --claim "All 3 edits saved." --corrections calc-multi-step  # lands with #514; exit 1, plus one correction line
pnpm exec vitest run test/gate/corrections-loop.test.ts  # lands with #514; the agent acts on the correction and is verified on the retry
bin/myco init --dry-run  # lands with #512; run from your own project directory
```

Both watch demos keep serving after `demo finished: PASS` until you press Ctrl-C.

## Shot list

Screen layout for beats 2–7: watch view on the left (desktop frame on top, verdict timeline
below), terminal on the right.

| # | Time | Seconds | On screen | Narration | Operator runs |
|---|---|---|---|---|---|
| 1 | 0:00–0:08 | 8 | Title card: "Desktop use for agents. First piece: verified completion." | "Agents can already click around desktop apps. The hard part is knowing whether the work was really saved." | Nothing. Start `pnpm myco-watch --demo todo-items` off camera (lands with #513). |
| 2 | 0:08–0:20 | 12 | Watch view, run `demo-df-s02`. Frame: the todo app reads `saved 4 item(s)`. Timeline: one entry, `refuted`, not accepted, `ORACLE_FAIL`. | "This agent added four items and says they're all saved. The app agrees. The gate reads the saved file instead, and says refuted." | Select `demo-df-s02` in the run menu. |
| 3 | 0:20–0:30 | 10 | Terminal: `refuted (not accepted): ORACLE_FAIL, CLAIM_RECORDED` and `not persisted: bug: login page crashes on save, BUG: token expires too early`. | "Two items never reached the file. That is a false completion, and the harness does not mark the task done." | The first two `main` lines above. |
| 4 | 0:30–0:42 | 12 | Watch view (`pnpm myco-watch --demo calc-multi-step`, lands with #513), run `ms-slip-then-repair-retry`. Frames: the agent edits three cells in a spreadsheet and saves. Timeline: attempt 1, `refuted`, `TARGET_MISMATCH`, checkpoint 1 verified, 2–3 refuted. | "Now a three-step spreadsheet edit. Step one landed. Step two did not." | Restart the watch view on the Calc demo; select `ms-slip-then-repair-retry`. Run the third and fourth `main` lines. |
| 5 | 0:42–0:54 | 12 | Terminal: `step 2: TARGET_MISMATCH: cell C4 (record EMP-0003, column qty) does not hold the requested value`, then `correction: {"kind":"target_value_mismatch","step":2,"cell":"C4","record":"EMP-0003","column":"qty","expected":"4242","observed":"4224"}`. | "With corrections switched on, the gate says which cell and what was asked: C4 should be 4242, and the saved file has 4224. It only repeats what the task already said and what the agent's own file holds." | The `--corrections` line (lands with #514). |
| 6 | 0:54–1:08 | 14 | Watch view: attempt 2 starts from checkpoint 1. Frames: C4 now reads `4242`, the agent saves. Timeline entry for the new call is marked `retry`. | "The agent gets one retry, from the last verified step. It fixes the cell in the app and saves again. Nothing changes the file except the app." | Nothing; the frames play. |
| 7 | 1:08–1:18 | 10 | Timeline: attempt 2, `verified`, accepted, `ORACLE_PASS`, all three checkpoints verified. Terminal: `verified (accepted): ORACLE_PASS, CLAIM_RECORDED`. | "The gate re-checks the saved file. All three steps hold, and nothing else in the sheet changed. Verified." | The fifth `main` line. |
| 8 | 1:18–1:30 | 12 | Terminal: `bin/myco init --dry-run` output (lands with #512), then the line "mock run, not evidence; M1 results: docs/m1-scorecard.md". | "The agent only ever sends a task id, a run id and its claim. The verdict comes from the saved file. To point your own agent at the gate, run `myco init`." | `bin/myco init --dry-run` from a project directory (lands with #512). |

Total: 8 + 12 + 10 + 12 + 12 + 14 + 10 + 12 = 90 seconds.

## What the demo must not imply

- **Beat 6 is a scripted repair.** In the watch demo the second attempt is the mock agent's
  scripted fix of C4; it does not read the correction. The loop where an agent receives the
  correction, fixes the cell and is verified on the retry is
  `test/gate/corrections-loop.test.ts` (lands with #514), which drives a spawned
  `myco-gate mcp --corrections calc-multi-step`. Do not narrate beat 6 as "the agent read the
  correction" until the watch demo runs that loop.
- **Corrections are off by default** and are not allowed in R1 evidence (#514 enforces this).
  Say "with corrections switched on" in beat 5.
- **No numbers.** The demo prints mock counts (for example `retry 2/3, no retry 1/3`). They
  are not results; keep them off screen or label them mock.
- **No product beyond the gate.** Say "first piece"; do not show or promise pricing, hosting
  or accounts.
