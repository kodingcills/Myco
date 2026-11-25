# Row 8 plan step 1: cold-operator runs on the fixed runbook (2026-11-25)

This pack is the evidence for plan step 1 of the row-8 reproducibility test plan
(`docs/m1-scorecard.md`): a cold operator, on a fresh clone of main with only the runbook,
re-runs §4, §5 and a §6 subset, and needs no ruling on any question the repo could have
answered. Plan step 8 is held separately by `scripts/scorecard-check.py` (#434, TIF-225).

| File | What it is |
|---|---|
| `operator-report-3.md` | First cold run, fresh clone at `5a00c578` (#433), 07:59–08:15Z |
| `operator-report-4.md` | Bounded re-run, fresh clone at `6ad605ff` (#436), 08:53–09:04Z |

Both reports are copied byte for byte from the operators' host reports
(`/private/tmp/row8-operator-report-{3,4}.md`) and are read-only.

**Secret scan before commit, by counts only.** No `sk-ant` string, no `BEGIN … PRIVATE`
block, no 48-hex agent token, no 32-hex or dashed session GUID, and no key-file contents.
The only long hex strings are the two clone HEADs, which are git commit ids. The guest
`session_id` in each deploy ping line was already `[REDACTED]` in the operators' own
reports. Nothing else needed redacting. The reports name token *paths*, such as
`runs/token-<user>/agent-token`, but no token values.

## What each run did

**Report 3: first cold run (runbook at #433).**

- Passed: §1 preconditions and setup (four green commands), §2 sanity, §3.1 reset (174 s)
  and §4 deploy (153 s, `verified 13 files on the guest`, `DEPLOY OK`).
- Passed §8 on copies of the committed packs: `validate-live` gave 29 + 516 and 18 + 321
  with `--expect`, the corrupted-suite `--final` replay was byte-identical, and the sweep2
  scorecard gave 28/30.
- §5 and §6 were **blocked** at the token fetch. The harness refused the runbook's
  `vssh … Get-Content agent.token` step (H5), so §5 exited 3 and §6 exited 1, both with
  `AUTH_FAILED`.
- No scorecard check existed on main yet.

**Report 4: bounded re-run (runbook at #436, after the #435 and #436 fixes).**

| Step | Result | Wall |
|---|---|---|
| §3.1 cold reset | `reset-trial-vm: ready on 'clean-base'`, exit 0 | 185 s |
| §4 deploy | `verified 13 files on the guest against the source (sha256)`, `DEPLOY OK`, exit 0; token written to a private host file | 140 s |
| §5 desktop proof | `{"session_id":1,"window_station":"WinSta0","desktop":"Default",…}`, exit 0 | 5 s |
| §6.1 clean check | no output (clean guest) | 13 s |
| §6 subset `--limit 4` | 4/4 `"status": "verified"`, exit 0 | 182 s |
| `scripts/scorecard-check.py` | `120 ok, 0 mismatch, 0 unattributed, 40 not machine-checked, 9 artifact-consistency, 1 skipped, 16 sections swept clean, 49 identifier words skipped; 2 sections out of scope`, exit 0 | <1 s |

A 4-row subset is evidence for those four sets only. It does not replace the 20/20 §6 record
(runbook §6: "Row 8's bounded re-check may use such a subset").

**Not re-run, by ruling:** §7.3 (sweep) and §7.4 (corrupted suite). Their fresh-operator
evidence is `../m1-row8-sweep2/` (28/30) and `../m1-row8-corrupt/` (18/18, 0 false successes).

## Findings and disposition

| Findings | Run | Disposition |
|---|---|---|
| H5: token fetch refused, which blocked §5 and §6 | 3 | Fixed by #436 (TIF-228): the deploy leaves the fresh token in a host file and drops the guest fetch |
| H1–H4, H6–H13: runbook contradictions and gaps | 3 | Fixed by #435 (TIF-227) |
| J10: row 8 still carried the stale `validate-live … ALL OK on 0 files (TIF-223)` gap, which #433 had fixed | 4 | Removed from row 8 in the PR that adds this pack. `scorecard-check.py` now fails if the row says it again |
| J1–J9, J11: runbook gaps the operator decided from the repo without a ruling (pnpm build-script warning, §1.2 scope, shared-Mac token path, guard vs `MYCO_TOKEN_OUT`, OpenSSH warnings, missing pip output, §6 runs-dir, no scorecard-check entry, "same shell", post-run cleanup) | 4 | A separate Tier-0 runbook PR |

The report-4 operator states that only J10 needed a ruling. The lead confirms that
disposition before row 8's DONE is merged.
