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
#   guest-egress.sh status    read-only: the UTM flag and, if a guest runs, its netdev
#   guest-egress.sh verify    exit 0 only if the RUNNING guest's netdev has restrict=on
#   guest-egress.sh deny      set "isolate from host" (stops the VM; takes the VM lock)
#   guest-egress.sh allow     clear it, for base-image maintenance only (takes the lock)
#   guest-egress.sh probe     from inside the guest, try the internet and the host; JSON
#
# Exit codes: 0 ok; 1 a check failed (egress open, or could not prove it closed);
# 2 usage or environment; 10 the VM lock is held.
#
# Fails closed: `verify` succeeds only on positive evidence, the literal
# `restrict=on` in the live QEMU netdev argument. A missing process, an
# unreadable argv or a netdev without it is a failure, never a pass.
set -uo pipefail

NAME=${VM_NAME:-myco-win11}
VSSH=${MYCO_VSSH:-$HOME/VMs/myco-win11/scripts/vssh}
STOP_TIMEOUT=${MYCO_STOP_TIMEOUT:-30}

die() { echo "guest-egress: $*" >&2; exit "${2:-1}"; }

utm() { osascript -e 'tell application "UTM"' -e "set vm to virtual machine named \"$NAME\"" "$@" -e 'end tell'; }

# The UTM flag on NIC 1, as "true"/"false"; empty if UTM cannot be read.
utm_flag() {
  utm -e 'set config to configuration of vm' -e 'set nic to item 1 of network interfaces of config' \
      -e 'return isolate from host of nic' 2>/dev/null | tr -d '\r'
}

utm_status() { utm -e 'return status of vm' 2>/dev/null | tr -d '\r'; }

# The live guest's `-netdev` argument, one line, or nothing. Identity is by
# argv[0] basename (QEMULauncher for UTM, or a bare qemu binary), as in
# scripts/vm-state.sh, plus a `-netdev` option: a `pgrep -f qemu-...` or an
# editor with the name in its argv must never count as a guest. More than one
# guest is ambiguous: report nothing, so `verify` fails closed.
live_netdev() {
  local table out
  table=$(ps -Ao command= 2>/dev/null) || return 1
  [ -n "$table" ] || return 1
  out=$(printf '%s\n' "$table" | awk '{
    n = split($1, a, "/"); base = a[n]
    if (base != "QEMULauncher" && base != "qemu-system-aarch64" && base != "qemu-aarch64-softmmu") next
    for (i = 2; i < NF; i++) if ($i == "-netdev") { print $(i + 1); found++; break }
  } END { if (found != 1) exit 1 }') || return 1
  printf '%s\n' "$out"
}

# restrict=on as its own comma-separated option of a user-mode netdev.
netdev_restricted() {
  case "$1" in
    user,*) ;;
    *) return 1 ;;
  esac
  printf '%s' "$1" | tr ',' '\n' | grep -qx 'restrict=on'
}

cmd_verify() {
  local nd
  nd=$(live_netdev) || true
  [ -n "$nd" ] || die "no single running guest whose netdev could be read; cannot prove egress is closed (TIF-275)"
  if netdev_restricted "$nd"; then
    echo "guest-egress: running guest is restricted (netdev has restrict=on); egress closed, inbound ssh forward only"
    return 0
  fi
  die "running guest's netdev has no restrict=on: guest egress is OPEN. Run 'scripts/guest-egress.sh deny' and reset (TIF-275, runbook §3.4)"
}

cmd_status() {
  local flag nd
  flag=$(utm_flag)
  echo "utm isolate-from-host: ${flag:-unreadable}"
  nd=$(live_netdev) || true
  if [ -z "$nd" ]; then
    echo "running guest netdev: none (no single guest running)"
  elif netdev_restricted "$nd"; then
    echo "running guest netdev: restricted (restrict=on)"
  else
    echo "running guest netdev: OPEN (no restrict=on)"
  fi
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
