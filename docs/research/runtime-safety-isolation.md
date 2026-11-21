# Safety and isolation posture of the Myco desktop runtime

Status: research, 2026-11-21. Reframe input: TIF-56 asks whether an arbitrary agent
can obtain and operate a *safe isolated* desktop. This document states what the
current runtime actually guarantees, with evidence, and what it does not. It
deliberately separates measured facts from inference.

Scope: the Linux ARM64 QEMU+HVF backend as merged (RT-001..RT-010). Not a threat
model for multi-tenant hosting, and not a claim of parity with any container or
cloud sandbox.

## 1. What the isolation actually is

The desktop is a **whole virtual machine**, not a container sharing the host kernel:

- QEMU with `-accel hvf`, `-machine virt`, a qcow2 overlay on a pristine base image
  (`runtime/guest/boot.sh`). Guest runs Ubuntu 24.04 ARM64.
- Guest resources are fixed at creation: `-smp 2 -m 2048` (`boot.sh`), so a runaway
  guest cannot take host memory beyond its allocation.
- Networking is QEMU user-mode (`-netdev user,hostfwd=tcp:127.0.0.1:10022-:22`):
  the guest cannot open inbound ports on the host; the only host surface is a
  forwarded SSH port bound to loopback.
- The base image is never written: all guest state is in a disposable overlay, so
  `destroy` deletes writes rather than rolling them back.

Why this matters for the reframe: the isolation boundary is the hardware
virtualization boundary, not a process boundary. An agent that runs arbitrary code
inside the desktop (installing packages, killing processes, corrupting files)
is not touching the Mac. That is the property TIF-56 is asking about, and it comes
from choosing a VM as the unit rather than from anything the runtime implements.

## 2. What the runtime does NOT yet guarantee

Recorded plainly because "safe" is a claim that must survive an adversarial reader.

| Gap | Evidence | Consequence |
|---|---|---|
| **No authentication of the control channel beyond a static token** | `MYCO_RT_TOKEN` on the ssh command line, visible in the guest's `ps` for the agent's lifetime (ADR-0015, accepted) | Any process in the guest that can read `ps` can drive the desktop. Inside a disposable single-tenant guest this is contained; it is not a multi-tenant credential. |
| **No resource quotas beyond memory/CPU at boot** | `-m 2048 -smp 2` only | A guest can fill its own disk (20 GB virtual) and spin CPU to its 2 vCPUs, degrading *itself* and, at 2 vCPUs, competing with host work. This is exactly the contention M1 measured — the runtime bounds memory but does not yield CPU. |
| **No network egress policy** | user-mode networking, no filtering | The guest can reach the internet. An agent inside can exfiltrate, or fetch anything, subject to the host's network. Not currently restricted. |
| **No filesystem hand-off surface** | none exists | There is no supported way to move a file in or out except guest-side commands. "Arbitrary agent obtains a desktop" is currently thinner than "agent does work and returns artifacts" (`evidence` returns paths in the *host's* runs dir, not guest files). |
| **No audit trail of who acted** | `evidence` records observations/actions, no principal | Fine for one agent, one desktop. Blocks any per-agent attribution claim. |
| **Idle shutdown is a convention, not enforcement** | RT-013 still pending; this workstream left a guest running for 1h45m and degraded M1's sweep | The runtime does not reap its own VMs. A host-bound guarantee that "no desktop outlives its user" does not exist yet. |

## 3. The ease barrier, which is the actual question

TIF-56 asks about *ease for an arbitrary agent*, not more capability. The measured
path today, from a clean checkout:

1. Install QEMU (`brew install qemu`), Rust, and a ~600 MB ARM64 cloud image; the
   image is fetched and SHA-256-verified by `runtime/guest/fetch-image.sh`.
2. Build the workspace and cross/native-build the in-guest agent
   (`build-agent-in-guest.sh` needs rustup *inside* the guest on first use).
3. `create` boots, waits for cloud-init (minutes on a fresh overlay), installs the
   agent, opens the control channel, then waits for the desktop to become observable.
4. Only then do `observe`/`act` do anything.

Steps 1–2 are operator work an arbitrary agent cannot skip: there is no single
command that goes from "nothing installed" to "I have a desktop". That is the gap
TIF-56 names, and it is a *packaging* gap, not a missing-operation gap — the six
ops already exist and are MCP-callable.

## 4. What this implies for the first proof

The proof should demonstrate the *shortest honest path* for one agent, and every
step it skips must be made explicit rather than hidden:

- If the host is already provisioned (image present, agent binary built), the path
  is `create` → `observe` → `act` → `evidence` → `destroy` with no operator
  intervention. That is demonstrable today.
- If the host is bare, the honest claim is "one documented bootstrap command, then
  the six ops" — not "zero setup".
- Safety claims must be limited to what §1 establishes: the VM boundary and memory
  cap. Nothing in §2 should be described as safe until it is built and tested.

## 5. Open questions this raises (not answered here)

1. Should the runtime reap idle desktops by default (RT-013), given that a leaked
   guest measurably harmed another workstream?
2. Is a network-egress default-off mode needed for "safe", or is the VM boundary
   sufficient for the coding-agent use case?
3. Does an agent need guest→host file transfer for real work, or is
   `evidence`-plus-artifacts enough for the first proof?
4. Is the 3–4 minute first-boot cost acceptable for an agent's inner loop, or does
   the first proof need the provisioned-snapshot fast path (RT-019) to be credible?
## 6. Measured ease barrier (2026-11-21, host-side, no VM)

An agent that runs the MCP server from **any directory other than the repo root**
cannot get a desktop. Reproduced with a probe from `/tmp/myco-bare-test`:

```json
{"id":2,"result":{"isError":true,"content":[{"text":
 "{\"code\":-32000,\"error\":\"backend error: script failed: boot.sh (status
  spawn-failed): No such file or directory (os error 2)\",\"ok\":false}"}]}}
```

Cause: `myco-rt-mcp` resolves the workspace from `std::env::current_dir()`, and
`QemuConfig::for_repo` then looks for `runtime/guest/boot.sh` under it. The error
is honest but offers no remediation, and nothing in the tool surface tells an agent
that a working directory is load-bearing.

This is the concrete form of TIF-56's question. The six ops are fine; **discovery
is not.** An agent should not need to know that the runtime has a repo layout, a
guest directory, or a base image — it should need to know only "give me a desktop".

Design implication (queued as RT-020, not implemented here): the MCP server should
locate its assets independently of `cwd` (explicit config → env var → compiled-in
default), and a failure to locate them must say how to fix it in one line.
