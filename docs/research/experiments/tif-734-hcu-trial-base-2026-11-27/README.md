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

## What follows (lead ruling 15:44Z)

The patch adds a bounded warm-up to 5b (at most 3 MCP sessions, 10 s apart, every attempt
recorded, no snapshot without one successful screenshot) and a resume entry,
`MYCO_TRIAL_BASE_RESUME_FROM=5b`. The resume refuses unless this is the same running guest
(14b's `computer-use.exe` pid still alive in an interactive session, and Windows booted before
that record) with egress still denied, and then re-proves egress (verify and the probes) and HCU
(both tools listed and one screenshot) immediately before the clean shutdown and the snapshot.
The VM lock has been held since 15:43:34Z so that nothing resets or restores the guest
meanwhile. The resume runs only after the patch's verifier round passes.
