#!/usr/bin/env bash
# load-gate.sh: the host load gate for VM trial drivers (TIF-218). Source it.
#
# The gate measures NET load: the host 1-minute load minus the cores the guest's
# own QEMU process is using right now. Before TIF-218 the gate used the raw
# 1-minute load, which counts the guest itself. A booted guest kept a host with
# no sweep running at load 11-14.5, so the old resume rule (raw load under 10)
# could not clear, and the pause rule (raw load over 14) fired on the guest's own
# boot. Measured 2026-11-26 (docs/research/experiments/tif-218-load-gate-2026-11-26/):
#
#   state (40 x 15 s each)   raw load1 p95/max   QEMU cores p95   net p95/max
#   VM stopped               6.27 / 7.22         0                6.27 / 7.22
#   clean-base idle          9.11 / 10.23        2.60             7.07 / 8.40
#   3 trial-base-v2 resets   13.04 / 13.23       2.98             11.11 / 11.17
#   trial-base-v2 idle       11.87 / 16.33       1.57             11.59 / 16.31 (*)
#   (*) the max is a jump with QEMU at 0.02 cores. By inference it was another
#       host process: there is no per-process data except QEMU's.
#
# Thresholds. Both are the old numbers, kept; the measurement checks them, it did
# not derive them:
#   pause   net > 14 (LG_PAUSE_NET): about 2.8 above the highest net load the
#           guest's own resets produced (11.17).
#   resume  net < 10 for 7 consecutive 30 s samples (LG_RESUME_NET). There is NO
#           margin over an idle trial-base-v2 guest: it reached net 10.00
#           (08:30:12Z) and 9.52 (08:29:12Z). It is above the clean-base-idle and
#           VM-stopped maxima (8.40, 7.22). A sample at 10 does not block a
#           resume, it restarts the 3-minute wait. The 3-minute window cleared
#           274 s into idle trial-base-v2 and about 180 s into the clean-base-idle
#           and VM-stopped states. It never cleared during back-to-back resets
#           (7 of 36 samples at or over 10). The supervisor checks the resume gate
#           only while no driver runs, so no reset is in progress then
#           (summary.md, resume table).
#   swap    free < 300 MB pauses (LG_MIN_SWAP_FREE_MB, unchanged; no memory
#           pressure was seen, so the data cannot derive it).
#
# Fail closed: an unreadable load counts as over the line, and unreadable swap
# counts as under the floor. A threshold override that is not a number pauses
# (it never compares as a string). An unreadable QEMU share subtracts nothing,
# so the gate falls back to the raw load (the old, stricter behaviour). The swap
# gate does not depend on the QEMU share, so real memory pressure still pauses.
#
# What is subtracted: every process whose executable's basename is exactly
# QEMULauncher. One UTM guest runs as 2 such processes (qemu_procs = 2 in every
# guest state measured), so they are summed. There is no cap: any other UTM VM on
# the host is subtracted too, and a second VM would hide that much real host load.
# In every measured guest state the subtraction was at most 3.11 cores (the
# v2-resets maximum). Before a reset that is acceptable, because the reset
# discards what the guest was doing.
#
# Functions:
#   lg_load1 | lg_qemu_cores | lg_swap_free_mb   read the host (names-only ps)
#   lg_net <load1> <qemu_cores>                  net load, floored at 0, 2 decimals
#   lg_decide <load1> <qemu_cores> <swap_free_mb>
#       prints ok | PAUSED_LOAD net=.. load1=.. qemu=.. | PAUSED_SWAP free=..M
#       and returns 0 | 4 | 6 (the sweep drivers' exit codes)
#   lg_resume_sample_ok <load1> <qemu_cores>     0 if net < LG_RESUME_NET
#   lg_now_decide | lg_now_resume_ok             the same on live readings

LG_PAUSE_NET=${LG_PAUSE_NET:-14}
LG_RESUME_NET=${LG_RESUME_NET:-10}
LG_MIN_SWAP_FREE_MB=${LG_MIN_SWAP_FREE_MB:-300}

# Field 2 of `{ 1m 5m 15m }`: the 1-minute load.
lg_load1() { sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}'; }

# Cores used by processes whose executable's basename is exactly QEMULauncher
# (UTM's guest), from ps's %cpu (100 = one core). Executable paths only: no
# arguments, no environment.
lg_qemu_cores() {
  ps -Ao pcpu=,comm= 2>/dev/null | awk '{c=$1; $1=""; sub(/^ +/, ""); n=split($0, a, "/");
    if (a[n] == "QEMULauncher") s += c } END { printf "%.2f\n", s / 100 }'
}

# The `free = NNN.NNM` field of vm.swapusage; empty when it is not there.
lg_swap_free_mb() { sysctl -n vm.swapusage 2>/dev/null | sed -nE 's/.*free = ([0-9.]+)M.*/\1/p'; }

lg_is_num() { [[ "${1:-}" =~ ^[0-9]+([.][0-9]+)?$ ]]; }

lg_net() {
  local load=$1 qemu=$2
  lg_is_num "$qemu" || qemu=0
  awk -v l="$load" -v q="$qemu" 'BEGIN { n = l - q; if (n < 0) n = 0; printf "%.2f\n", n }'
}

lg_decide() {
  local load=${1:-} qemu=${2:-} swap=${3:-} net shown
  if ! lg_is_num "$LG_PAUSE_NET" || ! lg_is_num "$LG_MIN_SWAP_FREE_MB"; then
    echo "PAUSED_LOAD gate-config-invalid"; return 4
  fi
  if ! lg_is_num "$load"; then echo "PAUSED_LOAD load1=unreadable"; return 4; fi
  shown=$qemu; lg_is_num "$qemu" || shown=unreadable
  net=$(lg_net "$load" "$qemu")
  if awk -v n="$net" -v m="$LG_PAUSE_NET" 'BEGIN { exit !(n > m) }'; then
    echo "PAUSED_LOAD net=$net load1=$load qemu=$shown"; return 4
  fi
  if ! lg_is_num "$swap" || awk -v f="$swap" -v m="$LG_MIN_SWAP_FREE_MB" 'BEGIN { exit !(f < m) }'; then
    echo "PAUSED_SWAP free=${swap:-unreadable}M"; return 6
  fi
  echo "ok net=$net load1=$load qemu=$shown"
}

lg_resume_sample_ok() {
  local load=${1:-} qemu=${2:-}
  lg_is_num "$LG_RESUME_NET" || return 1
  lg_is_num "$load" || return 1
  awk -v n="$(lg_net "$load" "$qemu")" -v m="$LG_RESUME_NET" 'BEGIN { exit !(n < m) }'
}

lg_now_decide() { lg_decide "$(lg_load1)" "$(lg_qemu_cores)" "$(lg_swap_free_mb)"; }
lg_now_resume_ok() { lg_resume_sample_ok "$(lg_load1)" "$(lg_qemu_cores)"; }
