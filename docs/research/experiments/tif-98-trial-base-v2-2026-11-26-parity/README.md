# TIF-98: oracle parity, clean-base vs trial-base-v2, 2026-11-26 (PASS)

Lead GO at 06:57Z. Run 06:57Z-07:17Z at branch head `d6b4ffba`. Not paid: `run-live.ts` drives a
scripted Calc program, and no model is called.

## How it ran

All of it ran in one `scripts/vm-session.sh` session (the VM lock was held throughout):

1. `scripts/base-parity.sh <out> clean-base trial-base-v2`. For each base it did a reset
   (`reset-trial-vm.sh`, which refuses a guest unless egress is closed), a deploy (hash
   verified), `session_info`, 3 normal M1 Calc trials (seeds `m1-013-trial-01..03`), and one
   corrupted control (`--mode kill --kill-after-step 3`, seed `m1-013-trial-01`).
2. `scripts/base-parity-compare.py <out> clean-base trial-base-v2`. Output: `compare.md`.
3. A closing `reset-trial-vm.sh clean-base`, so that no agent token stays in a running guest.
   Then `guest-egress.sh verify`, then a clean stop.

The deploy token went where normal trials put it: the deploy wrote it to the host file named by
`MYCO_TOKEN_OUT`, and `run-live.ts`/`session-info.ts` read it from that path (`--token-file`).
It was never printed. **No snapshot was taken or changed in this step.** The snapshot list is
unchanged: `trial-base-v2, cua-c1-base, m1-agent-live, clean-base-live, clean-base`.

## Result

| trial | clean-base | trial-base-v2 | oracle view identical |
|---|---|---|---|
| normal-m1-013-trial-01 | verified | verified | yes |
| normal-m1-013-trial-02 | verified | verified | yes |
| normal-m1-013-trial-03 | verified | verified | yes |
| kill-m1-013-trial-01 (corrupted control) | uncertain | uncertain | yes |

`parity: PASS (4 trials)`; the compare exited 0.

- On both bases, the normal trials verified the same cells with the same persisted values.
  They were B39, B92 and B47 (records EMP-0038, EMP-0091 and EMP-0046).
- The corrupted control was not verified on either base. Both read `uncertain`: "UNO readback
  of B39 failed ... NoConnectException ... Connection refused", identical on both. The report
  has no `corruption.applied` field for this mode.
- `session_info` was identical on both bases: session 1, `WinSta0`, `Default`.
- Each deploy reported `verified 14 files on the guest against the source (sha256)`, then
  `ping verified`, then `DEPLOY OK`.

Resets in this run, from the `timing` line:

- `clean-base`: total 224 s.
- `trial-base-v2`: total 167 s.
- Closing `clean-base` reset: total 226 s, then `egress closed ... UTM config matches`.

## Files

- `compare.md`, `driver.log`, `post-reset.log`, `post-verify.log`.
- `<base>/reset.log`, `<base>/session-info.json`.
- `<base>/{normal,kill}-*.json`: the trial reports. `.err` holds each trial's stderr.
- `<base>/runs/*/{result.json,trace.jsonl}`.
- `<base>/deploy-summary.txt`: only the deploy's verification lines.

The full deploy logs are **not** committed: they name the host token file. Before commit,
every committed file was checked for home paths and token strings (names-only: zero hits), and
gitleaks was run.
