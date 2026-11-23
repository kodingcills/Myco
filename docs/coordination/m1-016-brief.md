# M1-016 — independent reproduction brief (fresh operator)

**Row:** M1-016 (TIF-20). **Scorecard:** row 8. **VM queue:** slot 2, starts when
the C1 arm's pid exits.
**Estimated:** 3–4 h. **Hardware:** the Mac that holds the VM bundle, GUI session.

## The point

Row 8 asks whether **another coding agent can reproduce the evaluation from the
repo**. A description of the procedure is not evidence. This is a behavioural test:
someone who has never touched Myco follows the repo, and every place the repo is
insufficient is a finding.

**The operator must not be the C1 arm's owner, and must not have built this.**
That is the whole value of the exercise.

## Setup

```bash
git clone git@github.com:kodingcills/Myco.git && cd Myco
git checkout <SHA-under-test>          # record the full SHA
pnpm install --frozen-lockfile         # a stale node_modules gives a FALSE red (CONTRIBUTING-agents.md §8)
```

Obtain from the environment owner, and **nothing else**:

- the VM bundle `~/VMs/myco-win11/` (or a repaired `build-all.sh` + its ISO inputs)
- `ssh_config` and `id_ed25519`
- permission to run in the Mac's GUI session

If anything else is needed, that is a row-8 failure — write it down.

## Procedure

Follow [`docs/eval-runbook.md`](../eval-runbook.md) in order. Do not skip §1.

| # | Step | Runbook | Pass condition |
|---|---|---|---|
| 1 | Preconditions | §1 | Every stated precondition obtained from the repo alone |
| 2 | Sanity: guest reachable and healthy | §2 | `ssh up after Ns` |
| 3 | Reset | §3 | Snapshot restored |
| 4 | Deploy the agent | §4 | Agent answers on the desktop |
| 5 | Prove the agent is on the desktop | §5 | |
| 6 | Generator proof | §6 | **20/20** |
| 7 | The trials | §7.3 | **30 rows** matching the retained `params.json` |
| 8 | Evidence | §8 | `schema-validate` passes on every result and trace |
| 9 | Scorecard | — | `docs/m1-scorecard.md` regenerates **byte for byte** |

## Logging — the actual deliverable

Keep a plain file, one line per event. This is what row 8 is judged on:

```
[HH:MM] step | action | expected vs observed | divergence | question I had to ask
```

Rules:

- **Any question you had to ask someone is a failure for row 8.** It means the repo
  did not contain the answer. Record it verbatim, then continue.
- **Wall-clock every step.** If a step takes much longer than the runbook implies,
  that is a finding.
- **A step that "worked once I did X" is a failure**, not a success. Record `X`.
- Do not fix anything mid-run. Collect findings; fixes happen after.

## Known-unsatisfiable today — do not treat as operator error

State these in the result rather than working around them:

1. `build-all.sh` has never been run end to end (row 8, `docs/env/vm-toolchain/README.md`).
2. The Windows ISO, offline payload and `clean-base` snapshots live outside the repo.
3. The manifest-hash discrepancy: the arm ledger records
   `manifestSha256: bb256a9b…` while the repo's `sweep-v3.json` hashes to
   `4d651ba1…`. A step that checks the recorded hash against the checked-in file
   **will fail**. That is a real finding — record it, do not edit the hash.

## Output

`docs/research/experiments/m1-016-reproduction.md`, containing: the SHA under test,
the wall-clock table, every divergence, every question asked, and a verdict of
**reproduced / partially reproduced / not reproduced** with the exact step that
failed first.

## Launch command (slot 2)

Run from the repo root, detached, per `CONTRIBUTING-agents.md` §C:

```bash
mkdir -p /tmp/m1-016
setsid nohup bash -c '
  echo "$$" > /tmp/m1-016/pid
  exec pnpm exec tsx scripts/m1-016-run.ts --log /tmp/m1-016/operator.log
' > /tmp/m1-016/run.log 2>&1 &
```

The runner does not exist yet; the operator works from this brief and the runbook.
The pid file exists so the outer loop can see the slot is occupied.
