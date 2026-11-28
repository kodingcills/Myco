# Cleanup rulings applied (2026-11-25, TIF-239)

The lead's rulings (14:25Z, with the 14:30Z follow-up on ruling 1 and on this record) on the pre-M2 cleanup, applied to the first pass recorded in PR #451 (`docs/coordination/cleanup-2026-11-25.md`). PR #451 had not merged when this was written, so this record is a separate file. I re-checked every item live after `git fetch origin` (origin/main `bb0209e0`) and did not rely on the first-pass inventory.

| Ruling | Removed / deleted | Archived / tagged | Kept |
|---|---|---|---|
| 1. Worktrees with no PR | 18 | n/a | 79 of 97 no-PR candidates, plus every worktree outside the candidate set |
| 2. Local branches with no PR | 40 | n/a | 3 deletable once local main is fast-forwarded, plus every other branch |
| 3. Two remote branches | 2 | 2 tags | n/a |
| 4. Evidence archive | n/a | 9 sources, 7,453 files, 127,285,255 bytes | originals left in `/private/tmp` |
| 5. `/private/tmp/row8-report.md` | 1 | n/a | n/a |
| 6. Token files and the TIF-206 guard worktree (held for Tiffany) | untouched | n/a | untouched |

## 1. Worktrees with no PR: 18 removed

The first attempt was blocked by the host secret guard. The block reason was "modifying the secret guard or harness hook config". Per the standing order, I stopped and reported without retrying. A second guard block hit the first attempt at writing this record. At 14:30Z the lead narrowed ruling 1 and approved a rerun. The TIF-206 guard worktree (held for Tiffany) has a PR, so it was never in ruling 1's scope.

How the rerun selected candidates: worktrees on a branch with no PR in any state (checked against 440 PR head names after a fresh fetch). Detached-HEAD worktrees were left out. The main checkout and the session's own worktree were excluded. This gave 97 candidates, and the rerun neither enumerated nor tested any other worktree. A candidate was removed only if:

1. its index and HEAD were both modified more than 6 h ago,
2. `git status --porcelain` was empty,
3. `git merge-base --is-ancestor HEAD origin/main` succeeded, and
4. its ignored files were limited to build output (`node_modules`, `dist`, `build`, `.turbo`, `.cache`, `.vite`, `*.tsbuildinfo`).

Removals used `git worktree remove`, never `--force`. Afterwards `git worktree prune -v` pruned nothing.

Removed (worktree dir under `~/.t3/worktrees/Myco/`, branch):

- `t3-03111cd0-f4efc049048d5612` (`feat/foundry-mvd-arms`)
- `t3-1641b922-a04feca906b310dd` (`pr21`)
- `t3-17ca3352-93b5572a2727a136` (`review/verify-m1-reset-snapshot`)
- `t3-1c8af64c-6ff20a419d9fbec6` (`feat/evidence-ledger-schema-fix`)
- `t3-286a0d2b-8aae029a9566b8ce` (`t3/286a0d2b`)
- `t3-29d63440-5300ddb9e4e83c61` (`chore/review-pr32-delta`)
- `t3-2f4028c8-7ba608410a8867bd` (`fix/reset-wedge-diagnosis`)
- `t3-3d7aed0e-bcaae58d042a33e1` (`review/verify-pr-25`)
- `t3-3d889040-84bc53052c18ce0a` (`chore/verify-pr21-delta`)
- `t3-3e99f311-0ecff0efd1c871f4` (`pr-2-review`)
- `t3-6cf69b5e-991dc16c30c57f21` (`feat/foundry-mvd-arms-impl`)
- `t3-719dd7b7-b8743c8ccc7693a9` (`review-pr7`)
- `t3-858c0f96-6dfa8e8a120ce58d` (`test/m1-live-eval-reproduction`)
- `t3-9be5ca58-655e1083c9071092` (`pr-9-review`)
- `t3-b6d74d80-14d75eb1ec1e0a40` (`review/verify-m1-019`)
- `t3-d877d6fe-2575c3b34b7da88d` (`fix/always-cleanup-guest-health`)
- `t3-dda0aac6-c40ee9051779235f` (`chore/verify-pr31-revert`)
- `t3-f15b1302-1685627ac9e433e1` (`pr29`)

Kept (79 candidates):

