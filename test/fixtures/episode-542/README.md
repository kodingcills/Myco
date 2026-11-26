# Vendored `myco.episode/1` contract from #542

These files are #542's (`claude/data-capture-episode-schema-8fqvjs`) at
`2e39c2463cc2fc7c0168721ed077b104f2b8733f`, byte for byte except import paths (biome also re-sorts the import lines):

| Here | #542 path | Change |
|---|---|---|
| `schemas/episode.ts` | `schemas/episode.ts` | imports of `src/gate/api.ts`, `schemas/m2-evidence.ts`, `schemas/validate.ts` point at this repo's copies (unchanged between main and that head) |
| `src/episode/validate.ts` | `src/episode/validate.ts` | import of `schemas/validate.ts` points at this repo's copy |
| `src/episode/clean.ts` | `src/episode/clean.ts` | none |
| `src/episode/types.ts` | `src/episode/types.ts` | import of `src/gate/api.ts` points at this repo's copy |

Only tests import them (`test/dataset/episode-mirror.test.ts`, `test/dataset/export.test.ts`,
`test/desktops/e2e.test.ts`): track U's exporter must accept the episodes #542 writes, and every
episode U exports must pass #542's own `validateEpisode`. `src/` never imports this directory.

Re-sync: `scripts/episode-mirror-drift.sh` reports whether #542's head has moved past this copy.
If it has, copy the four files again, update `EPISODE_MIRROR_PINNED_AT` in
`src/dataset/episode.ts` and `VENDORED_AT` in `test/dataset/episode-mirror.test.ts`, and bring the
mirror back in step until the tests pass. Delete this directory when #542 merges (linux-scale.md
§10 item 9).
