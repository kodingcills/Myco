# Benchmark site (local build only)

Workstream 3, track G (#667). A static site generated from the public false-completion
package. **It is not published or deployed.** It builds into a local directory, and CI builds
and checks it. Publishing is decided at the M2-end announcement.

```sh
npx tsx scripts/benchmark-site-build.ts --out work/site [--identity-file FILE]
```

The output directory must not exist or must be empty. The command exits 1 on a refused result
pack or a leak finding, and 2 on a usage error.

## Pages

| Page | Source |
|---|---|
| `index.html` | `docs/benchmark/public/README.md` |
| `task-set.html` | `docs/benchmark/public/task-set-card.md`, plus every fc-v1 task read from the SHA-256-pinned `tasks.jsonl` |
| `protocol.html` | `docs/benchmark/public/grading-protocol.md` |
| `grader.html` | The grader version, and the SHA-256 of each grader module and the grader and verifier CLIs |
| `results.html` | Verified result packs only (below) |
| `SHA256SUMS` | Every page, in `sha256sum -c` format |

Links to repository files that the site does not publish render as plain text.
`reproduce-linux.md` is not a page: it names working-tree paths that the leak scan refuses.
It stays in the repository.

## Results: verified packs only

The results table reads only result packs under `benchmark/false-completion/results/<id>/`.
Its layout is in that directory's README. The generator (`src/benchmark/site/results.ts`)
renders a number only after all of these checks pass:

1. `result.json` (schema `myco.benchmark.site-result/1`) is closed: `schema`, `id`, `kind`,
   `files`. It pins every other file of the pack by SHA-256. A missing, extra, symlinked or
   differing file is refused. The manifest admits no number of its own.
2. Every file, `result.json` included, is the blob at `HEAD`, unchanged in the working tree.
3. The existing M2 evidence check (`checkPack`, `src/m2/evidence.ts`) passes on the pack.
   It recomputes every number from the committed ledgers at build time.
4. Every row is evidence: every planner is in `EVIDENCE_PLANNERS`, with no simulated or
   experiment rows and no `SIMULATED` or `EXPERIMENT` marker (`packProvenanceErrors`). The
   task set is a published one.
5. `kind` is `evidence`. A `test-fixture` pack is accepted only by tests, and it renders under
   a "TEST FIXTURE: not a benchmark result" banner on every section that carries numbers. The
   build CLI always refuses one.

Any refused pack fails the whole build. A refusal never just drops a row. The renderer accepts
only the objects that the verifier returns (frozen, checked by identity), so a hand-built
result cannot be rendered.

With no pack, the table shows "No verified results yet" and no number. Today there is no
pack. There is no leaderboard and no third-party row without real runs.

## Output hygiene

Before anything is written, every output line is scanned. The scan is the dataset leak scan
(`src/dataset/hygiene.ts` `leaksIn`): host paths, this machine's user and host names, the
canary and secret-shaped strings. It also applies the `src/export-guard` identity rule
(`heldEntries`) to the strings of `--identity-file`. A finding names the file, line and kind,
never the matched text, and refuses the build.

The build is deterministic. It reads no clock, host data or environment, so a rebuild is
byte-identical. CI checks this.