- 28 had recent activity. 24 of them show the same age of 26 minutes. That age matches the read-only audit from the blocked first attempt, which ran `git status` in every worktree and very likely refreshed their index files. They were kept anyway, as the rule says. A later pass can recheck them.
- 11 were dirty.
- 39 had a HEAD that is not on origin/main.
- 1 had non-build ignored files.

| Worktree | Branch | Reason kept |
|---|---|---|
| `rulings-wt` | `tif-239-cleanup-rulings` | recent activity (4 min) |
| `subagent-M1-016-Independent-Reproducer-self-7d0ce271-myco-m1-foundation-95aeae353c16932a` | `subagent-M1-016-Independent-Reproducer-self-7d0ce271-myco-m1-foundation-95aeae353c16932a` | dirty (1 entries) |
| `subagent-PR-88-Independent-Verifier-self-10d71704-myco-m1-foundation-95aeae353c16932a` | `subagent-PR-88-Independent-Verifier-self-10d71704-myco-m1-foundation-95aeae353c16932a` | dirty (1 entries) |
| `row7-r6-vs-v3` | `m1-signoff-fix` | recent activity (26 min) |
| `t3-001e6259-0dae4cf5ed17c3c7` | `rev150` | HEAD not on origin/main |
| `t3-074ce4a2-e6dfe4a5c2ff784a` | `fix/calc-record-rebase` | recent activity (26 min) |
| `t3-0874f5cb-0c8054f7fb0f9d2e` | `myco/m1-021-harness` | HEAD not on origin/main |
| `t3-0adecf8f-821cb1da23e185f9` | `fix/remove-c1-ac-gate` | HEAD not on origin/main |
| `t3-0fe5e1e3-efdb850e1dead0b0` | `review/verify-pr-157` | HEAD not on origin/main |
| `t3-103786b9-845e55cda727558c` | `fix/task-text-parity` | HEAD not on origin/main |
| `t3-19ca712e-6b213f8b93560db7` | `fix/c1-preflight-timeout-1` | HEAD not on origin/main |
| `t3-1bcccfe2-5761a86f7664d7dd` | `review/tif-139-posthoc-verification` | HEAD not on origin/main |
| `t3-22fc8fbb-52270f00ba4b0af3` | `chore/review-pr-157` | HEAD not on origin/main |
| `t3-283caf60-26978ffce780bc0b` | `myco/m1-021-followup` | HEAD not on origin/main |
| `t3-287d0774-9ec65635a51fe311` | `chore/verify-agent-deploy` | recent activity (26 min) |
| `t3-366773a5-ee738cdf72d46f12` | `docs/m1-016-independent-reproduction` | HEAD not on origin/main |
| `t3-3716a67a-39d4bf5ab3eefb73` | `fix-416-fixture` | HEAD not on origin/main |
| `t3-3d9e0b56-2768e59a63bdd807` | `chore/review-pr-241-1` | recent activity (26 min) |
| `t3-40e6a6e6-00e847dbc1d5444b` | `docs/verify-readme-commands` | recent activity (26 min) |
| `t3-4106837a-eb2993ac7cbd483a` | `chore/review-pr-241` | HEAD not on origin/main |
| `t3-429f505e-089733c205eb290a` | `docs/research-desktop-adapters` | recent activity (26 min) |
| `t3-447a719c-6aa96bd7068ae74c` | `review/tif-138-posthoc-verification` | recent activity (26 min) |
| `t3-45ae8591-10a5bb043def8d8b` | `chore/review-pr-294` | HEAD not on origin/main |
| `t3-4601fed3-847da09bd6f151ff` | `tif-212-fix` | recent activity (26 min) |
| `t3-4e6e4899-1bfe7dac59b62a63` | `tif-225-final` | recent activity (26 min) |
| `t3-542c3afa-9af3bfca22385480` | `chore/review-pr1-runtime` | recent activity (26 min) |
| `t3-559994e5-9fb35469ab0f604d` | `feat/session-info-cli` | HEAD not on origin/main |
| `t3-56c27ccc-543505bf384963c4` | `chore/review-pr-5` | recent activity (26 min) |
| `t3-5ee1cf0b-f51699d3768de752` | `tif-209-fix-r1` | HEAD not on origin/main |
| `t3-5f72e4be-f10f4ab312b612d2` | `chore/review-arm-002` | HEAD not on origin/main |
| `t3-5fbaaa6e-5a43d69e82fb5545` | `docs/verify-c1-evidence` | HEAD not on origin/main |
| `t3-6055117a-7b274847b9f2d8e4` | `myco/foundry-ef005-impl` | HEAD not on origin/main |
| `t3-609cd7b4-bd6c131a53546426` | `feat/m1-011-recovery-ladder` | dirty (6 entries) |
| `t3-61a9b76c-db96bc7265c579f7` | `review/verify-windows-uia` | recent activity (26 min) |
| `t3-63984637-a843d9645c69bbb4` | `fix/viewer-verdict-budget-ci` | HEAD not on origin/main |
| `t3-64056ad7-15b4e8cfa6412082` | `review/reverify-pr-212` | HEAD not on origin/main |
| `t3-681379c6-5cbd96813ea2a6b1` | `tif-211-row7-compare-sync` | recent activity (88 min) |
| `t3-6c40162b-48a1efdab678e610` | `fix/no-ac-gate-scripts-1` | HEAD not on origin/main |
| `t3-717d3cf3-00c632390efaa928` | `myco/m1-021-followup2` | HEAD not on origin/main |
| `t3-71c08d03-59e7094fb1f6cafe` | `pr23` | dirty (1 entries) |
| `t3-7a09dfa3-1186ec597bd15480` | `tif-225-r1` | HEAD not on origin/main |
| `t3-7b2b2696-47327ede30a35b1d` | `docs/verify-eval-runbook` | dirty (1 entries) |
| `t3-7d4d1413-51e7aca904aff85d` | `fix/secret-fixture-scan` | recent activity (26 min) |
| `t3-811232d7-9e1fd964b114913c` | `test/m1-013-reliability-sweep` | dirty (3 entries) |
| `t3-85508672-660b99dfc5140acf` | `deploy-token-out-fix` | recent activity (340 min) |
| `t3-86f206b5-f616b786c40c26fa` | `chore/review-pr-140` | HEAD not on origin/main |
| `t3-8a4713d8-572fa651a7b08bd2` | `test/verify-ac-power-regression` | HEAD not on origin/main |
| `t3-8d0c1de0-2ff6efd26ba1d52b` | `review/verify-pr-163` | HEAD not on origin/main |
| `t3-932a052a-0c6a07977a01ab54` | `feat/hcu-shell-evidence-gate` | dirty (7 entries) |
| `t3-940cf98d-57e39bde96afe320` | `docs/windows-env-control-plane` | recent activity (26 min) |
| `t3-956e99ab-2022209f153cbd1e` | `tif-233-s0-launcher-race` | recent activity (6 min) |
| `t3-9f1c0ac5-a844ca5cb3bfc2af` | `pr11` | 1 non-build ignored entries |
| `t3-a5d29c6c-2f78f9d93fc4ae60` | `review/verify-m1-013-evidence` | recent activity (26 min) |
| `t3-ab474d3b-8d04e84514e999b1` | `feat/windows-uia-adapter` | recent activity (26 min) |
| `t3-ad64d274-116ba7bc4533323a` | `chore/review-pr-153-kill-errors` | HEAD not on origin/main |
| `t3-b03b9420-bf435e53ad4eaa0a` | `review/verify-evidence-schema` | recent activity (26 min) |
| `t3-b07ffe1b-1f088c28aed7c598` | `review/m1-integration-trials` | recent activity (26 min) |
| `t3-b39be09e-8e81f7337ac67b36` | `chore/myco-pr-68-review` | HEAD not on origin/main |
| `t3-b3aee84c-2d357a8ff77997c7` | `review/verify-mid-program-kill` | recent activity (26 min) |
| `t3-b917265e-bc18e476798bfd82` | `review/pr-5-head` | HEAD not on origin/main |
| `t3-c08afad3-3036c7b7562d6e19` | `feat/tif-209-session-info-cli` | recent activity (26 min) |
| `t3-c6b30c43-3a075c18d6c1c990` | `docs/reverify-pr-157` | HEAD not on origin/main |
| `t3-cb15d54d-e7fb7200f0b82513` | `test/m1-013-reliability-sweep-1` | dirty (1 entries) |
| `t3-cf8912db-5eea1a5d186229d7` | `fix/guest-patches-bundled-python` | dirty (6 entries) |
| `t3-d0ed87d8-01e132539267f189` | `feat/viewer-v0` | dirty (20 entries) |
| `t3-d2f9fcd7-313daa2fd04e205f` | `chore/review-instruction-parity` | HEAD not on origin/main |
| `t3-db49a23f-b9d7a5abb320a6c3` | `feat/session-info-cli-1` | HEAD not on origin/main |
| `t3-dd5c7bc8-ff68e20ca17fa3aa` | `chore/review-m1-runtime` | recent activity (26 min) |
| `t3-e19eecc3-7c172c609a7c2599` | `test/m1-016-host-preflight` | HEAD not on origin/main |
| `t3-e1e4f1d7-e317529497ca8390` | `test/battery-row-valid-evidence` | HEAD not on origin/main |
| `t3-e2d27dea-e7e47303ea51ab62` | `feat/viewer-v0-build` | HEAD not on origin/main |
| `t3-e54bfcf5-cf9264ff0156d4b2` | `chore/verify-pr-143` | HEAD not on origin/main |
| `t3-e7592efd-9c4b760b87d37f1d` | `review/pr-11-m1-integration` | recent activity (26 min) |
| `t3-eb287c55-5b767118e6eab8ca` | `chore/review-pr-162` | HEAD not on origin/main |
| `t3-f04fef91-0913b7bd02dfb072` | `docs/research-eval-frameworks` | recent activity (26 min) |
| `t3-f50a2fab-6490a1759459b284` | `review/verify-m1-integration` | recent activity (26 min) |
| `t3-f7357a26-5584799788d641af` | `chore/reverify-pr-241` | HEAD not on origin/main |
| `t3-fefd7a6c-c647e8f207262b6d` | `chore/review-pr-162-1` | HEAD not on origin/main |
| `tif-170-race` | `tif-170-race-test` | dirty (1 entries) |

