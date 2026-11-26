# Example plugin: csv-ledger

A `myco.plugin/1` plugin (`docs/plugins/byoa.md`) for "ledger", a simple text/CSV app. It is
the reference for third parties writing their own.

**The app's format.** UTF-8 CSV: a header row starting with `id`, one row per entry (no quoting;
fields never contain commas, quotes or newlines), a trailer line `#rows,<n>`, and a final
newline. The trailer lets the oracle tell a complete save from a truncated one.

**Oracle.** Intent `{ id, column, value }`: "set `column` of the row whose `id` is `id` to
`value`". `uncertain` when the document cannot be read in full (missing, not UTF-8, no or wrong
trailer, ragged rows, quoting, duplicate ids); `refuted` when it is complete and the target does
not hold the value; `verified` only when it is complete and the target holds exactly the value.

**Claims:** `edit-missing`, `wrong-value`, `wrong-target`, `truncated`, `missing-file`.
Not claimed, on purpose: `collateral` (the oracle checks the target only) and `corrupt-byte`
(a flipped byte in another row is invisible to a target-only check; the registration report
shows the host's flips caught only partly). Adding either claim makes registration fail.

**Reader.** Returns `{ kind: "cells" }` with A1 refs, numbers typed as numbers.

**Self-test.** Three deterministic ledgers, each with a correct save and one corruption per
claimed class. Myco adds its own truncations, byte flips and a missing file at registration.

**Run it ($0):**

```sh
pnpm exec vitest run test/plugins/csv-ledger-e2e.test.ts test/plugins/registry.test.ts
```

The entry has only `import type` imports, so the directory is self-contained: copy it, edit the
manifest and `plugin.ts`, and register the copy with `registerPlugin(dir)`
(`src/plugins/host/registry.ts`).
