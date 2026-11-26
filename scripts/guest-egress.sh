#!/usr/bin/env bash
# guest-egress.sh: the guest internet allowlist (TIF-275, M2-13).
#
# The guest's only network is QEMU user-mode networking (slirp), configured by
# UTM. UTM's "isolate from host" flag on that NIC adds `restrict=on` to the
# netdev: the guest can no longer open ANY connection out (internet, LAN, or
# the host), while the explicit `hostfwd` rule, host 127.0.0.1:2222 -> guest
# :22, keeps working because it is host-initiated. Everything Myco does with
# the guest rides that one inbound forward: scp/ssh for deploy and reset, and
# the agent's port 8765 through `ssh -L` (it listens on the guest's loopback).
# So the allowlist is: inbound SSH from the host only; outbound nothing.
#
# usage:
#   guest-egress.sh status    read-only: the live netdev check and the UTM network config
#   guest-egress.sh verify    exit 0 only if the running guest AND UTM match the allowlist exactly
#   guest-egress.sh deny      set "isolate from host" (stops the VM; takes the VM lock)
#   guest-egress.sh allow     clear it, for base-image maintenance only (takes the lock)
#   guest-egress.sh probe     from inside the guest, try the internet and the host; JSON
#
# Exit codes: 0 ok; 1 a check failed (egress open, or could not prove it closed);
# 2 usage or environment; 10 the VM lock is held.
#
# `verify` accepts exactly ONE configuration and refuses everything else
# (TIF-275 rounds 2-3, verifier D1-D6). The live half is
# scripts/guest_egress_check.py, which reads the guest's EXACT argv from the
# kernel (not `ps`, which flattens it) and requires: no element containing
# whitespace; `-nodefaults`; exactly one `-netdev` and no `-nic`/`-net`; no
# `-readconfig`/`-set`/`-qmp`/`-monitor`/`-gdb`; a `user` netdev with only
# id, restrict, hostfwd; every `restrict` on; hostfwd exactly
# {tcp:127.0.0.1:2222-:22}; no `-object filter-*` and no `netdev=` except the
# one NIC device's; chardevs only UTM's own (spiceport, spicevmc, pty, the
# swtpm unix socket); -serial/-parallel only chardev references.
#   UTM config: exactly one NIC, emulated, isolate-from-host true, exactly one
#     port forward TCP 127.0.0.1:2222 -> guest :22 (compared as one string).
# Anything that cannot be read or parsed is a failure, never a pass.
set -uo pipefail

NAME=${VM_NAME:-myco-win11}
VSSH=${MYCO_VSSH:-$HOME/VMs/myco-win11/scripts/vssh}
STOP_TIMEOUT=${MYCO_STOP_TIMEOUT:-30}
EXPECTED_UTM='nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22'

die() { echo "guest-egress: $*" >&2; exit "${2:-1}"; }

utm() { osascript -e 'tell application "UTM"' -e "set vm to virtual machine named \"$NAME\"" "$@" -e 'end tell'; }

# The UTM flag on NIC 1, as "true"/"false"; empty if UTM cannot be read.
utm_flag() {
  utm -e 'set config to configuration of vm' -e 'set nic to item 1 of network interfaces of config' \
      -e 'return isolate from host of nic' 2>/dev/null | tr -d '\r'
}

utm_status() { utm -e 'return status of vm' 2>/dev/null | tr -d '\r'; }

# Every NIC and every port forward UTM holds for the VM, as one line, e.g.
#   nics=1;mode=emulated;isolate=true;pfs=1;pf=TCP|127.0.0.1|2222||22
# Empty if UTM cannot be read.
utm_net_config() {
  utm -e 'set config to configuration of vm' \
      -e 'set nics to network interfaces of config' \
      -e 'set out to "nics=" & (length of nics)' \
      -e 'repeat with nic in nics' \
      -e 'set out to out & ";mode=" & (mode of nic as text) & ";isolate=" & (isolate from host of nic as text)' \
      -e 'set pfs to port forwards of nic' \
      -e 'set out to out & ";pfs=" & (length of pfs)' \
      -e 'repeat with p in pfs' \
      -e 'set out to out & ";pf=" & (protocol of p as text) & "|" & (host address of p) & "|" & (host port of p) & "|" & (guest address of p) & "|" & (guest port of p)' \
      -e 'end repeat' -e 'end repeat' -e 'return out' 2>/dev/null | tr -d '\r'
}

# "ok: <netdev>" or "FAIL: <reason>" for the running guest: the exact argv read
# from the kernel (KERN_PROCARGS2) and checked by scripts/guest_egress_check.py.
# `-I` keeps Python from importing anything from the working directory.
live_check() {
  python3 -I "$(cd "$(dirname "$0")" && pwd)/guest_egress_check.py" live
}

