# Guest egress: default deny (TIF-275, M2-13)

**Status:** enforced on every trial reset since TIF-275. Operator procedure: `docs/eval-runbook.md` §3.4.

## Why

M2's security gates (`docs/product/m2-plan-draft.md` §2.3) require a guest internet
allowlist **before any real data or credentials enter a guest**. Until TIF-275 the Windows
test guest had full outbound access. On 2026-11-25 a probe from inside the guest reached
DNS, `pypi.org:443`, `1.1.1.1:443`, `8.8.8.8:53`, and the **host's own loopback** listener
through slirp's `10.0.2.2` alias. A guest that can reach the internet can exfiltrate
anything placed in it, and can pull code an attacker chooses. The cases that matter here:

- an injected instruction in screen content (M2-10's fault class);
- a compromised dependency;
- an agent told to "look something up".

A guest that can reach the host's loopback can talk to host services that were never meant
to face it.

The guest also churned on its own network traffic. Defender signature and platform updates
and Windows Update ran during trials (TIF-98's boot profile). That made the guest's state
drift within a trial, and it is now blocked too.

## What the guest needs

| Need | Direction | Kept? |
|---|---|---|
| reset readiness probes, clock resync (`ssh`) | host → guest :22 | yes, via the `hostfwd` |
| deploy: copy tree and token (`scp`), register task (`ssh`) | host → guest :22 | yes |
| agent RPC on guest port 8765 | host → guest, inside `ssh -L` | yes (it rides :22) |
| agent Python wheels (pywin32, comtypes, uiautomation) | guest → PyPI | **no**: fetched on the host, installed offline and hash-pinned |
| DNS, NTP, Windows Update, activation, Defender cloud and updates, telemetry | guest → internet | **no** |
| anything on the host | guest → `10.0.2.2` | **no** |

The model API is called from the host, never from the guest. So the allowlist is one
inbound port and no outbound destinations.

## Mechanism

The guest's NIC is QEMU user-mode networking (slirp), set up by UTM in "emulated" mode. UTM's
per-NIC **isolate from host** setting adds `restrict=on` to the netdev. Verified on the live
process:

```
-netdev user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22
```

From QEMU's documentation for `-netdev user`: with `restrict=on` the guest "will not be able
to contact the host and no guest IP packets will be routed over the host to the outside",
and the option "does not affect any explicitly set forwarding rules". So `hostfwd` keeps
working.

This choice over the alternatives:

- **A host firewall (pf) cannot tell guest traffic apart.** slirp's outbound connections
  are ordinary sockets owned by the QEMU process, and pf rules per process are not
  available on macOS. Any rule broad enough to stop the guest would also stop UTM and the
  host.
- **`guestfwd` with an allowlisting proxy is not needed.** No outbound destination is
  needed, and a proxy is one more component that has to be correct.
- **Default deny is structural.** Nothing has to list what to block: slirp routes nothing
  out of the guest.

## Enforcement and fail-closed rules

- `scripts/reset-trial-vm.sh` runs `scripts/guest-egress.sh verify` after the boot gate and
  before calling the guest ready, on **every** reset. The reset is the entry point of every
  trial and every deploy.
- `verify` passes only on positive evidence: exactly one running guest process, identified
  by argv[0] (`QEMULauncher` or a qemu binary), whose `-netdev` is a `user` netdev with
  `restrict=on` as a whole comma-separated option. Every other case fails the reset:
  - no guest, or two guests;
  - an unreadable process table;
  - `restrict=off`, or a missing option;
  - the string embedded inside another option;
  - a different netdev type.
- The UTM setting is a persistent VM property, not something each reset applies. If anyone
  clears it, in the GUI or with `guest-egress.sh allow`, the next reset refuses the guest
  instead of trusting it.
- The single escape is an explicit `MYCO_GUEST_EGRESS=open` on the reset, for base-image
  maintenance. It prints a warning and is never a default anywhere in the repo.
- `deny` and `allow` take the VM lock, change the flag only with the VM stopped (a UTM
  requirement), then read back both the flag and the SSH port forward. If the forward
  changed, they fail.

## Evidence

`docs/research/experiments/tif-275-egress/`: probes before and after, the live netdev, a
reset with the check, a deploy with offline wheels, `session_info`, the guest's Python
imports, a refused guest-side `pip download`, and a mock-transport run. Host-side tests:
`test/guest-egress.test.ts`, `test/reset-snapshot-allowlist.test.ts` (egress cases) and
`test/deploy-copy-retry.test.ts` (wheel cases).

## Residual risks and limits

- **The inbound forward is the remaining surface.** It binds host `127.0.0.1` only, so the
  LAN cannot reach the guest, but any local process on the host can try SSH. The guest is
  key-only.
- **What a host-side agent sends to the guest is out of scope.** A guest that a host-side
  agent drives can still receive data the host sends it. This control limits what the
  guest can send **out**.
- **No outbound shared folders or clipboard paths are used by trials.** UTM's WebDAV
  directory share and clipboard sharing are SPICE channels, not IP, so `restrict=on` does
  not cover them. Trials don't use them. Whether the guest has the SPICE tools that would
  activate them was not checked, so disabling both in UTM is a follow-up.
- **IPv6 was not probed separately.** slirp's `restrict=on` applies to all guest traffic.
- **The Windows clock no longer syncs over NTP.** The reset's clock resync over `ssh`
  already covers trials.
