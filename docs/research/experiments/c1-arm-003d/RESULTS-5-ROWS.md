# arm-003d: 5 scored rows, escalation proven on live traffic, run died at trial 5

**Run `c1-arm003d-r2`, 2026-11-23.** Stopped after 5 scored rows; the process died at
trial 5's VM reset. Written from the ledger read-only.

## The headline: the escalation works on live traffic

**Trial 2 is the first row in this workstream to attempt a save, and it proves
TIF-167's core claim end to end:**

```
actions:  type_text (80,146)  "D60\n"           <- a cell REFERENCE
          type_text (283,260) "2024-05-28\n"    <- the CORRECT VALUE
          press_key (312,261) "Ctrl+s"          <- the save
          press_key (283,260) "ctrl+a"

deliveries: {step 1, background, escalated false, delivered}
            {step 2, background, escalated false, delivered}
            {step 3, foreground, escalated TRUE,  delivered}   <- the save
            {step 4, foreground, escalated TRUE,  delivered}
```

**Steps 3 and 4 escalated from background to foreground and were delivered.** Before
#327 this row would have been a routing refusal; with it, the key lands. That is the
property arm-003c's aborted run could not reach and the probe could only suggest.

**The row is still `refuted / modified`** - the document was left unsaved despite
the save being *delivered*. That is the judge doing its job on a **delivery that
succeeded but did not take effect**, which is exactly the case `save-failed` is
reserved for and never produced. Worth noting precisely: **delivered ≠ saved**, and
this row is the first live evidence of that distinction mattering.

## The run stopped at trial 5's reset

```
progress.log and accounting.json last written: 15:45:27
processes:                                      none
flock:                                          FREE
UTM:                                            no guest
```

**No sweep, no wrapper, no reset process, no guest.** The last log line is
`[5] Resetting VM to cua-c1-base...`, so it died during that reset rather than
finishing it. **Cause not established** - nothing in the logs names a fault, and the
three logs share one mtime, so they stopped together rather than one erroring.

**The watchdog went silent earlier than the run.** `watch.log`'s last line is at
**15:43:16** showing `rows=2`, while the ledger's last write is **15:45:27** with 5
scored. So the watchdog stopped reporting ~2 minutes and 3 rows before the run
stopped - consistent with the wrapper dying first and the sweep living briefly on.

## The five rows

| trial | verdict / reason | steps | `press_key` | escalated |
|---|---|---|---|---|
| 0 | refuted / modified | 3 | no | no |
| 1 | refuted / modified | 15 | no | no |
| 2 | **refuted / modified** | **4** | **yes** | **yes** |
| 3 | refuted / persisted-mismatch | 0 | no | no |
| 4 | refuted / persisted-mismatch | 0 | no | no |

**Only 1 of 5 attempted a save**, and only that one exercised the escalation path.
Trials 3 and 4 did **nothing at all** (0 steps) yet were scored `persisted-mismatch` -
worth a look, since a zero-step row that reaches the judge is a different shape from
a planner that tried and failed.

## Spend

Per the owner's `PRIOR_SPEND.md`, seeded at **3,567,488 µ$** (including the aborted
7:26Z attempt's 376,800 µ$ reservation, counted conservatively because `charged()`
sums reserved entries). **The 5 rows add ~86,336 µ$** (463,024 total in this ledger
minus the 376,800 reservation), so **cash spent this run is ~$0.0863** against
$3.567488 prior -> roughly **$3.654 booked of the $9.00 ceiling**.

**The `reserved` trial 5 entry is a reservation, not spend** - no planner call
occurred, since the run died in the reset before the trial started. The same
cash-versus-reservation split as arm-002's $1.178562 / $1.555362.
