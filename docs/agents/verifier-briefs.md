# Verifier briefs

How to write a verification brief for a delegated verifier, and why each rule exists. Every
rule below comes from a specific failure on this repo, most of them on 2026-11-24.

## The brief template

> Round N verification of PR `<url>` at exact head `<sha>`. Branch `<branch>`, repo
> kodingcills/Myco.
>
> **Set up your own tree.** Create a detached git worktree of your own at the pin, under
> `/private/tmp/<name>`. Obtain dependencies by running **`pnpm install --frozen-lockfile`
> INSIDE that worktree**. Do NOT symlink `node_modules` from another worktree, do NOT
> symlink one worktree into itself, and do NOT verify inside a worktree that another
> session is using.
>
> **Do not touch the VM.** `<current lock holder>`. Do not touch the VM lock, qemu, a live
> run directory, or anything under `~/Projects/myco-runs/`.
>
> **Context.** What the change does, and what it is meant to fix.
>
> **Verify, with evidence.** Numbered requirements, each naming the observation that would
> settle it.
>
> **Mutation controls.** The exact mutations that must fail when reverted, listed.
>
> **Gates.** `<exact commands>`, plus: run `npx biome check .` **without a pipe** and
> report its exit code.
>
> **Report PASS/FAIL**, evidence per item, defects at exact file and line.

## Why each rule exists

### Build your own tree; never symlink `node_modules`

A brief that said "symlink `node_modules` from `<the baseline worktree>`" was executed **in**
that worktree, producing `node_modules -> itself`. Tooling then failed **silently**:
`npx vitest --version`, `npx biome --version` and `npx tsx --version` all printed **nothing**
and exited 0, so checks appeared to pass by producing no output. Repair was
`pnpm install --frozen-lockfile`.

Linking to another checkout instead is also wrong: a different worktree can be at a
different dependency state, and `tsc` then fails on that checkout's own code (`fflate` was
missing) for reasons that have nothing to do with the PR.

### Never verify in a worktree another session is using

A verifier reported HEAD being **moved out from under it mid-run** because the owner was
switching branches for other work. Its first reading was taken against the wrong commit and
looked like a total regression. The rule is not "ask first" but "use your own tree".

### Name the VM holder

r6 was resumed while another test held the VM, because the holder at the time did not take
the lock (TIF-191). Naming the current holder is not enough on its own - the brief should
also say what must not be touched: the lock file, qemu, a live run directory.

### Run the lint without a pipe

`npx biome check . | tail -2` returns **tail's** exit status, which is always 0. Used as a
gate it reported success while a file was unformatted, and CI failed on it. Whenever the
exit code *is* the result, run the command without a pipe.

### Ask for the mutation, not the mutation's absence

Every mutation control in these briefs exists because a test once passed with its fix
reverted. State the mutation concretely enough to apply, and require the exact failure.

### No claim without an execution

Three rounds of one PR found the same defect class: a comment asserting a guarantee nothing
measured - parsers "accept the same strings", a counter "replays every entry", a gate that
"runs the whole tree". Where a brief sees such a claim, it should ask which test executes
it, and treat "none" as a defect.
