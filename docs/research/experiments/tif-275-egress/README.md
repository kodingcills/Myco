# TIF-275 (M2-13): guest egress default-deny, evidence

Run 2026-11-25/26 on `myco-win11` (UTM 5.0.9, QEMU user-mode networking) with the TIF-275
code. The `.log` files are force-added: the repo's `.gitignore` excludes `*.log`. Sections 1–5
were recorded with the round-1 `verify`, so `2-egress-status.log` shows that version's output
format. Section 6 is the round-2 `verify` against the same live guest. Every VM step ran behind the `lsof` lock check and the host load gate (under 10 for 3
minutes). No model API was called. Host paths are replaced with `<repo>` / `~`.

## 1. Before: the guest reached everything (positive control)

`scripts/guest-egress.sh probe` against the guest as it was on main (UTM "isolate from host"
false; netdev `user,id=net0,hostfwd=tcp:127.0.0.1:2222-:22`). Transcribed from the session
output. It was not re-run, because re-opening egress just to re-record it would undo the
control.

```
{"dns_pypi_org":"ok","tcp_pypi_org_443":"ok","tcp_1_1_1_1_443":"ok","tcp_8_8_8_8_53":"ok","tcp_host_10_0_2_2_2222":"ok"}
```

This shows the probe detects connectivity, so the "after" failures below are not an artefact
of the probe itself. Note the last field: the guest could reach the host's loopback
listener.

## 2. After: `deny`, then reset

`scripts/guest-egress.sh deny` printed:
`guest-egress: isolate-from-host=true, ssh forward 127.0.0.1:2222->22 intact; VM left stopped`.
The next reset booted the guest with:

- `live-netdev.txt`: `-netdev user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22`, read
  from the running QEMU process.
- `1-reset.log`: `reset-trial-vm: ready on 'clean-base'`, from a reset that now runs
  `guest-egress.sh verify` and refuses the guest if it fails.
- `2-egress-status.log`: the UTM flag is true, the running netdev is restricted, and `verify`
  exits 0.

## 3. An arbitrary internet host is unreachable from the guest

`3-probe-restricted.json` was taken right after the reset, and `6-probe-after-deploy.json`
after a full deploy:

```
{"dns_pypi_org":"timeout","tcp_pypi_org_443":"SocketException","tcp_1_1_1_1_443":"SocketException","tcp_8_8_8_8_53":"SocketException","tcp_host_10_0_2_2_2222":"SocketException"}
```

- DNS fails.
- A raw-IP target (`1.1.1.1:443`) also fails, so this is not just a DNS block.
- The host itself (`10.0.2.2:2222`) is unreachable.

`7-guest-pip-download-refused.log` shows a real client getting the same result: `pip download
six` inside the guest fails with `No matching distribution found`.

## 4. Allowed endpoints work

The only allowed path is host → guest SSH. Everything Myco does rides it:

- **Reset:** readiness probes and clock resync (`1-reset.log`).
- **Deploy with offline wheels** (`4-deploy.log`): `staged 3 wheels for the guest (installed
  offline, hash-pinned)`, `verified 14 files on the guest against the source (sha256)`, `ping
  verified`, `DEPLOY OK`. The wheels came from the host. The guest installed them with `pip
  --no-index --require-hashes`.
- **`session_info`** (`5-session-info.json`): `{"session_id":1,"window_station":"WinSta0",
  "desktop":"Default","user":"MYCO-WIN11\\myco"}` (the guest account), which is the agent RPC
  over `ssh -L`.
- **Guest Python imports** (`7a-guest-imports.log`): the offline-installed packages import in
  LibreOffice's Python, with the pinned versions.

## 5. Free mock-transport run

`8-mock-transport-run.log`: `pnpm myco-run --transport mock --task df-s01` gives `VERIFIED`,
`artifacts: VALID`, exit 0. The mock transport uses no guest by design ("contract double, no
guest"), so this shows the host pipeline is unaffected. Sections 2–4 above are the
guest-side proof.

## 6. Round 2: the exact-allowlist `verify` on the live guest

`9-round2-verify-live.txt` shows `status` and `verify` from the round-2 script against the same
running guest:

- the UTM network config is `nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22`;
- the live check is `ok: user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:2222-:22`;
- `verify` exits 0.

The refusal cases (a second NIC, `guestfwd`, a `0.0.0.0` bind, an extra forward, a missing
`restrict=on`, unparseable input, and UTM drift) are host-side tests in
`test/guest-egress.test.ts`, each with a mutation shown to be caught.

## 7. Round 3: exact argv, `-nodefaults`, no tunnels past slirp

`10-round3-verify-live.txt` shows the round-3 `verify` against the same live guest (exit 0),
plus facts read from its exact argv through `KERN_PROCARGS2`:

- 104 elements, 0 containing whitespace;
- `-nodefaults` present as its own element;
- no `-object`, `-qmp` or `-monitor`;
- chardevs only `spiceport`, `spicevmc`, `pty` and the swtpm unix socket;
- `-serial chardev:term0`.

That is UTM's default launch, and it is exactly what the D5 chardev allowlist permits. The
refusal cases (filters, other netdev references, TCP/UDP/telnet/socket backends, `-qmp` and
`-monitor`, an element with whitespace, a missing `-nodefaults`, malformed procargs buffers)
are host-side tests in `test/guest-egress.test.ts`, each with a mutation shown to be caught.

## 8. Follow-up: option allowlist (no VM run)

The allowlist follow-up (D7–D9 from PR #482's round-3 verdict) was built without the VM. The
host-side tests in `test/guest-egress.test.ts` cover it. One read-only step on the live guest
is still owed before merge: `python3 -I scripts/guest_egress_check.py names`, committed here as
`11-allowlist-live-names.txt`, plus a `verify` exit 0. Why: section 7 records 13 of the 104
live elements, so the options UTM's argument builder adds (`-L`, `-S`, `-drive`, `-cpu`, …)
are modelled from UTM 5.0.9's builder, not read from this guest. If one is missing, `verify`
fails closed and the reset refuses the guest.

## Reproduce

```bash
lsof /tmp/myco-win11.vm.lock || echo free     # must print free
scripts/guest-egress.sh status
scripts/reset-trial-vm.sh                      # refuses the guest unless egress is closed
scripts/guest-egress.sh verify
scripts/guest-egress.sh probe                  # expect every field to fail
agent/bootstrap/deploy-to-vm.sh                # with MYCO_TOKEN_OUT set (runbook §4)
pnpm exec tsx src/integration/session-info.ts --token-file "$MYCO_TOKEN_OUT"
pnpm myco-run --transport mock --task df-s01 --out runs/mock
```
