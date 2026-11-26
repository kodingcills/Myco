# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Myco has no
versioned releases yet; entries are grouped by milestone. License: [Apache-2.0](LICENSE).

## [Unreleased]

### Added

- `myco-state` (capability track I): a separate, read-only MCP server that gives an agent
  the live app's structured state instead of pixels. Its tools read sheets and used ranges,
  cells (values and formulas as Calc holds them), the document's save state, and a bounded
  accessibility-tree summary. The Linux headless Calc backend is shipped; the backend seam
  is ready for a Windows/UIA backend. The server is bound to one trial, takes no path, caps
  every reply and returns codes only. It is not part of the gate, and it is not proof of
  completion. Launch plans for the `structured-state`, `screenshot-only` and `hcu+shell`
  arms are audited by the extended launch audit. Their rows never count as R1 evidence
  ([docs/state/tools.md](docs/state/tools.md), [security](docs/state/security.md),
  [measurement plan](docs/state/measurement-plan.md)).
- `myco init` (`bin/myco init`, `pnpm myco init`): one-command setup. Checks the Linux
  desktop path, starts the gate once and checks it fails closed, then writes the `myco-gate`
  MCP entry for Claude Code and Codex into the project (refuses HOME as the project, never
  follows a symlink out of it). Each change is one splice of the original file, re-parsed
  before it is written; anything it cannot merge is a conflict and nothing is written.
  User-level configs only with `--global --yes`, after the exact diff and a backup; no secrets.
  A hard-linked or non-regular target is a conflict; CRLF files keep CRLF. `--tasks <file>`
  passes an operator tasks file to the gate. An end-to-end test (`linux path` CI job) runs
  init against real headless Calc and gets verdicts through the written config
  ([docs/product/setup.md](docs/product/setup.md)).
- `LICENSE`: Apache-2.0, chosen by the owner on 2026-11-25.
- Community files for open-source readiness: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`
  (Contributor Covenant 2.1), `SECURITY.md`, issue and pull request templates, and this
  changelog (TIF-258).

### Post-M1 hardening merged on 2026-11-25

Merged after the M1 sign-off (#444). None of these changes a number in
[docs/m1-scorecard.md](docs/m1-scorecard.md).

#### Security

- Close path-from-pieces and quote-lexer bypasses in the secret-file tests (TIF-236)
  ([#447](https://github.com/kodingcills/Myco/pull/447)).
- CI: least-privilege permissions, pinned actions, fork-safe triggers (TIF-241), documented in
  [docs/ci.md](docs/ci.md) ([#464](https://github.com/kodingcills/Myco/pull/464)).

#### Fixed

- Viewer and scorecard: visible budget retry note and pinned M1 signer (TIF-238)
  ([#450](https://github.com/kodingcills/Myco/pull/450)).
- The s0-live launcher lock test is safe under parallel vitest (TIF-233)
  ([#454](https://github.com/kodingcills/Myco/pull/454)).
- `validate-live`: full-tree walk, no silent skips, per-path errors (TIF-226)
  ([#457](https://github.com/kodingcills/Myco/pull/457)).
- `scorecard-check`: close the four sweep gaps from the #434 review (TIF-230)
  ([#459](https://github.com/kodingcills/Myco/pull/459)).
- Deploy: token-file runbook warning, `-w` check and tests (TIF-229); `validate-live` runbook
  (TIF-226) ([#462](https://github.com/kodingcills/Myco/pull/462)).

#### Changed

- Session-info tests: TIF-237 exit-0 proof, stderr assertion, temp-dir cleanup
  ([#448](https://github.com/kodingcills/Myco/pull/448)).
- Post-M1 test nit batch 1 (TIF-243, #450/#454 verifier nits, README)
  ([#458](https://github.com/kodingcills/Myco/pull/458)).
- Post-M1 test nit batch 2 (TIF-249, TIF-250)
  ([#461](https://github.com/kodingcills/Myco/pull/461)).
- README: M1 results section; runbook row-8 lessons (TIF-240)
  ([#445](https://github.com/kodingcills/Myco/pull/445)).
- Pre-M2 repo and worktree cleanup record, and the lead's cleanup rulings (TIF-239)
  ([#451](https://github.com/kodingcills/Myco/pull/451),
  [#453](https://github.com/kodingcills/Myco/pull/453)).

## M1 — 2026-11-25

Verified, recoverable `calc-record-edit` execution on real LibreOffice Calc in Windows 11 ARM64.
All 8 acceptance rows are DONE; row 8 is DONE given the VM bundle, because the ISO, payloads and
`clean-base` snapshots live outside the repo. The figures below are quoted from
[docs/m1-scorecard.md](docs/m1-scorecard.md), which is the record; recompute them with
`python3 scripts/scorecard-check.py`.

| # | Criterion | Headline |
|---|---|---|
| 1 | Real desktop execution | Sweep v3 ran all 30 `calc-record-edit` tasks (29 verified, 1 refuted by an infrastructure guard failure before any UI action) on LibreOffice Calc 26.8.3 native ARM64 in Windows 11 ARM64 (UTM) |
| 2 | Independent verification | `UnoVerifier`: live UNO read + `isModified` + persisted-file parse; trace events, including the GUI's `claim` event, are never read by the verdict path |
| 3 | Reliability (≥ 27 of 30) | **29/30 verified** (sweep v3 at `aa96974`) |
| 4 | Failure detection | of 24 recorded, 21 carried a verdict — 7 `verified`, 11 `refuted`, 3 `uncertain`, `falseSuccesses: 0`, `unprovenVerified: 0` |
| 5 | Recovery | Four kill trials completed a relaunch and three invalid-target trials completed the first retry; all seven recovered trials verified |
| 6 | Evidence | **54 results** (30 from m1-013 + 24 from m1-014) and **929 trace events** (525 + 404), every line `ALL OK` |
| 7 | Baseline | Myco v3: **29 verified, 1 refuted**; screenshot agent: **0 verified, 30 refuted**; paired: Myco-only success **29**, baseline-only **0**, both refuted **1**; exact two-sided sign test **p = 3.7e-9** |
| 8 | Reproducibility | DONE (given the VM bundle). §7.3 sweep: **28/30 verified**; §7.4 corrupted suite: 18/18 recorded and eligible, 6 verified / 9 refuted / 3 uncertain, **0 false successes** |

**Sign-off.** M1 signed off 2026-11-25 by the outer-loop engineering lead, recorded in
[#444](https://github.com/kodingcills/Myco/pull/444) and in the
[M1 sign-off](docs/m1-scorecard.md#m1-sign-off) section of the scorecard.
