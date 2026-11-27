# Track P pre-registration p-v1 (Cross-app workflows)

Frozen pre-registration for capability track P, per `docs/product/capability-spec.md` §3. The
bar is `docs/product/capability-spec-2.md` §P as written. **Nothing has been run under it, and
no result is claimed.** No run starts until the lead gives GO for track P.

- `prereg.json`: the bar, the task set (`xa-v2`, 40 tasks) and its manifest SHA-256, the seeds
  (assignment, bootstrap, task build), the step and retry budgets, the planner model id, and
  the analysis module and script with their SHA-256. Values in `leadRulingPending` are
  proposed, not ratified.
- `prereg.sha256`: the **pre-registration hash**, SHA-256 over the canonical JSON (keys sorted,
  no whitespace) of `prereg.json`. Every track P pack records it and the commit it was frozen
  in; the analysis refuses a pack whose hash differs.

Check, print the run order, or analyse a pack:

```
npx tsx scripts/cross-app-prereg.ts check
npx tsx scripts/cross-app-prereg.ts schedule
npx tsx scripts/cross-app-prereg.ts analyze <pack.json>
```

**Lead rulings.** While `leadRulingPending` is not an empty array, `analyze` decides nothing:
the decision is `lead-ruling-pending` (exit 1), never `shown`. The lead ratifies by emptying
the list (and amending any value they rule otherwise) before the first measurement run; that
changes the pre-registration hash, so `prereg.sha256` is re-pinned in the same change.

**Decision.** `shown` only if component 1 (McNemar) and component 2 (steps per verified) are
both shown; `component1` and `component2` report each on its own. One gate false-verified in
`B+P` fails the bar: the end verdict `verified` while any step or the end grades not `pass`, or
a checkpoint k `verified` while any of steps 1..k grades not `pass`. False done is a done claim
while the task grades fail, a masked step included.

**Commit.** A pack records the commit the prereg was frozen in; the analysis checks only that
it is present and is a 40-hex SHA. It is not looked up in git history.

**Not in p-v1.** Wall time and cost per verified task (spec-2 §P secondaries): the pack has no
such fields and the analysis computes neither.

**Simulated rows.** Rows are experiment rows, never R1 evidence. A row is refused
(`SIMULATED_ROW`) if its planner is not the pre-registered model id or if it carries a
`simulated` marker that is anything but exactly `false` (`"true"`, `1` and `null` are all
refused). The analysis reads only what the pack says: **a scripted row that carries the real
planner id (`claude-sonnet-5-5`) and no marker would be accepted.** Nothing in this PR writes P
packs. What prevents that row today is procedural: no run starts before the lead's GO, and while
any lead ruling is pending no pack is decided at all. The run harness that will write P packs
does not exist yet (a follow-up); it must stamp `plannerModelId` from the planner the run
reports, never from configuration, and set `simulated: true` for any planner that
`isSimulatedPlanner` (`src/skills/record.ts`) flags, as the skills arm does
(`src/skills/arm.ts`), and it is reviewed before the first run.

A change to anything here after the first measurement run is a new version (`p-v2`); runs
under p-v1 stay reported under p-v1.
