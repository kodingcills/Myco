# Host requirements for the public-benchmark R1 (OSWorld LibreOffice subset)

> **Nothing here was downloaded, pulled, built or started by this PR.** No VM, container,
> image or paid box was used to write this page (lead hard limit). The fleet numbers and the
> reference-image numbers below were measured or read by the coordinator on the owner's Mac
> and posted on #741; they are quoted exactly, with their source comment. A second VM or any
> paid box needs Tiffany's OK.

Since the lead's **14:05Z ruling** ([#741, comment 7220313158](https://github.com/kodingcills/Myco/pull/741#issuecomment-7220313158))
the R1 host is the **Myco Linux fleet**: lightweight Linux desktops (one container each) that
run OSWorld's own task configs, setup steps, controller server and evaluator at the pin
`0ad41bee56565efe7bb3c3a5ebc67590a1b8276f`, through the `myco-fleet` DesktopEnv provider.
OSWorld's own VM image is **only the parity reference** (15:21Z ruling), never an R1 host.

## 1. The R1 host: the Myco Linux fleet

What runs:
- **One container per desktop**, from `src/benchmark/upstream/fleet/Dockerfile`: Ubuntu 22.04,
  Xvfb at 1920x1080, a session D-Bus, the AT-SPI bus and registry (started before any
  LibreOffice), openbox, LibreOffice Calc, Writer and Impress with the GTK3 VCL plugin,
  PyAutoGUI 0.9.54 and python3-xlib 0.15 (hash-pinned), and OSWorld's own
  `desktop_env/server` at the pin, byte-verified and run unmodified on guest port 5000.
  A fresh container per task is the reset (no snapshots). Ports are published on 127.0.0.1 only.
- **On the host:** OSWorld's standard Claude runner (`scripts/python/run_multienv_claude.py`)
  with the documented patches (gate hook, `myco-fleet` provider choice, provider registration),
  OSWorld's host-side Python requirements at the pin, the docker CLI, and
  `src/benchmark/upstream/fleet` on `PYTHONPATH`. `MYCO_FLEET_IMAGE` names the image by digest
  (`name@sha256:...`); the provider refuses anything else.
- **The `myco-gate` MCP server**, for arm (b) only (a Node process, started once per DONE check).

**Runner quirk.** The pinned Claude runner always imports `desktop_env.providers.aws.manager`
to look up an AMI id, even when the provider is not AWS. So the host needs `boto3` installed,
but not AWS credentials.

### Measured so far (probe image, not yet the R1 image)

Coordinator, measured 2026-11-27 on the owner's Mac inside the existing colima VM (2 CPU /
4 GiB), [#741 comment 7220806056](https://github.com/kodingcills/Myco/pull/741#issuecomment-7220806056)
(files: `docs/research/experiments/fleet-first-numbers-2026-11-27/`). The desktop was the #744
**probe** image (debian:bookworm-slim, Xvfb, a minimal WM, LibreOffice Calc with the X11
plugin, python3, flask, uno), **not yet OSWorld's controller**. Nothing projected.

| metric | fleet (probe) | Windows trial VM |
|---|---|---|
| RAM per desktop, Calc idle with a CSV open | 87 MiB (`docker stats`), 88 MiB (cgroup) | 6 GiB pinned |
| Cold start to Calc window open | median 0.59 s, max 0.70 s (0.88 s from `docker run`) | n/a |
| Cold start to Calc painted | median 1.09 s, max 1.21 s | n/a |
| Reset per trial | the cold start (a fresh container) | 134–152 s quiet, 180–280 s planned, plus ~100 s redeploy |
| Max concurrent desktops | **28**, with no failures (stopped by a 400 MiB free floor in colima; host memory guard never tripped) | **1** |
| Image size | 1.18 GB on disk | n/a |

Ladder (K, time to all-ready, total RAM): 1: 0.91 s, 87 MiB · 4: 0.99 s, 344 · 8: 1.03 s, 686 ·
12: 1.39 s, 1034 · 16: 2.77 s, 1380 · 20: 2.31 s, 1726 · 24: 2.25 s, 2074 · 28: 2.44 s, 2469 MiB.
Unrelated containers held about 535 MiB of colima throughout.

The probe had two gaps for OSWorld's controller: no accessibility tree (the X11 VCL plugin has
no AT-SPI bridge) and no pyautogui/python-xlib. The R1 image closes both (14:37Z ruling), which
raises RAM per desktop, and the probe numbers were idle only. **They must be re-measured on
the R1 image, idle and actively driven, before any public claim.**

