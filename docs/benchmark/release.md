# Release packaging: the false-completion package and datasets

Track G, #613. Covers item N2 of #612. This page says how the public release bundle is built,
what it may contain, and how CI proves that the grader reproduces from the bundle alone.
There is no ranking and no leaderboard. The bundle carries the task set, the grader and the
protocol, and no result.

## Build

```sh
git fetch origin main
npx tsx scripts/benchmark-release-package.ts --ref origin/main --out <new dir> \
  [--dataset <name>=<.../dataset or .../ds>]... [--identity-file <file>]
```

- **From the commit, not the working tree.** Every repo file is read from git (`git cat-file`)
  at `--ref` (default `HEAD`). Local edits, extended attributes and owners never enter the
  bundle. `release-manifest.json` records the commit (`sourceCommit`).
- **Allowlist only** (`src/benchmark/release/package.ts`):
  - `LICENSE`;
  - the task set `benchmark/false-completion/fc-v1/`;
  - three public pages: `docs/benchmark/public/README.md`, `grading-protocol.md` and
    `task-set-card.md`;
  - the grader's import closure, from `scripts/benchmark-grade.ts` and
    `scripts/benchmark-verify-bundle.ts`.

  The closure may only reach `scripts/`, `src/benchmark/grade/` and `schemas/`, plus
  `node:` built-ins. A package import, a dynamic import or a path outside those trees refuses
  the build. `reproduce-linux.md` is not published: it is a clone-based recipe, and its
  `mktemp` template is an absolute path. The bundle's own `RELEASE.md` gives the bundle-alone
  steps instead.
- **Datasets** come in only through `--dataset`. The directory itself must be named `dataset`
  or `ds`, so the run logs beside it, which hold absolute host paths, cannot come along
  (#612 N2). For the #531/#542 re-export those are `episode-542/dataset`,
  `container-531/.../dataset` and `container-531/.../ds`. Each file must be a regular UTF-8
  text file with a plain, non-hidden name. A symlink, a binary, `.DS_Store` or an AppleDouble
  `._*` file refuses the build. Files are published as `datasets/<name>/...`.
- **Leak scan.** Every file's path and every line are scanned. The following refuse the
  whole build:
  - an absolute host path;
  - this machine's user or host name;
  - each string in `--identity-file` (one per line, such as a full name or a ComputerName);
  - a secret-shaped string;
  - the planted canary.

  This is the track U scan (`src/dataset/hygiene.ts`) plus the shared identity rule
  (`src/export-guard` `heldEntries`), which catches joined forms such as `First.Last` and
  single words of 3 or more characters. A finding names the file, line and kind, never the
  matched text. Nine exact lines of the grader's own source (regex literals and `#/$defs/`)
  are exempt from the host-path kind only (`CODE_HOST_PATH_EXEMPT_LINES`). Any edit to one of
  those lines removes its exemption.
- **Archive.** `<out>/myco-false-completion-fc-v1.tar` is plain ustar, written from the bytes
  in memory:
  - no pax or GNU headers, so no extended attributes (no `com.apple.provenance`);
  - empty owner and group names, uid and gid 0, mode 0644;
  - the commit's time as the mtime, and entries in sorted order.

  The same commit and datasets give the same bytes. `<archive>.sha256` holds the archive's
  hash.
- **SHA-256 of every file**, in `SHA256SUMS` (the format `sha256sum -c` reads) and in
  `release-manifest.json`.
- **Reproduction set.** The packager writes CSV documents for every task:
  - the intent applied, which must grade `pass`;
  - the fixture untouched, which must grade `fail`;
  - one missing document per fault class, which must grade `ungradable`.

  That is 195 requests. It runs the bundled grader from the bundle tree with a bare
  environment and refuses the build unless every status is the constructed one. The rows
  become `reproduce-expected.jsonl`.

Exit codes: 0 when built, with a JSON summary; 1 when refused; 2 on a usage error.

## CI: the grader from the archive alone

Job `benchmark release (bundle alone)` (`docs/ci.md`) runs on every PR:

1. It builds the release twice and requires byte-identical archives.
2. It runs `scripts/benchmark-release-repro.sh <archive>`. The script checks that every tar
   entry is a 0644 regular file owned by 0/0, then unpacks the archive into a new, empty
   directory with no clone and no `node_modules`.
3. From there, with `PATH` as the only environment variable, it runs `sha256sum -c
   SHA256SUMS`, the bundled task-set verifier and the bundled grader with plain Node 24. The
   regraded rows must equal `reproduce-expected.jsonl` byte for byte.

`test/benchmark/release-package.test.ts` tests each claim on this page.

## Not covered here

- The reproduction documents are CSV only. Saved `.xlsx` workbooks (the VM arms' format)
  are a follow-up, and need a deterministic workbook writer outside `test/`.
- Running the dataset validators (`validateDataset`, `validateContainer`) inside the
  packager. #612 D1, D2 and N1 are their tracks' fixes.
- Publishing: tagging, uploading and announcing a release is a lead decision.
