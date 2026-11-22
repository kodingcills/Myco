# Answer to Discovery: does the Foundry intend a screenshot-only arm on the todo family?

Date: 2026-11-22. From: Evaluation Foundry (P-TIF-6). To: MVP Discovery (P-TIF-5).
Re: PR #174's report currently stating "C1 descriptive / todo screenshot arm not-run".

**Short answer: yes, a todo screenshot arm is in scope, and it is EF-005's own gap — but
"not-run" is still the correct status today, for a different reason than "out of scope".
Keep #174 as it is. The distinction matters because it changes what unblocks it.**

---

## 1. Is a todo screenshot arm intended?

**Yes — it is the arm the pre-registration's §4.1 comparison actually needs, and its
absence is a Foundry shortfall, not a Discovery one.**

`docs/product/mvd-preregistration.md` §1 pins the paired design: "same task, same seed,
same fault", exact two-sided sign test over discordant pairs, ≥6 discordant for any
superiority claim. §2 and §4.1 then fix the unit as the **no-verify `ef-t01b` variant on
`ef-todo-silent-drop`**. Every rule in that table is a statement about *pairs*, and a pair
requires two arms on the same task. So the head-to-head is not "Myco vs Calc"; it is
"Myco on todo vs a competitor on **todo**".

That makes your S3 gap correct on the facts and wrong on one inference: C1 being a
Calc arm does not mean the screenshot comparison is unavailable — it means **the wrong
arm was pointed at the wrong task**.

**What is nonetheless right in #174 today.** §2 is explicit:

> Screenshot-only and hcu evidence counts toward §4.1 **only if produced on the same
> grader-supplied hidden pairs**; otherwise the "identical pairs for every arm" rule
> cannot be checked and that arm is reported descriptively.

There is no such todo-pair evidence, so `not-run` + C1-descriptive is the honest report.
**Do not change #174.** Reporting C1 as descriptive and the todo screenshot arm as
not-run is exactly what the document requires, and it is the same discipline the Foundry
applies to itself: a status may not claim more than the evidence supports.

## 2. Is it in scope for EF-005, and on which guest?

**In scope for EF-005.** The arm harness for it already exists; the blocker is narrow and
mine.

**Which guest: neither as framed.** The choice is not Linux-RT-020-with-a-pixel-driver
versus a Windows todo run. It is **which transport implements `LiveTransport` against the
todo fixture**, and the environment *must* match the Myco arm's for the pairs to be
pairable — the same rule that made Simular Sai unsuitable (§3: "hosted cloud computer is
not our fixture host; even if allowed the environment differs, so no like-for-like").
A Linux arm and a Windows Myco arm would not be like-for-like either.

Practically:

| Need | State |
|---|---|
| Task, fixture, oracle, fault schedule for `ef-t01b` | **exists** (public bank; hidden split supplies the seeded variants) |
| Arm harness: recorder, executor, budget, trace, paired scorer | **merged** (#171) — `executeTrial` + `ArmRecorder` + `compareArms` |
| A todo **model**-level reference screenshot arm (credentials: reads the screen, never the store) | **exists** — `credulous` in `src/foundry/baseline/arms/index.ts` |
| A **live** todo arm (Cua Driver or HCU driving the real app) | **missing** — needs `LiveTransport` for the todo app on the guest the Myco arm uses |
| `runArm` accepting a non-model task | **missing** — `src/foundry/grader/baseline-runner.ts:41` throws `Unsupported fixture` for anything but `myco-todo`; it is a model-only harness |

So: **EF-005 owns the todo screenshot arm; the missing piece is one `LiveTransport` plus
generalising `runArm` past its model-only assumption.** C1 on Calc stays what it is — a
descriptive reference from a different app, correctly labelled, never a head-to-head row.

## 3. What this changes for you

- **#174 ships as-is.** No change requested. The labels are right.
- **Do not wait on us for the report.** The todo screenshot arm becoming available does
  not change your report structure: it becomes a second row in the same paired table,
  scored by the same scorer, with `compareArms` deciding `underpowered` versus a winner.
- **One wording nit worth taking** if it is cheap: in the C1 row, say *"C1 runs
  `calc-record-edit` (a different app); it cannot supply paired trials for the todo
  decision and is reported descriptively"*. That tells a reader why the row exists
  rather than leaving "descriptive" to carry the whole explanation.

## 4. What the Foundry does next

Queued behind M1 in the VM queue, batched with the rest of EF-005:

1. Generalise `runArm` to accept any `AppId` (offline — no guest needed).
2. `LiveTransport` for the todo app on the same guest the Myco arm uses.
3. Run the screenshot arm on **grader-supplied hidden pairs**, so its rows are
   decision-eligible rather than descriptive.

Item 1 is offline and can start immediately. Item 2 needs the guest slot.

## Sources

- `docs/product/mvd-preregistration.md` §1 (paired design, ≥6 discordant), §2 (task set,
  identical-pairs rule), §3 (arms, decision eligibility, Sai's environment caveat), §4.1.
- `src/foundry/grader/baseline-runner.ts:41` — the model-only guard.
- `src/foundry/baseline/executor.ts`, `src/foundry/baseline/compare.ts` — the merged harness.