cmd_verify() {
  local live cfg
  live=$(live_check) || die "live guest network is not the allowlist: ${live#FAIL: }. Run 'scripts/guest-egress.sh deny' and reset (TIF-275, runbook §3.4)"
  cfg=$(utm_net_config)
  [ -n "$cfg" ] || die "could not read UTM's network configuration; cannot prove egress is closed (TIF-275)"
  [ "$cfg" = "$EXPECTED_UTM" ] || die "UTM network configuration is not the allowlist: got '$cfg', want '$EXPECTED_UTM' (TIF-275, runbook §3.4)"
  echo "guest-egress: egress closed: one restricted user netdev, no guestfwd, hostfwd exactly tcp:127.0.0.1:2222-:22; UTM config matches"
}

cmd_status() {
  local live cfg
  echo "utm isolate-from-host: $(utm_flag | sed 's/^$/unreadable/')"
  cfg=$(utm_net_config)
  echo "utm network config: ${cfg:-unreadable}"
  live=$(live_check) || true
  echo "running guest network: $live"
}

cmd_set() {
  local want=$1 got pf
  source "$(dirname "$0")/vm-lock.sh"
  # Under scripts/vm-session.sh (or a sweep driver) the parent already holds
  # the lock and this process inherited it: accept it, as reset-trial-vm.sh does.
  if ! vm_lock_owned_by_parent; then
    vm_lock_acquire guest-egress.sh || exit "$?"
    trap vm_lock_release EXIT
  fi
  # UTM refuses a configuration update unless the VM is stopped. The next
  # reset-trial-vm.sh restores clean-base and boots it, so stopping is safe.
  utm -e 'stop vm by force' >/dev/null 2>&1 || true
  for _ in $(seq 1 "$STOP_TIMEOUT"); do
    [ "$(utm_status)" = stopped ] && break
    sleep 1
  done
  [ "$(utm_status)" = stopped ] || die "VM did not reach 'stopped' within ${STOP_TIMEOUT}s; configuration not changed"
  utm -e 'set config to configuration of vm' \
      -e 'set nics to network interfaces of config' \
      -e 'set nic to item 1 of nics' \
      -e "set isolate from host of nic to $want" \
      -e 'set item 1 of nics to nic' \
      -e 'set network interfaces of config to nics' \
      -e 'update configuration of vm with config' >/dev/null || die "UTM refused the configuration update"
  # Read everything back: the flag, and that the SSH forward survived intact.
  got=$(utm_flag)
  [ "$got" = "$want" ] || die "UTM reports isolate-from-host '$got' after setting '$want'"
  pf=$(utm -e 'set config to configuration of vm' -e 'set nic to item 1 of network interfaces of config' \
           -e 'set p to item 1 of port forwards of nic' \
           -e 'return (host address of p) & ":" & (host port of p) & "->" & (guest port of p)' 2>/dev/null | tr -d '\r')
  [ "$pf" = "127.0.0.1:2222->22" ] || die "SSH port forward changed to '$pf' (want 127.0.0.1:2222->22); fix it in UTM before any reset"
  echo "guest-egress: isolate-from-host=$want, ssh forward $pf intact; VM left stopped (run scripts/reset-trial-vm.sh)"
}

# Inside the guest: TCP connects (5 s timeout each) and one DNS lookup. Each
# result is "ok" or the exception type. Targets: two internet hosts by name and
# one by raw IP (so a DNS failure alone cannot fake a block), and the host
# itself through slirp's gateway alias 10.0.2.2 (its loopback :2222 listener).
cmd_probe() {
  local ps enc
  ps=$(cat <<'PS1'
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
function Tcp($h, $p) {
  $c = New-Object System.Net.Sockets.TcpClient
  try { if ($c.ConnectAsync($h, $p).Wait(5000) -and $c.Connected) { 'ok' } else { 'timeout' } }
  catch { $_.Exception.GetBaseException().GetType().Name } finally { $c.Dispose() }
}
function Dns($n) {
  try { $t = [System.Net.Dns]::GetHostAddressesAsync($n); if ($t.Wait(5000)) { 'ok' } else { 'timeout' } }
  catch { $_.Exception.GetBaseException().GetType().Name }
}
[ordered]@{
  dns_pypi_org = Dns 'pypi.org'
  tcp_pypi_org_443 = Tcp 'pypi.org' 443
  tcp_1_1_1_1_443 = Tcp '1.1.1.1' 443
  tcp_8_8_8_8_53 = Tcp '8.8.8.8' 53
  tcp_host_10_0_2_2_2222 = Tcp '10.0.2.2' 2222
} | ConvertTo-Json -Compress
PS1
)
  enc=$(printf '%s' "$ps" | iconv -f UTF-8 -t UTF-16LE | base64 | tr -d '\n')
  "$VSSH" "powershell -NoProfile -NonInteractive -EncodedCommand $enc" | tr -d '\r' | grep -m1 '^{'
}

case "${1:-}" in
  status) cmd_status ;;
  verify) cmd_verify ;;
  deny) cmd_set true ;;
  allow) cmd_set false ;;
  probe) cmd_probe ;;
  *) sed -n '/^# usage:/,/^# Exit codes/p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2 ;;
esac