The 48 worktrees outside the candidate set were not tested: those on a branch with a PR, detached HEADs, the main checkout and the session worktree. The worktree this record was written in (`rulings-wt`) had no PR when the rerun ran, so it was a candidate. It was kept because it showed recent activity. After the removals there are 127 worktrees, including that one.

## 2. Local branches with no PR: 40 deleted

Rule applied: the branch has no PR in any state (checked against all PR head names), it is not checked out in any worktree, and its tip is an ancestor of origin/main. Deleted with `git branch -d` from the main checkout. None of the deleted branches is one of the 27 ambiguous branches from the first pass.

Deleted (tip):

- `chore/review-fault-injection` (ce836036)
- `chore/review-pr-24-values-mode` (45a085f0)
- `chore/review-pr9-verifier` (8648f848)
- `chore/verify-pr-6` (673e24d7)
- `docs/merge-rule-testonly` (6b37d734)
- `docs/tif-ids` (6c0a35c9)
- `feat/baseline-safety-followups` (20adf05d)
- `feat/df005-followups` (43717129)
- `feat/m1-014-supplement-1` (428b6b60)
- `feat/recovery-ladder` (3eacf879)
- `fix/agent-deploy-combined` (a3747b1d)
- `fix/guest-patches-bundled-python-1` (ca06fbf5)
- `fix/m1-runtime-adr-violations` (8bb854d1)
- `fix/shutdown-verify` (96138d3a)
- `fix/tif-164-ssh-connect-timeout` (a5fb548e)
- `fix/verify-main-lint` (fee8bc8a)
- `live/proof-1510` (7963e3a9)
- `myco/runtime-evidence-record` (436ca515)
- `pr-24-review` (45a085f0)
- `pr-27` (fee8bc8a)
- `pr-33` (67c19614)
- `pr10` (15600c08)
- `pr32` (2390c492)
- `review/autocorrect-immune-generator` (5ca8eeae)
- `review/m1-011-recovery-ladder` (0c343697)
- `review/m1-019-cleanup` (4a1b18f4)
- `review/pr-2-foundation` (9f17f0f9)
- `review/pr-32-delta` (9dc4c324)
- `review/pr-4-agent` (ac5e3957)
- `review/pr-5-calc-record` (0f97dbb5)
- `test/baseline-validation-followup` (d27aac4b)
- `test/verify-m1-integration-pr` (ca06fbf5)
- `tif-122-configure-coverage` (ee477a86)
- `tif-140-contract-fix` (af62aea1)
- `tif-182-s0-act-blocker-docs` (876b697c)
- `tif-27-dfs01-prep` (bc1f732a)
- `tif-foundry-ids` (43d8147e)
- `tif-placeholder-ci-tif-check` (b9de1153)
- `tmp-status` (346d10ec)
- `wip-fix-m1` (9ebe245d)

