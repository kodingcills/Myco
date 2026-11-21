# Run report (MVD-007)

Renders one run directory — the schema-valid artifacts every Myco run already
emits — into a single self-contained HTML page. It is the developer-facing half of
Direction A: the verdict, the claim it checked, and the evidence behind it, on one
page a person can attach to a PR.

```sh
pnpm report runs/<runId>                 # writes runs/<runId>/report.html
pnpm report runs/<runId> --out /tmp/r.html
```

Exit 0 on success. Exit 2 when `result.json` or a `trace.jsonl` line violates the
ADR-0007 schema: a malformed bundle is never turned into a readable page.

## What it is not

- **It computes nothing.** The verdict on the page is the artifact's. The renderer
  has no oracle and no thresholds.
- **It does not soften absence.** A record with no verdict renders as
  *No verdict*, with the sentence that it is not a success. A `session` record (the
  runtime layer) says it records execution only. `uncertain` is amber, never green.
- **It does not read or write the network.** No script, no external asset.

Every artifact value is HTML-escaped; quotes are unescaped only in prose contexts
(`<code>`) where `&#39;` would be noise.

## Proven against real artifacts

`docs/research/experiments/m1-013-session1/` holds three real runs from the M1
Windows sweep, and `test/report.test.ts` renders all of them plus synthetic
worst-case inputs (10 KB values, 500 steps, null/garbage records, hostile markup).

| Run | Verdict shown | Screenshot |
|---|---|---|
| `normal-711e16c1` | Verified, score 1, 4 steps | [verified.png](screenshots/verified.png) |
| `refuted-autocorrect-d7ad45bf` | Refuted, guard failed at step 2 | [refuted.png](screenshots/refuted.png) |
| `kill-87ee5b14` | Uncertain, adapter-available guard failed, aborted `uncertain` | [uncertain.png](screenshots/uncertain.png) |
| refuted run at 390 px | — | [refuted-390.png](screenshots/refuted-390.png) |

Screenshots were taken in Chromium at 1440 px and 390 px against the rendered
files; the theme shown is dark because the capture environment prefers dark, and
the page follows `prefers-color-scheme`.

## Design decisions

- **The verdict is the page.** Status colour is used nowhere else as decoration;
  `verified` / `refuted` / `uncertain` each have a distinct hue *and* a glyph, so
  the page survives greyscale and colour-blindness.
- **Quieter detail as it goes down.** Run facts → checks → steps → faults and
  recoveries → parameters → evidence. A reader who stops after the last check still
  has the answer.
- **Numbers are monospace, prose is sans.** Values, versions, paths and ids are
  monospace so a reader can compare them character by character.
- **Middle truncation, not tail.** Long values keep their head *and* their tail,
  because the tail is usually the extension or the version that matters.
- **No motion.** This is read, not operated; there is nothing to interrupt and no
  action to acknowledge.
- **Print-safe.** Steps never split across a page break; the palette collapses to
  black on white.

## Open question for the outer loop

The verdict block is the right shape for a single run. A *suite* view (N runs,
pass/fail counts, a trend) is deliberately not built yet: it should follow the
first real Direction A run, so it is designed against real data rather than guesses.