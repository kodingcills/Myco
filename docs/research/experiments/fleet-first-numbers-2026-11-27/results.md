# Fleet first numbers: lightweight Linux desktops (LibreOffice Calc under Xvfb)

**Measured 2026-11-27 ~14:05–14:35Z on the owner's Mac (Apple M4 Pro, 14 CPU,
24 GiB = 25769803776 bytes per `sysctl hw.memsize hw.ncpu`) inside the colima
profile `default` (aarch64, docker runtime, 2 CPU / 4 GiB / 20 GiB disk per
`colima list`; `docker info` MemTotal 4095639552).** Nothing here was measured
on a bigger allocation, and no number below projects one.

Resident in the same colima VM throughout: four unrelated `asobeast-*` containers
(~535 MiB per `docker stats` at start). So the fleet had ~3.0 GiB of the 4 GiB, not all of it.

Files: `Dockerfile`, `start.sh` (container entrypoint), `measure.sh`
(re-runnable: `build | cold N | paint N | scale | probes | cleanup`), `raw.jsonl`
(269+ lines, one per measurement, each tagged with `run`), `screenshot-calc.png`
(a painted desktop from the probe image).

## What a "desktop" is

`debian:bookworm-slim` + Xvfb (1280x800x24, `-noreset`) + openbox + LibreOffice
Calc 7.4 (`libreoffice-calc`, real X display, not `--headless`) + python3,
python3-flask 2.2.2, python3-uno, python3-pyatspi, xdotool, wmctrl, ImageMagick,
x11-apps. Each container seeds a 4-row CSV and opens it in Calc. Per-container
`--memory=1g --shm-size=256m`. OSWorld itself was **not** fetched.

## Results

Run `v2-noreset` (the final image) unless stated otherwise. Cold runs: n=5, fresh container each time.

| metric | fleet value (colima 2 CPU / 4 GiB) | Windows VM value | source / method |
|---|---|---|---|
| Image size | **1.18 GB** on disk (301 MB content; `.Size` 300,795,448 B) | n/a (VM disk image, not compared) | `docker image ls` / `docker image inspect`; `raw.jsonl` phase `build` |
| Configured RAM / CPU | 1 GiB cap per desktop (not reached), shares colima's 2 CPU | **6 GiB (6144 MB) / 6 vCPU** (8 GB until 2026-11-21) | Windows: `docs/eval-runbook.md:36`, `docs/coordination/m1-state.md:1198`, `:1218`, `:405` |
| Cold start → X server accepts | median **0.10 s**, max 0.10 s (VM clock); host-observed median 0.49 s, max 0.50 s (bounded by the first `docker exec` poll) | n/a | `start.sh` writes `/tmp/x_ready` after `xdpyinfo` succeeds; VM clock = container `StartedAt` → marker |
| Cold start → Calc window with seed.csv mapped | median **0.59 s**, max 0.70 s (VM clock); host-observed from `docker run` median **0.88 s**, max **0.97 s** | — | `wmctrl -l` sees `seed.csv - LibreOffice Calc`; host polls via `docker exec` every 0.25 s |
| Cold start → Calc **painted** (toolbars and cells rendered) | median **1.09 s**, max **1.21 s** (poll step ~0.5 s) | — | in-container screenshot loop: `import -window root`, more than 500 distinct colours below the title bar (an all-black frame has 1) |
| Cold reset / boot (per trial) | the cold start above (a fresh container is the reset) | **134–152 s** quiet (143/134/145/152/139 over 5 runs); **279 s end to end (234 s to SSH)** under load ~9.7; planning range **180–280 s**; c1-arm-002 scored-row `resetMs` median **182.8 s** (22.2–235.1 s) | `docs/coordination/m1-state.md:831-839` (5-run table), `docs/eval-runbook.md:245-248`, `docs/research/experiments/c1-arm-002/FINAL.md:70-71`; script header single sample ~165 s, warm ~21 s at `scripts/reset-trial-vm.sh:12` |
| Other per-trial overhead | none measured beyond the start (no agent deploy step exists yet in this image) | **redeploy ~100 s** per trial (clean-base predates the agent; `DEPLOY OK` every trial); DEPLOY OK 20 s once after the 6 GB change | `docs/baseline/screenshot-agent.md:573-575`; `docs/coordination/m1-state.md:1198` |
| RAM per desktop, 1 desktop, Calc idle with document open | median **87.1 MiB** (`docker stats`), **88.3 MiB** (cgroup `memory.current`); range 86.7–87.2 / 87.9–88.4 | 6 GiB pinned (`MemoryLock = true`) | `docker stats --no-stream` and `/sys/fs/cgroup/memory.current`, 10 s after Calc up; Windows: `docs/coordination/m1-state.md:405` |
| Max concurrent desktops | **K = 28**, all Calc-up, 0 failures | **1** (a second 6 GiB guest does not fit) | fleet: scale table below; Windows: `docs/coordination/m1-state.md:405-407`, `docs/coordination/vm-queue.md:56` |
| colima VM memory at the K=28 peak | `free -m`: total 3906, used 3147, free 191, buff/cache 568, **available 553 MiB**; swap 0 (none configured); pswpin/pswpout 0, oom_kill 0; loadavg 0.30 | — | `docker run --rm alpine:3 free -m`, `/proc/vmstat`, `/proc/loadavg` |
| Host memory at the K=28 peak | swap free 1409.62 MiB of 3072; system-wide free 46% | — | `sysctl vm.swapusage`, `memory_pressure -Q` |
| Idle CPU at K=28 | 0.75% total across 28 desktops | — | `docker stats` CPU% sum |

### Concurrency ladder (incremental: keep the running desktops, start the new batch in parallel)

Run `v2-noreset`. "Batch wall" = slowest new desktop in that step from `docker run` to Calc window mapped (host-observed).

