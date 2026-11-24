# TIF-172: why #338 merged 5/5 green with a test asserting the old contract

**Answered 2026-11-24 by the M1 coordinator.** The question was whether the contract suite
is outside CI, or whether a merge race hid the failure. **Neither.** The test was inside CI
by the time #338 merged — it simply did not exist when #338 was authored.

## The timeline, from commit dates

```
15:01  be7e7dfe  #338 authored - its branch predates the wrapper, so the
                 `check` job ran NO python gate. 5/5 green was correct for that branch.
19:14  7317fd75  #342 adds test/df005-contract-gates.test.ts, which runs
                 df005-postcreate-gate.py and df005-runner-offline.py under vitest.
                 The gates enter CI here - visible as `check (macos-latest)`
                 going ~1m15s -> ~2m.
20:08  1308539f  (#347) updates test 16 to assert the `deferred:` contract that
                 #338 introduced.
20:30            #338 merges.
```

**So the ordering is: the gap closed, then the contract was fixed, then #338 merged.**
`73b8ef8d` is in main and **main has never been red from this test.**

## Verified on main now

```
python3 test/df005-runner-offline.py   ->  rc=0, PASSED: 0 failure(s), 124s
```

## Why the wrapper mattered, and what it actually closed

Before #342, `pnpm test` was vitest plus `schema-validate`, and
`test/df005-runner.selftest.sh` was referenced from **no workflow and no script**. Every
Python gate in `test/` was executed by nothing. **#338 was authored inside that window**,
which is precisely why a commit could change a gate's contract and still show green: the
test that pinned the contract never ran.

**The wrapper is the gap-closer, not the test edit.** #347's test-16 update was the repair;
#342 was what made the repair enforceable. A future contract change is now caught, because
the assertion runs on every `check`.

## The residual risk this does NOT close

`test/df005-runner-offline.py` **mutates `scripts/df005-runner.py` on disk** during its
mutation cases (12/13). `mutated_runner()` restores on exception paths and asserts exact
restoration, but it is **not signal-safe** - a SIGTERM mid-case leaves a mutated runner,
which then poisons later cases. Recorded in #347's body; not fixed.

## Not the cause of the red seen tonight

The only red main run tonight was `816f450b` (TIF-170), on
`viewer verdict budget (macos-latest)` - the wall-clock benchmark documented in
`viewer-budget-flake/`. Unrelated to this test.
