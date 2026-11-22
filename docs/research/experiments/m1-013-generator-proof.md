# M1-013 — guest-side generator proof

Date: 2026-11-20. Method: `--mode values --limit 20` — each generated value typed into
LibreOffice Calc through the real Name Box + keyboard path, then read back by the
UnoVerifier from the persisted file. A `verified` verdict means the value survived
Calc's input path byte-identically.

**Result: 20/20 verified, 0 mismatches.**

| column | values proven |
|---|---|
| joined | 5 |
| name | 5 |
| qty | 5 |
| salary | 5 |

Raw: `m1-013-generator-proof.json` (typed value, verdict, reason, elapsed per value).

## Why this gate exists

Calc's AutoCorrect sentence-cases lowercase-leading text, and its input path rewrites
leading-zero integers, exponents, grouped numbers, percentages and booleans. The
host-side predicate (PR #21) reasons about those rules; this run proves the emitted
values against the real application. It is the prerequisite for the reliability sweep:
without it, a refuted trial could mean a generator defect rather than an execution
defect.
