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
- The deploy (`agent/bootstrap/deploy-to-vm.sh`) runs the same `verify` before anything
  touches the guest. It refuses outright under `MYCO_GUEST_EGRESS=open`, so the agent's token
  never enters a guest whose egress is not proven closed, even after a maintenance reset or
  a guest started by hand.
- `verify` accepts exactly **one** configuration. It checks two sources, and both must
  match:
  - **The live QEMU command line, read exactly.** `scripts/guest_egress_check.py` reads each
    candidate process's argv from the kernel (`sysctl` `KERN_PROCARGS2`), not from `ps`.
    `ps` joins argv with spaces, so `-name "x -netdev user,…,restrict=on"` would look like a
    real netdev while QEMU added its default, unrestricted NIC (round 3, D6).
    - **Exactly argc strings, never the environment.** The argv starts at the exec path
      rounded up to the pointer size (8), which is how xnu pads it. An empty argv[0] is
      refused: it looks like padding, and skipping it read the first environment string as
      the last argument (follow-up, D9).
    - **Nothing unvetted is printed, in any mode** (round 2, V1). argc is fixed at exec, but
      the string area is the process's own memory: a process that rewrites it
      (setproctitle-style) can leave fewer argv strings than argc, and then the last
      "elements" read are environment strings. They cannot be told apart, so:
      - a refusal (`live`, `verify`, `status`) names an element by its argv index and prints
        only fixed text and words from the script's fixed vocabularies (QEMU option and
        property names, chardev backends, drivers). It never echoes an element's text, so a
        positional or trailing element shows as `positional argument at argv[N]`;
      - `names` prints an option name only if it is in that vocabulary, otherwise
        `<unrecognised option argv[N]>` or `<positional argv[N]>`;
      - `argv` prints an element only if it is accepted as an allowlisted option name, or as
        a value that its option's rule accepts; every other element prints as
        `<redacted argv[N]>`.

      So an environment string (`NAME=value`) never prints. One narrow exception remains:
      the process itself wrote two environment strings shaped as an allowlisted option and a
      value its rule accepts, for an option UTM may legitimately repeat (`-chardev`,
      `-device`, `-drive`), directly after the last real element. `argv` mode then prints
      that value, but it is still vetted, and `live`/`verify` still apply every rule to it
      (a second chardev id, a second NIC, a `netdev=` or a non-SPICE `chardev=` is refused).
      For every other option the pair is closed (round 3, N1): a second copy of an option
      UTM writes once is refused by `live`/`verify`, and `argv` redacts its value. The test
      plants the environment strings `-name` and a bare `PLANTED_FAKE_MARKER` at argc+2:
      `live` and `verify` refuse with `-name given more than once (argv[N]; …)`, and no
      mode prints the marker. Tests plant `PLANTED_FAKE_MARKER` in the environment with argc raised by 1, 2,
      3, 5, 7 and 8, and assert it is absent from every mode's output. A sweep replaces each
      element of UTM's launch with planted variants (over 1,000 cases) and asserts no
      refusal or `names` line contains the marker.
    - **Process:** exactly one guest process, identified by argv[0] (`QEMULauncher` running a
      qemu binary, or a qemu binary).
    - **Shape:** no argv element may contain whitespace, and `-nodefaults` must be present as
      its own element. Without it QEMU adds a default NIC.
    - **Options UTM writes once appear once** (round 3, N1): `-name`, `-uuid`, `-m`, `-smp`,
      `-machine`, `-accel`, `-cpu`, `-L`, `-vga`, `-rtc`, `-boot`, `-mon`, `-serial`,
      `-tpmdev`, `-spice`, `-netdev`, `-nodefaults` and `-S` (`SINGLETONS`). A second copy
      is refused. UTM's launch repeats only `-chardev`, `-device` and `-drive` (the committed
      evidence shows nine `-chardev`; the builder writes several `-device` and `-drive`). If
      the read-only live `names` run shows UTM repeating a singleton, the reset refuses
      (closed); remove it from `SINGLETONS` with a test.
    - **Every option is on a fixed allowlist** (follow-up to round 3, D7/D8). Rounds 1–3
      refused named bad options, and each round found one the list did not name: a JSON-form
      `-object` filter, `-qmp-pretty`. Now an option not on the list below is refused,
      whatever it is, and so is any positional argument (QEMU takes one as a disk image), any
      `-opt=value` form and any value in JSON form (`{…}`). Both `-x` and `--x` spellings are
      checked against the same list.
    - **The netdev:** exactly one `-netdev`. It must be `user`, with only `id`, `restrict` and
      `hostfwd`, so a `guestfwd` or any other option is refused. Every `restrict` must be
      `on`. The `hostfwd` set must be exactly `{tcp:127.0.0.1:2222-:22}`.
    - **Nothing else on the netdev's packets** (D5, D7). `-object` is not on the list, in any
      form, so no `filter-redirector`/`filter-mirror`/`filter-dump` can attach before slirp.
      `-global` is not on the list either. `netdev=` may appear only once, on the one
      `virtio-net-pci` device, naming the netdev's id.
    - **No host-network channel** (D5, D7). Chardevs are exactly UTM's: `spiceport`
      (name and id only), `spicevmc` (name, id and `debug` only), the one pty `pty,id=term0`, and the swtpm socket
      `socket,id=chrtpm0,path=<VM-UUID>.swtpm`. A second pty is refused: a pty was the
      `outdev` of round 3's D7 tunnel. A `-device chardev=` must name a SPICE chardev.
      `-serial` is exactly `chardev:term0`, and `-mon` is exactly UTM's QMP on its spiceport.

    **The allowlist** (`ALLOWED` and `FLAGS` in `scripts/guest_egress_check.py`). "Live"
    means the element is in `docs/research/experiments/tif-275-egress/10-round3-verify-live.txt`.
    "Builder" means UTM 5.0.9's QEMU argument builder writes it for this VM type
    (wizard-default Windows 11 ARM64: HVF, NVMe, virtio-ramfb, TPM, SPICE). The committed
    evidence lists 13 of the live launch's 104 elements, so the builder entries still need
    one read-only `names` run on the live guest (below).

    | Option | Value allowed | Source |
    |---|---|---|
    | `-nodefaults` | none (required) | live |
    | `-S` | none | builder (UTM starts paused, resumes over QMP) |
    | `-netdev` | one, as above | live |
    | `-device` | a driver from `DEVICE_DRIVERS` (one NIC `virtio-net-pci`; display, sound, USB, `usb-redir`, `nvme`/`virtio-blk-pci`, `virtio-serial`, `virtserialport`, `tpm-tis-device`, `virtio-rng-pci`, …), then `key=value` with no `,` `{` or whitespace in values; `netdev=` only on the NIC; `chardev=` only to a SPICE chardev | live (NIC), builder (rest) |
    | `-chardev` | `spiceport,name=…,id=…`; `spicevmc,name=…,id=…[,debug=N]`; exactly `pty,id=term0`; exactly the swtpm socket | live |
    | `-mon` | exactly `chardev=org.qemu.monitor.qmp,mode=control`, on the spiceport | live |
    | `-serial` | exactly `chardev:term0` | live |
    | `-spice` | `unix=on` required; `addr` a path; `disable-ticketing`, compression, `streaming-video`, `gl`, `rendernode`. No `port`/`tls-port` | live (unix), builder (rest) |
    | `-tpmdev` | exactly `emulator,id=tpm0,chardev=chrtpm0` | builder (its chardev is live) |
    | `-drive` | `if` pflash/none, `format` raw/qcow2, `file`/`file.filename` a path with no `:` (so no `nbd:`, `http:`, `json:`), `unit`, `index`, `readonly`, `media`, `id`, `discard`, `detect-zeroes`, `cache`, `file.locking`. No `driver=` | builder |
    | `-L` | an absolute path | builder |
    | `-cpu`, `-smp`, `-machine virt[,…]`, `-accel hvf\|tcg`, `-m`, `-boot`, `-rtc`, `-vga none` | numeric or word values only | builder |
    | `-name`, `-uuid` | a word; a UUID | builder |

    Kept off the list, with the reason the refusal prints: `-object`, `-qmp`, `-qmp-pretty`,
    `-monitor`, `-gdb`, `-readconfig`, `-set`, `-global`, `-nic`, `-net`, `-parallel`,
    `-debugcon`, `-incoming`, `-vnc`, `-display`, `-add-fd`.

    **Updating the list when UTM changes.** After a UTM upgrade, or a VM setting change, the
    next reset may refuse an option UTM now writes. That failure is closed, never open.
    1. With the VM lock free, run `python3 -I scripts/guest_egress_check.py names`. It prints
       each option NAME of the live launch with `allowed` or `NOT ALLOWED`, and no values, so
       its output is safe to paste into a PR.
    2. For each `NOT ALLOWED` name, read what the option can do in QEMU's documentation. If
       it can open a socket, attach to a netdev, add a monitor, or load configuration, do not
       add it; change the UTM setting that produced it instead.
    3. Otherwise add it to `ALLOWED` with the tightest value rule that UTM's value fits (use
       `argv` mode to see the value; it may contain host paths, so don't paste it). `argv`
       redacts every element no rule accepts, so a value the list does not yet allow shows as
       `<redacted argv[N]>`: read that one element on the host yourself, never paste it. Add the
       option to the `utmDefaultArgv()` fixture and a refusal test for a bad value of it in
       `test/guest-egress.test.ts`.
    4. Re-run `scripts/guest-egress.sh verify` on the live guest and commit the `names`
       output to the evidence pack.
  - **UTM's configuration.** There must be exactly one NIC, in emulated mode, with "isolate
    from host" on and exactly one port forward: TCP `127.0.0.1:2222` → guest `:22`. This is
    compared as one exact string.

  Anything it cannot read or parse is a failure. That includes:
  - an unreadable process list, an unreadable UTM, and a process whose argv cannot be read
    for a fixture run;
  - a readable process whose procargs do not parse when its exec path is a qemu binary or
    `QEMULauncher` (outside fixture runs other unparseable processes are skipped, so a
    second guest with an empty argv[0] would otherwise go uncounted);
  - a malformed or truncated procargs buffer, an empty exec path, non-NUL padding and an
    empty argv[0];
  - an option without `=`, an escaped comma, a JSON value, a `-netdev=` form, and an option
    with no value.

  `test/guest-egress.test.ts` has a negative case for each rule, fed fixed `KERN_PROCARGS2`
  byte buffers. **Mutation claim** (round 3, PR #488): every `raise Refused(…)` in
  `scripts/guest_egress_check.py` was replaced with `pass`, one at a time, and the suite
  run. Every replacement fails at least one test, except these five, which are not counted
  as tested rules:
  - the two real-host `sysctl` failures (`KERN_ARGMAX`, `KERN_PROCARGS2`): tests serve
    fixed buffers, so no test reaches them;
  - the three process-listing refusals in `candidate_pids()` (listing failed, empty or
    non-zero exit, a non-numeric pid): tests supply their own `ps`. The empty-listing case is
    also backstopped by "expected exactly one running guest, found 0".

  The two bare re-raises in `find_guest_argv()` (fixture mode, and an unparseable qemu
  process) were mutated the same way and both fail tests. Rules that a later rule
  backstops (an unterminated exec path, an empty value, JSON on a shape-checked option, a
  known QEMU option off the list) count because their tests assert the rule's own message.
- **What `verify` cannot see.** It checks what QEMU was started with and what UTM is
  configured to start. Two things are outside it:
  - Changes made at run time through a QMP monitor. UTM's QMP is a SPICE port reached
    through SPICE's unix socket, not a host TCP socket. No other monitor can be configured:
    `-qmp`, `-qmp-pretty` and `-monitor` are off the allowlist, `-mon` must be UTM's exact
    value, and `-spice` must be `unix=on` with no TCP port. Any local process that can open
    UTM's SPICE socket can still reach that QMP, as UTM itself does.
  - Anything inside QEMU or UTM themselves.
- The UTM setting is a persistent VM property, not something each reset applies. If anyone
  clears it, in the GUI or with `guest-egress.sh allow`, the next reset refuses the guest
  instead of trusting it.
- The single escape is an explicit `MYCO_GUEST_EGRESS=open` on the reset, for base-image
  maintenance. It prints a warning and is never a default anywhere in the repo.
- `deny` and `allow` take the VM lock, change the flag only with the VM stopped (a UTM
  requirement), then read back both the flag and the SSH port forward. If the forward
  changed, they fail.

## Former open gaps D7–D9 (closed by the allowlist follow-up)

PR #482 shipped with three gaps its round-3 verifier found (at `55af502e`):
- **D7:** a JSON-form `-object` filter on `net0` to a `pty` or `spiceport`;
- **D8:** `-qmp-pretty` / `--qmp-pretty`;
- **D9:** an empty argv[0] shifted the environment into the decoded argv.

The allowlist follow-up (TIF-275 follow-up, Linear pending) closes all three, as described
above. Each has negative tests and a mutant shown caught.

## Evidence

`docs/research/experiments/tif-275-egress/`: probes before and after, the live netdev, a
reset with the check, a deploy with offline wheels, `session_info`, the guest's Python
imports, a refused guest-side `pip download`, and a mock-transport run. Host-side tests:
`test/guest-egress.test.ts`, `test/reset-snapshot-allowlist.test.ts` (egress cases) and
`test/deploy-copy-retry.test.ts` (wheel cases, and the deploy's egress refusal).

## Residual risks and limits

- **The inbound forward is the remaining surface.** `verify` requires it to bind host
  `127.0.0.1` only, on every reset and deploy, so the LAN cannot reach the guest. Any local
  process on the host can still try SSH. The guest is key-only.
- **What a host-side agent sends to the guest is out of scope.** A guest that a host-side
  agent drives can still receive data the host sends it. This control limits what the
  guest can send **out**.
- **No outbound shared folders or clipboard paths are used by trials.** UTM's WebDAV
  directory share and clipboard sharing are SPICE channels, not IP, so `restrict=on` does
  not cover them. Trials don't use them. Whether the guest has the SPICE tools that would
  activate them was not checked, so disabling both in UTM is a follow-up.
- **IPv6 was not probed.** QEMU documents `restrict=on` as isolating the guest from all
  outside traffic, but no IPv6 target is in the probe. Adding one is a follow-up.
- **The Windows clock no longer syncs over NTP.** The reset's clock resync over `ssh`
  already covers trials.