### Re-measuring (the coordinator runs this locally; this PR cannot)

`src/benchmark/upstream/fleet/measure.sh` extends the #744 script to the R1 image:

```sh
export HOST_LABEL="Apple M4 Pro 24 GiB; colima default 2 CPU / 4 GiB"   # required
export IMAGE=myco-osworld-desktop:local OUT_DIR=$PWD/fleet-measure-out
bash src/benchmark/upstream/fleet/measure.sh build        # image size and id
bash src/benchmark/upstream/fleet/measure.sh cold 5       # cold start and RAM per desktop
bash src/benchmark/upstream/fleet/measure.sh scale        # max concurrency, idle and driven
bash src/benchmark/upstream/fleet/measure.sh active 4     # 4 desktops driven at once
```

- **Cold start:** `docker run` → the controller answers `/screenshot` → `/accessibility`
  returns an AT-SPI desktop tree → Calc, launched through the controller's `/setup/launch`, is
  visible in that tree. Then RAM per desktop with Calc open (`docker stats`, cgroup).
- **Max concurrency:** parallel steps 1, 2, 4, 6, 8, 10, 12, 16, 20, 24, each behind the
  **host memory guard**: stop before a step when host swap free is under 300 MB, host free
  memory is under 20%, or the step would add more than ~1 GiB; and keep the docker VM out of
  OOM (400 MiB floor).
- **Actively driven** (14:37Z): at each step (and in `active K`), every desktop runs scripted
  pyautogui rounds through the controller's `/execute` (click, type a value and a formula,
  undo) for `DRIVE_S` seconds, no model. It records rounds ok/failed, p50/p95 latency and RAM
  while driven.
- Every line of `raw.jsonl` carries the host label, the host OS and arch, and the docker VM's
  CPUs and memory. Only containers named `myco-fleet-measure-*` are created or removed.

## 2. The parity reference run (not run; waits for Tiffany's OK)