| K | new in step | batch wall to all-ready | failures | avg MiB / desktop (stats) | total MiB (stats) | total MiB (cgroup) | colima MemAvailable after (MiB) |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 0.91 s | 0 | 86.8 | 86.8 | 88.0 | 2964 |
| 2 | 1 | 0.88 s | 0 | 86.8 | 173.7 | 175.9 | 2889 |
| 4 | 2 | 0.99 s | 0 | 86.1 | 344.3 | 349.1 | 2708 |
| 6 | 2 | 1.03 s | 0 | 85.8 | 515.0 | 521.8 | 2543 |
| 8 | 2 | 1.03 s | 0 | 85.7 | 685.9 | 695.2 | 2347 |
| 10 | 2 | 1.04 s | 0 | 85.6 | 856.4 | 867.9 | 2167 |
| 12 | 2 | 1.39 s | 0 | 86.1 | 1033.5 | 1041.9 | 2027 |
| 16 | 4 | 2.77 s | 0 | 86.2 | 1379.7 | 1393.7 | 1642 |
| 20 | 4 | 2.31 s | 0 | 86.3 | 1726.1 | 1745.8 | 1281 |
| 24 | 4 | 2.25 s | 0 | 86.4 | 2073.6 | 2105.9 | 916 |
| 28 | 4 | 2.44 s | 0 | 88.2 | 2469.3 | 2516.7 | 536 |
| 32 | — | not run | — | — | — | — | — |

**Why it stopped at 28:** before K=32 the guard projected the next 4 desktops at ~408 MiB.
537 MiB available minus 408 would breach my 400 MiB floor for colima's VM (it has no swap,
so the next failure mode would be the OOM killer). **The host memory guard was not the
trigger.** Before every step the host showed swap free ≥ 1097 MiB (floor 300) and free
memory ≥ 45% (floor 20%), and no step added more than ~408 MiB (limit ~1 GiB). See
`raw.jsonl` phase `guard`.

## Failures and fixes (kept, not excluded)

- **Run `v1-xvfb-reset`, K=10: 1 of 10 desktops failed to reach "Calc up" within 120 s.**
  Root cause, from that container: openbox logged `Failed to open the display`. Without
  `-noreset`, Xvfb restarts the server when its last client disconnects, and here that
  client was the `xdpyinfo` readiness probe. openbox connected during the restart and
  died. Calc **did** open `seed.csv` (`xwininfo` shows the window), but with no WM
  `wmctrl` cannot list windows, so the readiness check never fired. This is a harness
  bug, not a LibreOffice limit. Fix: `Xvfb -noreset` plus an openbox retry loop. All v1
  lines stay in `raw.jsonl`, and v1 cold and memory numbers agree with v2 within ~3 MiB
  and ~0.1 s.
- The first "Calc up" criterion (window mapped) fires **before Calc paints**. A
  screenshot taken at that moment shows the titled frame with a black body. So I
  added the stricter `calc_painted_invm` milestone. The first draft of it used "mean
  brightness > 0.5", which a blank white window would also pass. That criterion was
  superseded by the >500 colours check and its lines are tagged
  `v2-paint-criterion-mean-superseded`.

## Gaps for OSWorld's controller (desktop_env/server)

| capability | status in this image | evidence |
|---|---|---|
| Screenshot | **works**: `import -window root` gives a PNG (1280x800); `xwd -root` works too | `raw.jsonl` `screenshot_import`, `screenshot_xwd` = 1; `screenshot-calc.png` |
| Window find | **works**: `xdotool search --name seed` → `seed.csv - LibreOffice Calc`; `wmctrl -l` works once openbox is up | `xdotool_find` = 1 |
| Flask / UNO import | **works**: flask 2.2.2, `import uno` | `flask_import`, `uno_import` = 1 |
| **Accessibility tree (AT-SPI)** | **does not work.** `import pyatspi` succeeds, but with `dbus-launch` plus `at-spi-bus-launcher`, `Registry.getDesktop(0).childCount` = **0**. The only VCL plugin installed is `libvclplug_genlo.so` (plain X11), which has no ATK bridge. | `atspi_desktop_apps` = 0, `vcl_plugins` |
| **pyautogui input** | **missing**: `pyautogui` and `python-xlib` not installed (`ModuleNotFoundError`). `xdotool` input exists but was not exercised for typing. | `pyautogui_import`, `python_xlib_import` = 0 |

Likely fix (**not built or measured**): add `libreoffice-gtk3`, start a session D-Bus and
the AT-SPI bus *before* soffice with `SAL_USE_VCLPLUGIN=gtk3` (plus
`GTK_MODULES=gail:atk-bridge` if needed), and pip-install pyautogui with python3-xlib and
scrot or Pillow. Each of these grows the image and **per-desktop RAM**; the 87 MiB figure
is for the gen plugin with no a11y bus and no controller process running. Re-measure
before using 28 for planning.

## Caveats

- Every cold start ran with the image layers already in the VM page cache (the image was just built). The first start after a colima restart was not measured.
- The seed is a 4-row CSV. OSWorld tasks open real .xlsx files, which use more RAM.
- Idle only: no desktop was driven while measuring, so CPU contention under load on 2 CPUs is unmeasured. Idle CPU is near zero (0.75% for all 28).
- The host-observed X-ready time is bounded by the latency of the first `docker exec`. Use the VM-clock column.

## What a bigger colima allocation would need (not measured)

At the measured ~86–88 MiB per idle gen-plugin desktop (plus whatever a11y and the
controller add, which is unknown), memory rather than CPU set the ceiling here at idle.
Any K for a larger VM is arithmetic, not a measurement: re-run `measure.sh scale` on that
allocation, with the a11y-enabled image, while desktops do real work.
