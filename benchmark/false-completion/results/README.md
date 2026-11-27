# Verified result packs (benchmark site)

The benchmark site's results table (`scripts/benchmark-site-build.ts`, `docs/benchmark/site.md`)
is filled only from the result packs in this directory. **There are none yet**, so the site
shows "No verified results yet".

Each subdirectory is one result pack:

```
<id>/
  result.json                  schema myco.benchmark.site-result/1: id, kind, files (path -> SHA-256)
  pack/                        one M2 evidence pack (schemas/m2-evidence.ts layout)
  attempt-anchors/pack.jsonl   the pack's external attempt anchor
```

A pack is refused, and the build fails, unless every file matches its digest, every file is
committed and unchanged, the M2 evidence check passes on it, and every row is evidence (no
simulated or experiment rows). `kind` must be `evidence`; `test-fixture` packs exist only in
tests. Adding a pack here is a results release: Tier 2, and the lead decides.
