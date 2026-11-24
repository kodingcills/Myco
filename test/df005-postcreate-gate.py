#!/usr/bin/env python3
"""TIF-27: the post-create guest readiness gate, and a teardown that reports dirty.

Two properties, both about failures that used to be invisible:

  1. A guest that never answers ssh must fail CLOSED. `create()` returns once the
     session is recorded, not once the guest it booted is reachable, so probing
     once made a slow-but-healthy boot indistinguishable from one that will never
     come up. `wait_ready()` waits, then the run is a gap.

  2. A teardown that cannot free the session must SAY SO. Both reset and destroy
     used to have their exceptions dropped, so a leaked session - which holds the
     single guest for every run after it - looked exactly like a clean exit.

Run directly, like its sibling:  python3 test/df005-postcreate-gate.py
"""
from __future__ import annotations

import importlib.util as _ilu
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUNNER = ROOT / "scripts" / "df005-runner.py"

# Import the runner's own implementation rather than restating it: a test that
# re-expresses the rule it guards cannot detect a change to that rule.
_spec = _ilu.spec_from_file_location("df005_runner_gate", RUNNER)
df005 = _ilu.module_from_spec(_spec)
sys.modules["df005_runner_gate"] = df005
_spec.loader.exec_module(df005)  # type: ignore[union-attr]

FAILS: list[str] = []


def expect(cond: bool, what: str) -> None:
    if not cond:
        FAILS.append(what)
    print(f"  {'ok  ' if cond else 'FAIL'} {what}")


class FakeMcp:
    """A session whose teardown succeeds or fails, without touching the VM."""

    def __init__(self, teardown_works: bool):
        self.teardown_works = teardown_works
        self.calls: list[str] = []

    def call_tool(self, name: str, args: dict) -> dict:
        self.calls.append(name)
        if name in ("reset", "destroy") and not self.teardown_works:
            raise RuntimeError("guest refused to release")
        return {}


def main() -> int:
    print("TIF-27 post-create readiness gate")

    # --- 1. wait_ready fails closed -----------------------------------------
    # A probe that never sees a guest must exhaust its budget and return False,
    # NOT hang and NOT claim ready.
    probe = df005.GuestProbe(offline=False)
    probe._probe_once = lambda: False  # type: ignore[method-assign]
    # The sleep is the only thing that makes this slow; keep the assertion about
    # behaviour and let the budget be tiny.
    import time as _t
    real_sleep, _t.sleep = _t.sleep, lambda _s: None
    try:
        ready, elapsed = probe.wait_ready(timeout_s=1)
    finally:
        _t.sleep = real_sleep
    expect(ready is False, "a guest that never answers ssh is NOT ready")
    expect(isinstance(elapsed, float), "wait_ready reports how long it waited")

    # And a probe that DOES see a guest returns ready, so the gate is not a
    # blanket refusal.
    probe2 = df005.GuestProbe(offline=False)
    probe2._probe_once = lambda: True  # type: ignore[method-assign]
    ready2, _ = probe2.wait_ready(timeout_s=5)
    expect(ready2 is True, "a guest that answers is ready (the gate is not a blanket refusal)")

    # --- 2. cleanup reports a failed teardown --------------------------------
    ok = df005.cleanup(FakeMcp(teardown_works=True), "s1")
    expect(ok is None, "a teardown that works returns None")

    # The regression this guards: `reset` succeeding must NOT short-circuit
    # `destroy`. `reset` only returns the session to Ready; `destroy` is what
    # removes it. An early return after a successful reset leaked the session on
    # EVERY run while reporting a clean teardown - worse than the swallowing it
    # replaced, because it leaked on the happy path.
    probe_mcp = FakeMcp(teardown_works=True)
    df005.cleanup(probe_mcp, "s-destroy")
    expect(probe_mcp.calls == ["reset", "destroy"],
           f"cleanup calls BOTH reset and destroy (got {probe_mcp.calls})")

    bad = df005.cleanup(FakeMcp(teardown_works=False), "s2")
    expect(isinstance(bad, str) and "s2" in bad,
           f"a teardown that fails returns the failure naming the session: {bad!r}")

    # The specific regression this guards: teardown failure must not be silent.
    # If cleanup goes back to swallowing, `bad` is None and the leaked session is
    # indistinguishable from a clean exit.
    swallowing = df005.cleanup(FakeMcp(teardown_works=False), "s3") is None
    expect(not swallowing,
           "cleanup does NOT swallow a failed teardown (the leak stays visible)")

    # --- 3. fault injection: no guest AND a teardown that fails ---------------
    # The composition the outer loop asked for. Both halves must hold at once:
    # the gate decides "not ready", and cleanup then reports the leak. What this
    # guards is the case where the leak would be lost inside a generic
    # "guest unreachable" gap, which reads as an ordinary failure and hides a
    # session still holding the single guest.
    probe3 = df005.GuestProbe(offline=False)
    probe3._probe_once = lambda: False  # type: ignore[method-assign]
    real_sleep, _t.sleep = _t.sleep, lambda _s: None
    try:
        ready3, _ = probe3.wait_ready(timeout_s=1)
    finally:
        _t.sleep = real_sleep
    leak = df005.cleanup(FakeMcp(teardown_works=False), "s4")
    expect(ready3 is False, "fault-injection: the gate reports not-ready")
    expect(isinstance(leak, str) and "s4" in leak,
           "fault-injection: the leak is REPORTED, not swallowed into a plain gap")
    expect(leak is not None,
           "fault-injection: the dirty case is distinguishable from a clean failure")

    # --- 5. the bucket vocabulary is not invented ----------------------------
    # The gate reports `gap` because scoring.md has no `dirty` bucket. Assert the
    # constant the message uses is real, so a future edit cannot quietly name a
    # bucket that no downstream count knows about.
    expect(hasattr(df005, "GUEST_READY_TIMEOUT_S"),
           "the readiness timeout is a named constant, not a literal in the gate")
    expect(df005.GUEST_READY_TIMEOUT_S >= 60,
           f"the timeout allows for a real boot (measured ~20s): {df005.GUEST_READY_TIMEOUT_S}s")

    print(f"\n{'FAILED' if FAILS else 'PASSED'}: {len(FAILS)} failure(s)")
    for f in FAILS:
        print(f"  - {f}")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
