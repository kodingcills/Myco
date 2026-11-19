# Finding Q2 — Independent verification of persisted desktop outcomes

Date: 2026-11-19. Level: L1 (index hit; citation spot-check only).

## Question

What independent verification approach best establishes the ground truth of
persisted desktop outcomes? Check OpenComputer (arXiv 2605.19769) against M1's
UNO and saved-file verifier.

## Evidence

- OpenComputer (`arxiv:2605.19769`, docs/research/eval-frameworks.md §2) is the
  correct one of four same-named projects: `echo0715/OpenComputer`, Yale NLP,
  Apache-2.0. It ships a UNO-based Calc verifier with 16 `check-*` endpoints
  that read object-model/persisted state, not pixels.
- M1 already adopted its *shape* and hardened it (ADR-0002, ADR-0005, ADR-0010):
  - Two independent read-only checks: (1) UNO live readback
    (`getValue`/`getString`/`getError`, `XModifiable.isModified()` pre-check),
    (2) close the document, then host-side parse of the persisted `.xlsx`
    (docs/architecture/m1.md §"The smallest rigorous slice"). Implemented as
    M1-007 (PR #9, verified: exact comparison, dropped-save refuted,
    fabricating agent refuted/uncertain, no hangs).
  - Three-valued verdict `verified | refuted | uncertain` — OpenComputer
    collapses verifier errors to `passed: False`; M1 keeps "could not look"
    distinct (ADR-0002).
  - Expected values computed host-side from `fixtureSeed` + intent parameters —
    OSWorld's `employee_age_reference` discipline ("never open the answer
    workbook in the evaluated guest"), adopted verbatim.
  - No `eval()` of task-supplied strings — OpenComputer's
    `eval(check["eval"])` is a remote-code hole M1 deliberately does not
    import; predicates come from a closed declarative language.
- Citation check: `arxiv:2605.19769` resolves to the OpenComputer paper and
  matches the title/authors recorded in eval-frameworks.md §2.1 (verified
  there against the repo and paper on 2026-11-18). **Verified.**

## Decision

**Already resolved.** M1's verification approach is OpenComputer's shape with
three hardening deltas (three-valued verdict, host-side expected values, no
eval). It is implemented (M1-007) and merged. No further investigation.

## Proposed smallest experiment

None. M1-013/M1-014 (the real-VM evals) *are* the experiment that validates it
end-to-end, including the false-success audit against OpenAdapt's published
54/72 and 30/30 baselines.

## Next action

None for research. When M1-014 lands, its report writes the comparison
against OpenAdapt's numbers back into this finding's `prior_experiments`.

## Reopen-if

- M1-013/014 produce `uncertain` rates high enough to question the two-channel
  design (UNO + file parse).
- The task family expands beyond Calc — then mine OpenComputer's other 15
  `check-*` endpoints for shape, under the same no-eval rule.

## Cost spent

0 new tool calls (index + ADR lookup; citation already verified 2026-11-18).
