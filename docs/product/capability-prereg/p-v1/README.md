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

Rows are experiment rows, never R1 evidence. Simulated rows (a planner other than the
pre-registered model id, or a row marked simulated) are refused. A change to anything here
after the first measurement run is a new version (`p-v2`); runs under p-v1 stay reported under
p-v1.
