# arm-003d r2, trials 3 and 4: the truncation defect, not a scoring bucket

**2026-11-24. Correction from the Screenshot owner, verified against the ledger.**

## What the rows actually are

```
trial 3:  status scored   steps 0   modelCalls 1   out 256   verdict refuted / persisted-mismatch
trial 4:  status scored   steps 0   modelCalls 1   out 256   verdict refuted / persisted-mismatch
```

**Both are a single model call whose completion is EXACTLY 256** — `MAX_OUTPUT`. The reply was
clipped mid-JSON, the planner found no parseable decision, and `planner-no-action` was
**scored against the agent**.

**This is a harness fault in the model's clothing.** It is why these rows look like a
different shape from a planner that tried and failed — they *are* different. The agent never
got a complete reply to act on.

**`#340` (`b5eb801b`) makes the shape impossible:** a `max_tokens` reply now raises
`PlannerFailure` and the trial is **omitted** as `planner-failed`, never scored.

**So these are the bug, not an intended bucket.** An earlier framing of mine treated the
zero-step rows as a scoring question; they are not.

## The run did not die of a fault — it was killed

The `STOP-NOTE.md` in `c1-arm003d-r5` records the cause as "not established". **For r2 the
cause is known and is not a launcher fault:** the outer loop ordered a stop and the owner
killed watchdog, wrapper, then the surviving sweep children and tee.

**The logs share one mtime and the watchdog's last line precedes the ledger's by ~2 minutes
because the watchdog was killed FIRST** — which is exactly the clue that looked like a
timing anomaly. **There is no launcher fault to investigate.**

## Spend: which figure is current

Two conventions were in play and they count different runs:

| seed | value | counts |
|---|---|---|
| r5 (measured from its process env) | 3,567,488 | pre-today + r1 reservation |
| r6 (measured from its process env) | **4,480,732** | + r2 + r3 + r5 |

**`4,030,512` (= 3,567,488 + 463,024) omits r3 (228,970) and r5 (221,250)** — a 450,220
shortfall. **r6 is live and seeded `4,480,732`**, which is the figure on `main` and the one
that agrees with the running process.

**For the next relaunch, the seed must add r6's own booked total to that.** r6 had booked
845,910 at the time of writing and was still running:

```
next prior  = 4,480,732 + (r6 final booked)
next limit  = 9,000,000 - next prior
```

**Use `charged()` semantics** — a live `reserved` entry counts as committed, which is what
the code does and what the next seed must match.
