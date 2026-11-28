# TIF-734: HCU in a trial base (`trial-base-v4`), 2026-11-27

Lead ruling 13:38Z (#734 item 1): bake Microsoft Hybrid Computer Use (HCU) into a new trial base
through the normal `scripts/build-trial-base.sh` path, with egress proof
(`docs/benchmark/hcu-shell-runbook.md` section 1). Everything ran under `scripts/vm-session.sh`
with the VM lock held. No trial, no agent, no model call, $0.

## The HCU build (host, pinned source)

Upstream (github.com/microsoft/Hybrid-Computer-Use, MIT) publishes no Windows release: v1.0.1's
only asset is `computer-use-1.0.1-linux-amd64.tar.gz`. So it was built from source at tag
`v1.0.1`, commit `00eaeebe8ac0d275e46f875bdb5347e5f326faa1`, for the guest's Windows ARM64,
following upstream's `computer-use/native/windows/build.ps1`:

- the provider: `dotnet publish ... -c Release -r win-arm64 --self-contained true -p:Version=1.0.1`
  (.NET SDK 9.0.305 building the project's `net8.0-windows` target);
- the server: `GOOS=windows GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=1.0.1" ./cmd/computer-use` (Go 1.26.3).

`hcu-sha256sums.txt` pins the four files the build installs (the two binaries, upstream's
`LICENSE` and `THIRD_PARTY_NOTICES.md`). The build checks every hash again inside the guest
(`build/10c-hcu-install.log`).

## Feasibility probe on `trial-base-v3` (`probe/probe.log`)

A reset onto `trial-base-v3` (cold), the two binaries copied in over SSH (no egress needed),
`computer-use.exe serve` started in the interactive session with `run-interactive.ps1`, then from
SSH: `daemon status` answered on `C:\Users\myco\AppData\Local\Temp\hcu--1\desktop-default.sock`,
and `computer-use.exe mcp --attach <that socket>` answered `initialize` (computer-use 1.0.1),
listed `AX` and `GUI`, and returned a 640x480 PNG screenshot with `input_emitted: false`.
Nothing was installed persistently; the next reset discarded it. (Two PowerShell one-liners in the
probe, a hash listing and a session listing, failed on `$` quoting; the build uses a `-File`
script instead.)

## Build attempt 1 (`build/`, `build.log`, `progress.log`): stopped at 5b, no snapshot

`MYCO_TRIAL_BASE_NAME=trial-base-v4 MYCO_TRIAL_BASE_HCU_DIR=<pinned build>`, tree 461525c7.

| step | result |
|---|---|
| 1 reset of clean-base | cold: first ssh 160 s, guest CPU 280 s |
| 2 maintenance | signatures, ngen, idle quiet; full scan 2,190 s, 0 detections |
| 3 disable / check | maintenance trigger and Windows Update disabled; Defender real-time on, no exclusions |
| 3b HCU install | all four sha256 matched in the guest; `MycoHCU` logon task registered |
| 5 deny, boot in place | first start fast (guest CPU 4 s), clean shutdown, second start cold (274 s); egress verify ok; all 5 probes denied |
| 5b HCU | `computer-use.exe` pid 5364 in session 1; daemon answered; MCP `initialize` ok, `AX` and `GUI` listed; **the one GUI screenshot failed**: `runtime_error`, "Windows runtime timed out after 838.8614ms" |

The build stopped fail-closed before the snapshot (`build/14c-hcu-mcp-probe.json`). Egress stayed
denied. The diagnosis (`diag-5b-retry.log`): the same screenshot call, repeated twice on the same
running guest, succeeded both times (640x480 PNG). The first GUI call on a freshly booted guest
had timed out while the 176 MB self-contained provider started.

## What followed (lead ruling 15:44Z): resume stopped fail-closed; `build2` built `trial-base-v4`

PR #746 (merged as `915fbba8`, tested at `b70cd4ff`) added the bounded warm-up to 5b (at most
3 MCP sessions, 10 s apart, every attempt recorded, no snapshot without one successful
screenshot) and the resume entry `MYCO_TRIAL_BASE_RESUME_FROM=5b`. The VM lock stayed held so
nothing modified the running guest meanwhile.

### Resume attempt (`resume.log`, `progress.log`, `build/r1-egress-status.log`, `build/r2-identity.log`): stopped at 20:29:31Z

At `20:29:21Z` (tree `b70cd4ff`), `MYCO_TRIAL_BASE_RESUME_FROM=5b` ran on `build/`:
- `build/r1-egress-status.log`: `utm isolate-from-host: true`, `running guest network: ok: user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22`.
- `build/r2-identity.log`: `identity: pid=5364 alive=1 session=1 boot_utc=1795793893`.
- **Fail-closed stop (`rc=1`, `20:29:31Z`)**: `resume: the guest booted after the 5b record (boot_utc 1795793893 >= 1795793694): not the same instance`. `build/14b-hcu-verify.log` had host mtime `1795793694` (`15:34:54Z`) from before `#746` added `boot_utc=` to `verify`, while the guest's `LastBootUpTime` reported `1795793893` (`15:38:13Z`, +199 s ahead of the host mtime). The resume stopped before any egress re-proof or snapshot; follow-up issue #749 tracks `boot_utc` identity and no-write-before-identity fixes.

### Build attempt 2 (`build2/`, `build2.log`, `build2-clock-sync.log`, `progress.log`): `trial-base-v4` built at `22:23:09Z`

With lead go for a full rebuild from `clean-base`, attempt 2 started at `20:31:32Z` on tree `b70cd4ff` and exited `0` at `22:23:09Z` (`MYCO_TRIAL_BASE_NAME=trial-base-v4 MYCO_TRIAL_BASE_HCU_DIR=<pinned build>`).

| step | result |
|---|---|
| 1 reset of `clean-base` (egress open) | attempt 1 fast (`first_ssh_s=15`, guest CPU `4s`), stopped by request; attempt 2 **cold**: `first_ssh_s=183`, guest CPU **`296s`** (`02-reset-open.log`, `boot-classes.log`) |
| 2 clock & maintenance | host/guest clock aligned at `20:36:43Z` (`build2-clock-sync.log`); signatures `1.403.7.0` -> `1.463.499.0` after three `0x80070652` retries (`04-signatures.log`); all 3 `ngen` passes `exit=0` (`05-ngen.log`); `idle` quiet for 3 samples with `0` counted tasks and CPU `1-4%` (`06-idle.log`, only `Multimedia\SystemSoundsService`, `WDI\ResolutionHost`, `Wininet\CacheTask` running); Defender full scan `2226s`, `0` threat detections (`07-defender-full-scan.log`) |
| 3 disable / check | `MaintenanceDisabled=1`, `AU NoAutoUpdate=1`, `wuauserv Disabled` (`08-disable.log`); Defender real-time on, no exclusions (`10-defender-check.log`) |
| 3b HCU install | all 4 sha256 matched in the guest (`computer-use version 1.0.1`); `MycoHCU` logon task registered (`C:\myco\bin\computer-use.exe serve --idle-timeout 8760h`); staging removed (`10c-hcu-install.log`) |
| 4 tidy & shutdown | maintenance script removed, clean shutdown |
| 5 deny & boot in place | `11-egress-deny.log` ok; attempt 1 fast (`first_ssh_s=12`, guest CPU `4s`, `12-boot-in-place.log`), clean shutdown; attempt 2 **cold**: `first_ssh_s=132`, guest CPU **`273s`** (`12b-boot-in-place-2.log`, `boot-classes.log`); `13-egress-verify.log` ok; all 5 TIF-275 probes denied in `14-probe-denied.json` (`tcp_pypi_org_443`: `timeout`, others `SocketException`) |
| 5b HCU verify & MCP warm-up | `computer-use.exe` pid `5348` session `1`, daemon answers from session `0` at `C:\Users\myco\AppData\Local\Temp\hcu--1\desktop-default.sock`, `boot_utc=1795817941` (`14b-hcu-verify.log`); MCP probe attempt 1 failed (`runtime_error`, "Windows runtime timed out after 1.2873441s", `14c-hcu-mcp-probe-attempt-1.json`); **attempt 2 ok**: `AX` and `GUI` listed, 640x480 PNG (`base64Length: 21400`), `input_emitted: false` (`14c-hcu-mcp-probe-attempt-2.json`, `14c-hcu-mcp-probe.json`) |
| 6 snapshot | clean shutdown; `trial-base-v4` created at `2026-11-27 22:23:08 +0000`, `HasState => false`, `Size => 0` (`16-snapshots.txt`, `snapshot-metadata.txt`) |

**Note on `build2/15-egress-status-at-snapshot.log`.** Step 6 of `scripts/build-trial-base.sh` runs `clean_shutdown` first so the snapshot is taken disk-only while the VM is stopped, and then runs `scripts/guest-egress.sh status`. Because the VM is already stopped, `utm isolate-from-host: true` and `utm network config: nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22` pass while `live_check` reports `running guest network: FAIL: expected exactly one running guest, found 0` (identical to `docs/research/experiments/tif-98-trial-base-v3-2026-11-26/attempt-3/15-egress-status-at-snapshot.log`). Live QEMU argv egress and all 5 in-guest deny probes passed immediately before shutdown (`build2/13-egress-verify.log`, `build2/14-probe-denied.json`).

**Snapshot integrity (`snapshot-metadata.txt`).** `trial-base-v4` is disk-only (`HasState => false`, `Size => 0`), and every prior snapshot (`trial-base-v3`, `trial-base-v2`, `cua-c1-base`, `m1-agent-live`, `clean-base-live`, `clean-base`) kept its exact `Created`, `HasState`, and `Size` unchanged.

**Not yet measured.** `trial-base-v4` has no reset bench, oracle parity run, or live trial run yet.
