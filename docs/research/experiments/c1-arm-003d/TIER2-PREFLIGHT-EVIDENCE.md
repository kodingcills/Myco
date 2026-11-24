# DF-S01 preflight deferral (#338) — the Tier-2 evidence

**Verified 2026-11-24 at `73b8ef8d`**, the merged commit. The outer loop ruled this Tier 2
(it changes VM/gate logic) and required three proofs plus a negative control. The dispatched
verifier cloned and exited without a verdict, so these were established directly rather than
left unproven.

## 1. A real defect still exits rc 1

Server binary moved aside, clean host, free lock:

```
rc: 1
  FAIL mcp-server: missing or not executable: .../runtime/target/debug/myco-rt-mcp
preflight FAILED: 1 of 8 checks failed: mcp-server
```

## 2. A held lock still fails

A real `flock` held by another process on `MYCO_VM_LOCK_PATH`:

```
rc: 1
  FAIL vm-lock: held by testholder
preflight FAILED: 1 of 8 checks failed: vm-lock
```

## 3. No path where "deferred" becomes passed or skipped

**(a) `deferred` and `skipped` are disjoint by construction** (`df005-runner.py:1408-1409`):

```python
skipped  = [n for n, ok, d in results if ok is None and not d.startswith("deferred:")]
deferred = [n for n, ok, d in results if ok is None and d.startswith("deferred:")]
```

`skipped` is what makes preflight INCOMPLETE (exit 1). A deferred check cannot enter it, and
`measured = len(results) - len(deferred)` means **the summary cannot claim a count it did not
measure**.

**(b) Every deferred check IS enforced once the guest is up — and this is the part worth
stating precisely.** The five names (`guest-ssh`, `app-deployed`, `app-self-test`,
`introspection-file`, `introspection-shadow`) appear **only inside `preflight()`**. They are
**not re-run as named checks in the trial path.** The enforcement is *equivalent, not
identical*, and it is real:

| deferred check | where it is enforced per trial |
|---|---|
| `guest-ssh` | `execute_scenario:591` — `probe.wait_ready()`, then `gap("REQ-01")` on timeout |
| `app-deployed` | `execute_scenario:632` — `deploy_fixture()`, then `gap("REQ-04", "fixture not deployed")` |
| `app-self-test`, `introspection-file`, `introspection-shadow` | not separately re-checked; their subject matter is covered by the deploy/observe/launch gaps above |

**This is the honest reading and it is weaker than the commit message implies.**
`"deferred to the run"` is accurate for `guest-ssh` and `app-deployed`; for the three
introspection checks it means "no longer gated here", and nothing re-asserts them by name.
**The run is not left unverified — it cannot grade without a reachable guest and a deployed
fixture — but a claim that each deferred check is individually re-run would be false.**

**(c) A deferred check is never counted as passed.** `record(name, None, "deferred: ...")`
stores `None`, and only `True` counts as passed; `skipped`/`deferred` partition the `None`s.

## 4. Negative control — the fix is load-bearing

Reverting the deferral to the pre-#338 behaviour (`record("guest-ssh", False, ...)`):

```
rc: 1   (fixed version: 0)
  FAIL guest-ssh
preflight FAILED: 1 of 8 checks failed: guest-ssh
```

So the deferral is doing the work, and DF-S01 is reachable from a clean host *because* of it.

## 5. Is deferring correct?

**Yes, with the caveat in (b).** The deadlock was real: `preflight()` ran before `create()`
but hard-failed on a guest that `create()` boots, and booting first failed `vm-lock` because
`boot.sh` holds the flock for the guest's lifetime. Neither order worked, so the runner was
unreachable from an idle machine.

Deferring is the right resolution **because the run cannot silently succeed without the
deferred things being true** — but the code comment at `:1325-1330` already says this, and it
says it more precisely than a "re-run" claim would.
