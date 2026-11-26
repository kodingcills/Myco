# TIF-98: default trial snapshot switched to trial-base-v2, proof reset 2026-11-26

One reset through the new default path. No agent, no trial, no model call, $0.

Started at 15:52:30Z (`started.txt`). It ran under `scripts/vm-session.sh` with the VM lock
held, with `MYCO_TRIAL_SNAPSHOT` unset (`env -u`), and from this branch's checkout:

| step | command | result | file |
|---|---|---|---|
| 1 | `scripts/reset-trial-vm.sh` (no argument) | `ready on 'trial-base-v2'`; first ssh after 132 s, total 151 s; its TIF-275 egress check passed | `01-default-reset.log` |
| 2 | `scripts/guest-egress.sh verify` | `egress closed … UTM config matches` | `02-egress-verify.log` |
| 3 | `scripts/guest-egress.sh probe` | all 5 targets failed (`SocketException`) | `03-probe.json` |
| 4 | boot probe: `vssh 'echo boot-probe-ok'` | `boot-probe-ok` | `04-boot-probe.txt` |
| 5 | `vm.sh stop`, by request | VM stopped, lock released | — |

The snapshot list was the same before and after:
`trial-base-v2, cua-c1-base, m1-agent-live, clean-base-live, clean-base`. No snapshot was taken
or changed.

The 151 s total falls within the trial-base-v2 range from the same-session bench
(140–163 s, `../tif-98-trial-base-v2-2026-11-26-run3/`).