Kept:

- 3 branches deletable once local main is fast-forwarded: `pr359` (`e1c3f297`), `pr383` (`7c68e1a3`) and `pr397` (`02429337`). Their tips are on origin/main, but `git branch -d` refused them as "not fully merged" because the main checkout's local `main` is stale (`7587e899`). They were not force-deleted. By the lead's ruling, the main checkout's `main` stays as it is for now, because that checkout holds someone's uncommitted Nov-22 changes.
- 78 no-PR branches with commits that are not on origin/main.
- 26 branches whose name matches a PR head in some state. Ruling 2 covers only no-PR branches. This includes 25 of the 27 ambiguous branches, which now match a PR head.
- 130 branches checked out in a worktree. This includes the other 2 ambiguous branches.

## 3. Remote branches archived as tags, then deleted

For each branch: pushed the tip to an archive tag, confirmed with `git ls-remote --tags origin` that the tag pointed at the same SHA as the branch tip, and only then ran `git push origin --delete`.

| Branch | Tip SHA | Tag | Tag SHA (ls-remote) |
|---|---|---|---|
| `docs/c1-save-parity` | `96b6852130d650ef6b551ac18f60fb8a5ec5b550` | `archive/docs/c1-save-parity` | `96b6852130d650ef6b551ac18f60fb8a5ec5b550` |
| `pr387-rebased` | `d890bc59d45a4c70efcc0235e3b6bd0dff3910ea` | `archive/pr387-rebased` | `d890bc59d45a4c70efcc0235e3b6bd0dff3910ea` |

