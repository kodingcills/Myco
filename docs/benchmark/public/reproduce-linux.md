# Reproduce on Linux

Two things you can do on any Linux machine, with no VM, no account, no API key and no model.
**Draft.** These steps have not yet been run end to end against fc-v1 on Linux. Each command
below exists in the repo, and the ones in §1 run in CI on the fake app. Treat §2 as a recipe
to validate, not a tested procedure.

Prerequisites, from [`docs/product/linux-path.md`](../../product/linux-path.md) §1: `git`,
Node 24 or later, pnpm 10. §2 also needs LibreOffice Calc and its Python-UNO bridge.

```sh
git clone https://github.com/kodingcills/Myco.git myco
cd myco
pnpm install --frozen-lockfile
```

## 1. Regrade a published result (Node only, no LibreOffice)

Given a release's `arm.jsonl`, its `docs/` directory of saved documents and its `grades.jsonl`:

```sh
# 1. The bundle is the published one
npx tsx scripts/benchmark-verify-bundle.ts benchmark/false-completion/fc-v1

# 2. Rebuild the grade requests from the bundle and the published documents
npx tsx scripts/benchmark-make-requests.ts --bundle benchmark/false-completion/fc-v1 \
  --arm arm.jsonl --docs docs --out work

# 3. Grade again, independently of the release's grades
npx tsx scripts/benchmark-grade.ts work/requests.jsonl > regraded.jsonl

# 4. Recompute the counts; compare with the release's check output.
#    Myco's gated arm on fc-v1: 100 trials, 10 of them unregistrable (the invalid-target tasks)
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades regraded.jsonl \
  --expect myco-gate=100 --expect-unregistrable myco-gate=10 --require-r1
#    A third-party arm with no gate
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades regraded.jsonl --expect hcu+shell=100
```

For the gated arm, `--require-r1` binds the rows to the published task set: exactly fc-v1's 100
tasks (or a whole number of runs of them), each with its own fixture and instruction hashes,
and the 10 invalid-target tasks unregistrable. Without `--require-r1` (or `--evidence`) the
check still counts, but its result says `taskSetBinding.applied: false` and R1 does not pass.
`test/benchmark/r1-dryrun.test.ts` runs the commands above, as written, on a simulated fc-v1
run.

Your `regraded.jsonl` should equal the release's `grades.jsonl` row for row (same grader
version, same hashes, same status). The check output should match the published numbers. Any
difference is a finding: report it with both files.

The grader and the check use Node built-ins only. They never start LibreOffice or read a
screen.

## 2. Produce your own documents with headless LibreOffice

This is the Linux path's actuator and oracle (`docs/product/linux-path.md`), pointed at fc-v1
tasks. It suits a **scripted control arm** (for example, an agent that always claims done) and
checks that your harness, capture and ledger are right before you spend anything on a model.
A model-driven agent needs your own computer-use harness; the capture and ledger steps are the
same.

1. **Check prerequisites.** `pnpm myco-linux --check` must print `ok` for both `soffice` and
   `python-uno`.
2. **Open the fixture as a workbook.** For a task, convert its fixture to `.xlsx` with a
   throwaway profile, as the Linux path does:

   ```sh
   soffice --headless -env:UserInstallation=file://$PWD/work/lo-profile \
     --convert-to xlsx --outdir work/xlsx \
     benchmark/false-completion/fc-v1/fixtures/<fixtureSha256>.csv
   ```

3. **Act.** The actuator types a value into one cell through Calc's input path and saves it
   (`--no-save` leaves the save out, which is a `delayed-save`-style false completion):

   ```sh
   python3 scripts/linux/calc_actuator.py --doc work/xlsx/<fixtureSha256>.xlsx \
     --cell <A1 ref> --value "<newValue>"
   ```

   The cell reference is your harness's choice: the honest one is the task intent's
   (`rowKey`, `column`) located in the fixture. Your agent must see only the task's
   `instruction`.
4. **Capture.** Copy the saved workbook, unchanged, to `docs/<trialKey>.xlsx`, and write the
   arm row with its SHA-256 (`docs/benchmark/false-completion.md` §4 lists the fields).
5. **Grade and check** as in §1.

**Fault classes on this path.** Headless Calc has no window to steal focus from and no
interactive session to kill mid-save. So only `none`, `invalid-target` and a dropped save
(`--no-save`) are realisable here. A result produced this way must say which fault classes it
applied. `kill-app` and `focus-change` need an interactive desktop (Myco's Windows VM, or a
Linux desktop session you drive yourself).

## 3. What this does not reproduce

- **Myco's gated arm.** The gate runs over MCP beside a live agent, with a sealed verdict
  vault (`src/gate/`). Reproducing a gated result means re-running the check on its published
  ledgers (§1). Re-running the gate itself needs Myco's harness.
- **Timing and model cost.** Published costs come from the arm's own measured rows. An
  unmeasured cost is reported as null, never 0.
