# Reproduce on Linux

Two things you can do on any Linux machine, with no VM, no account, no API key and no model.
§1 is tested: every command in it runs verbatim in CI (see the end of §1). §2 is a recipe
that has not been run end to end against fc-v1; treat it as a procedure to validate.

Prerequisites, from [`docs/product/linux-path.md`](../../product/linux-path.md) §1: `git`,
Node 24 or later, pnpm 10. §2 also needs LibreOffice Calc and its Python-UNO bridge.

```sh
git clone https://github.com/kodingcills/Myco.git myco
cd myco
pnpm install --frozen-lockfile
```

## 1. Regrade a published result (Node only, no LibreOffice)

The commands below use clone-relative paths (`scripts/…`, `benchmark/…`), but they must
**not** run in the clone itself: the clone's `docs/` is Myco's own documentation, not a
release's saved documents. Run them in a **release directory outside the clone** that links
in the clone's code and holds the release's `arm.jsonl` and its `docs/` directory of saved
documents (named `<trialKey>.csv` or `<trialKey>.xlsx`). The release's own `grades.jsonl` is
what you compare against at the end.

Set `RELEASE_FILES` to the directory you unpacked the release into (the one holding
`arm.jsonl` and `docs/`), then run this from the clone root (`myco` above). It makes a new,
empty release directory under `$TMPDIR` (or `/tmp`) with `mktemp -d` and an explicit
template, which GNU and BSD `mktemp` (Linux and macOS) read the same way, links the clone's
code into it, copies the release in and moves you there. Each step runs only if the one before it succeeded. It checks the
release and the clone before it creates anything, so an unset `RELEASE_FILES`, a release
without `arm.jsonl` or `docs/`, or a directory that is not the clone root stops it with a
non-zero exit, nothing created, and you stay where you were:

```sh
test -f "${RELEASE_FILES:?set RELEASE_FILES to the unpacked release}/arm.jsonl" \
  && test -d "$RELEASE_FILES/docs" && test -f scripts/benchmark-grade.ts \
  && RELEASE=$(mktemp -d "${TMPDIR:-/tmp}/myco-release.XXXXXX") \
  && ln -s "$PWD/scripts" "$PWD/src" "$PWD/schemas" "$PWD/benchmark" \
    "$PWD/node_modules" "$PWD/package.json" "$RELEASE/" \
  && cp "$RELEASE_FILES/arm.jsonl" "$RELEASE/" && cp -R "$RELEASE_FILES/docs" "$RELEASE/docs" \
  && cd "$RELEASE" && echo "release directory: $PWD"
```

Then, in that directory:

```sh
# 1. The bundle is the published one. Exit 0; exit 1 on any changed, missing or extra file
npx tsx scripts/benchmark-verify-bundle.ts benchmark/false-completion/fc-v1

# 2. Rebuild the grade requests from the bundle and the published documents.
#    Exit 0; exit 1, writing nothing, if it refuses any row or path. --out must not exist yet.
#    Run in a clone (a .git here), it exits 1 before anything runs, writing nothing
test ! -e .git || { echo "not a release directory: see §1 setup" >&2; false; } \
  && npx tsx scripts/benchmark-make-requests.ts --bundle benchmark/false-completion/fc-v1 \
  --arm arm.jsonl --docs docs --out work

# 3. Grade again, independently of the release's grades.
#    Exit 0 (an unreadable document grades ungradable); exit 1 on an empty or invalid request
#    file, or when step 2 wrote none (in a clone: an ENOENT error naming work/requests.jsonl,
#    and the shell's redirect leaves an empty regraded.jsonl behind)
npx tsx scripts/benchmark-grade.ts work/requests.jsonl > regraded.jsonl
```

Then recompute the counts, in evidence mode, with the form for the arm the release is for.

**Myco's gated arm** on fc-v1: 100 trials, 10 of them unregistrable (the invalid-target tasks).

```sh
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades regraded.jsonl \
  --expect myco-gate=100 --expect-unregistrable myco-gate=10 --require-r1 --evidence
```

**A third-party arm** with no gate (the `hcu+shell` arm):

```sh
npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades regraded.jsonl \
  --expect hcu+shell=100 --evidence
```

The check prints its result as JSON. It exits:
- **0** when the ledgers are consistent and every row has evidence provenance, and, for the
  gated arm, R1 passes;
- **1** when the ledgers are inconsistent, empty or miscounted; when any row lacks evidence
  provenance (a simulated dry run is refused with "dry-run rows are never evidence"); when
  any row's gate had its agent-safe corrections on ("these rows are never evidence"); or,
  for the gated arm, when R1 does not pass;
- **2** on a usage error, including `--require-r1` on the gated arm without
  `--expect-unregistrable`.

`--evidence` admits a row only when its planner is one of the Claude model ids listed in
`EVIDENCE_PLANNERS` (`src/benchmark/check.ts`) and its gate's corrections were off (a row
records `gate.corrections`; a row without the field predates corrections and was off). For
the gated arm, `--require-r1` and `--evidence` each bind the rows to the published task set: exactly fc-v1's 100 tasks (or a
whole number of runs of them), each with its own fixture and instruction hashes, and the 10
invalid-target tasks unregistrable. Without either flag the check still counts, but its
result says `taskSetBinding.applied: false` and R1 does not pass.

**Tested.** `test/benchmark/r1-dryrun.test.ts` extracts every command in this section's code
blocks and runs each one verbatim, with no path rewriting. It runs the setup block from the
clone root, with `RELEASE_FILES` naming an unpacked SIMULATED fc-v1 run (a scripted agent, no
model), and runs the rest in the release directory the setup made:
- the setup makes one new release directory under `$TMPDIR`; CI runs this on Linux and
  macOS;
- the setup exits non-zero, creating nothing, when `RELEASE_FILES` is unset, when it names
  a directory without `docs/`, and when run outside the clone root;
- steps 1-3 exit 0;
- step 2 run in a clone instead exits 1 with "not a release directory", whether the clone's
  `.git` is a directory or a worktree's `.git` file, and step 3 then exits 1, so a reader who
  skips the setup gets an error, never 100 ungradable grades;
- the gated check without `--expect-unregistrable` exits 2;
- both check commands exit 1 on it, with the provenance refusal above;
- with the planner relabelled to a Claude model id (inside the test only), the gated check
  exits 0 with R1 bound and passing, and the third-party check, given the same trials with
  no gate record, exits 0.

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

1. **Check prerequisites.** `pnpm myco-linux --check` must exit 0: it prints the `soffice`
   version and `ok` for `python-uno`, and exits 1 naming whichever is missing.
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
   arm row with its SHA-256 (`docs/benchmark/false-completion.md` §4 lists the fields). If the
   arm has no measured cost, write `cost.modelUsd: null`, never 0.
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
- **Timing and model cost.** Published costs are a **token-derived estimate** at frozen
  per-token rates, **not billed USD**, taken from the arm's own rows (the check labels them
  with `costPerVerifiedTask.basis`). An unmeasured cost is reported as null, never 0, and one
  null row makes the arm's estimate null.