The parity check ([`r1-parity-sample.json`](r1-parity-sample.json); "parity must pass before
any live run") scores five pre-declared tasks' scripted known-good and known-bad sequences
with upstream `DesktopEnv.evaluate()` on the fleet and on OSWorld's reference environment.

**Reference environment (15:21Z ruling, [#741 comment 7221935698](https://github.com/kodingcills/Myco/pull/741#issuecomment-7221935698)):**
OSWorld's own guest image `Ubuntu-arm.zip`, its in-guest controller and OSWorld's evaluator,
unchanged, booted in **UTM (QEMU with HVF)**. **Stated deviation** from OSWorld's VMware
reference: only the hypervisor differs. UTM is $0, needs no account and is already installed.
Never VMware Fusion: its download needs a Broadcom account, which breaks the "$0, no
accounts" condition.

**The image, exactly** (coordinator, from OSWorld's own sources, nothing downloaded;
[#741 comment 7221627161](https://github.com/kodingcills/Myco/pull/741#issuecomment-7221627161)):

| item | value | source |
|---|---|---|
| Image a Mac gets | `Ubuntu-arm.zip`, `huggingface.co/datasets/xlangai/ubuntu_osworld/resolve/main/Ubuntu-arm.zip` | `desktop_env/providers/vmware/manager.py:27,35` @ `0ad41bee` |
| Download | **12,287,865,453 bytes (12.29 GB)** | HF dataset tree API |
| On disk after unzip | **25,215,685,544 bytes (25.2 GB)**: 27 files, a split `Virtual Disk*.vmdk` | the zip's central directory, read over HTTP range requests |
| Guest config (`Ubuntu.vmx`) | `memsize = 4096` (4 GiB RAM), `numvcpus = 2`, EFI, `guestOS = arm-ubuntu-64`, NVMe disk | inside the zip |
| Peak disk, OSWorld's download-then-unzip path | 12.29 + 25.2 = **about 37.5 GB** | |
| Docker provider image (not used) | `Ubuntu.qcow2.zip`, 12.27 GB (x86_64); defaults `RAM_SIZE 4G`, `CPU_CORES 4`, `DISK_SIZE 32G`; needs `/dev/kvm` for speed | `desktop_env/providers/docker/provider.py:57`, `:134-141` |

The Docker provider would mean x86 emulation without KVM on this Apple-silicon Mac, so it is
not viable for parity.

**Host check, read-only (Apple M4 Pro, 24 GB RAM, 14 CPU), from the same comment:**
- **Disk:** about **30 GB free** on the system volume. Neither path fits: the standard path
  needs about 37.5 GB; streaming the vmdk straight out of the remote zip needs 25.2 GB and
  would leave about 5 GB, too little alongside the Windows VM work.
- **RAM:** 4 GiB for the guest fits on its own (system-wide free memory 52%, swap free
  1.4 GB). It cannot run at the same time as the Windows VM (6 GiB) or a fleet measurement.

**Exact host requirement for the reference run:**
1. **At least about 40 GB free** on the volume that holds the VM (25.2 GB image plus working
   margin, or 37.5 GB for OSWorld's standard unzip), from freeing space on the system volume
   or from an external disk. Nothing downloads until Tiffany answers this disk question.
2. **4 GiB guest RAM, 2 vCPU**, and **one heavy VM at a time** under the VM lock: not alongside
   the Windows VM or a fleet measurement.
3. **$0 and no accounts:** UTM, already installed. No paid box.
4. **Operator steps (by hand, after the OK):** unzip `Ubuntu-arm.zip`; import the split vmdk
   into a new UTM VM (QEMU backend, HVF) with 4 GiB and 2 vCPU; set UTM's emulated-VLAN port
   forwards from 127.0.0.1 to the guest's ports 5000, 9222, 8006 and 8080; then run
   `osworld_parity.py --env reference --reference-approved <the approving comment URL>` with
   `MYCO_REFERENCE_VM` (the UTM VM name) and `MYCO_REFERENCE_ENDPOINT`
   (`127.0.0.1:<server>:<chromium>:<vnc>:<vlc>`). The `utm-reference` provider starts the VM
   with `utmctl start --disposable`, so each task begins from the clean image.

If a task does not match, it is a stated gap: the fleet does not count for that capability
until the gap is closed or the lead rules on it.

## 3. Network and egress (both environments)

- **Model API:** the runner calls the Anthropic API (or Bedrock or Vertex) through
  `mm_agents/anthropic/utils.py`, so it needs an API key or cloud credentials. This conflicts
  with M2's $0-API rule (Claude Ultra plan) and is the pending ruling `model-access`. Under
  the secret rules, any key is loaded from a file at the point of use and never passed in
  argv or the environment of a Myco process. The parity harness uses no model.
- **Fleet image build:** `github.com` (OSWorld at the pin, for the controller server), the
  Ubuntu apt archive and PyPI (hash-pinned). The reference image needs `huggingface.co`
  (12.29 GB), only after the OK.
- **Task assets:** each task's own setup step downloads its seed files from
  `huggingface.co/datasets/xlangai/ubuntu_osworld_file_cache` (OSWorld's SetupController does
  this on the host and uploads them through the controller). The gold files come from the same
  place, through the `cloud_file` getter. This is gated on the pending ruling `asset-license`.
- **Inbound:** only 127.0.0.1 ports. Nothing is exposed publicly.

## 4. Sizing for the R1

- **Total trials:** 117 tasks × 3 arms = 351 trials at n = 117 with one trial per arm.
  `--num_envs` sets how many desktops run in parallel; the re-measured max concurrency under
  the guard bounds it.
- **The runner:** `run_single_example` waits a fixed 60 s after each reset and 20 s before
  `evaluate()`, so each task costs at least 80 s of wall clock on top of its agent steps,
  whatever the host.
- **WAA (phase 2)** stays on the Windows VM path; it is not part of this host.