## 4. Evidence archive

Archive path: `~/Myco-evidence-archive/2026-11-25/` (outside the repo). Copied with `rsync -a --exclude='*token*' --exclude='node_modules'`. Six of the run dirs are git worktrees, so their working files were copied without `node_modules`. No token file was opened, listed or copied: after the copy, a names-only `find` counted 0 `*token*` entries and 0 `node_modules` in the archive. The `/private/tmp` originals are still in place.

Verification: counts and bytes cover regular files and symlinks, excluding `*token*` and `node_modules` on both sides.

| Source | Src files | Src bytes | Copy files | Copy bytes | Match |
|---|---|---|---|---|---|
| `/private/tmp/row8-op2` | 1183 | 21044662 | 1183 | 21044662 | yes |
| `/private/tmp/row8-op3` | 1235 | 21293033 | 1235 | 21293033 | yes |
| `/private/tmp/row8-op4` | 1251 | 21385605 | 1251 | 21385605 | yes |
| `/private/tmp/row8-step1` | 1561 | 22790237 | 1561 | 22790237 | yes |
| `/private/tmp/row8-step1b` | 1019 | 20534344 | 1019 | 20534344 | yes |
| `/private/tmp/row8-naive` | 1149 | 19904352 | 1149 | 19904352 | yes |
| `/private/tmp/row8-guest-residue` | 53 | 261315 | 53 | 261315 | yes |
| `/private/tmp/row8-operator-report.md` | 1 | 21615 | 1 | 21615 | yes |
| `/private/tmp/row8-operator-report-2.md` | 1 | 50092 | 1 | 50092 | yes |

Archive total: 7,453 files, 127,285,255 bytes.

## 5. Duplicate operator report removed

`cmp /private/tmp/row8-report.md` against `docs/research/experiments/m1-row8/OPERATOR-REPORT.md` at origin/main `bb0209e0` exited 0 (11,583 bytes, identical). The `/private/tmp` copy was then removed.

## 6. Not touched

These were left alone for Tiffany:

- the token files `/private/tmp/row8-token` and `/private/tmp/row8-op2/.row8-token`
- the TIF-206 guard worktree (held for Tiffany)

The token file inside `row8-op2` was excluded from the copy by the `*token*` pattern. The VM and the lock were not touched.
