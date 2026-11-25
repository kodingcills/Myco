#!/usr/bin/env bash
# Wait until the guest has actually BOOTED, not merely until a process exists.
#
# Why this exists (TIF-164, measured 2026-11-23 09:22-09:41 ET):
# `vm.sh start` returns rc 0 for a guest that never executes. A stalled guest
# held pid 69100 with "-S" (started paused) and consumed 00:01 CPU across 04:22
# elapsed - one second in four and a half minutes - while:
#   * `vm.sh status` reported "started"
#   * port 2222 ACCEPTED TCP connections, because QEMU's user-mode netdev listens
#     with the guest stopped
#   * every SSH attempt timed out during banner exchange
# The existing SSH-only wait would have spent its whole 600s budget and then
# failed, which is exactly what happened: the entire locked window was consumed
# by a guest that was never booting. This gate fails in ~60s instead, and names
# which signal failed so the operator knows whether to blame the boot or the SSH.
#
# Signal 1, CPU time: a booting Windows guest accumulates CPU seconds
# immediately. A guest whose CPU time is flat is not booting, no matter what
# UTM's status says. This is the discriminating signal - the one that was
# missing.
# Signal 2, SSH banner: necessary but not sufficient, since a booted guest can
# still be slow to answer.
#
# usage: wait-guest-ready.sh [timeout_seconds] [min_cpu_seconds_per_interval]
set -uo pipefail

T=${1:-600}
# How many CPU seconds the guest must gain before SSH alone can be trusted. A
# single 1s blip is weak evidence: TIF-164's stalled guest also sat at exactly
# 00:01, so one second of progress would have been indistinguishable from a
# process that ran once and stopped. This parameter was parsed and ignored in the
# first version (a documented knob that did nothing); it is now load-bearing.
MIN_DELTA=${2:-3}
CFG=~/VMs/myco-win11/ssh_config

# How often to sample guest CPU time. Overridable so tests can exercise the
# stall logic in seconds rather than in real wall-clock tens of seconds: a suite
# that takes 96s trips vitest's default worker-report timeout, which fails CI as
# an unhandled error even when every test passes. The production value stays 10.
INTERVAL=${MYCO_READY_INTERVAL:-10}

# Stable-readiness phase (TIF-220). One answered probe is not "up": in the live
# row-8 sweep, trial 14's reset passed this gate, printed `ready on
# 'clean-base'`, and the deploy's first scp seconds later died with "Connection
# to 127.0.0.1 closed by remote host" - sshd was still settling after the cold
# boot. 1 such drop in 28 cold-reset + deploy cycles on this host.
#
# So after the first answer we require STABLE_PROBES consecutive answers,
# STABLE_SPACING seconds apart. Defaults 3 and 5s: 10s added to a healthy reset
# (versus a 21-165s cold boot), and a window a few times longer than the
# observed gap between this gate's answer and the scp that was dropped (the
# clock resync, ~1-3s). One drop in 28 does not tell us how long sshd settles,
# so this window is a cheap first line, not a guarantee; deploy-to-vm.sh's
# verified, bounded copy retry is the backstop for a drop after it.
#
# A drop resets the count. MAX_DROPS drops fail the gate loudly instead of
# spending the whole budget on a guest whose sshd keeps flapping.
STABLE_PROBES=${MYCO_READY_STABLE_PROBES:-3}
STABLE_SPACING=${MYCO_READY_STABLE_SPACING:-5}
MAX_DROPS=${MYCO_READY_MAX_DROPS:-3}

# The real binary is qemu-aarch64-softmmu. `pgrep -f qemu-system-aarch64`
# returns 0 on a perfectly running guest, which is its own way to mislead: an
# earlier check read the guest as absent for that reason. Match either name.
guest_pid() {
  pgrep -f "qemu-aarch64-softmmu|qemu-system-aarch64" 2>/dev/null | head -1
}

# Cumulative CPU seconds consumed by the guest, as an integer.
#
# The awk wrapper is `int(...)` because macOS `ps -o time=` emits `SS.ss` when
# fractional seconds are present. Without it, `[ "$CUR" -gt "$LAST" ]` fails with
# "integer expression expected" - an error that is currently harmless (the
# comparison is false either way) but is undefined behavior to rely on.
cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | tr -d ' ' | awk -F: '{
    if (NF==3) print int(($1*3600)+($2*60)+$3);
    else if (NF==2) print int(($1*60)+$2);
    else print int($1+0)
  }'
}

# One SSH round trip. `echo ok`, never `true`: the guest's shell is PowerShell,
# which has no `true`. `tr -d '\r'` for the CRLF reason given at the probe below.
ssh_answers() {
  [ "$(ssh -F "$CFG" -o BatchMode=yes -o ConnectTimeout=10 myco-win11 'echo ok' 2>/dev/null | tr -d '\r' || true)" = "ok" ]
}

# Called after the first answer. Exits 0 once STABLE_PROBES consecutive probes
# answer; exits 1, naming the drops, if sshd keeps dropping or time runs out.
wait_stable() {
  local oks=1 drops=0
  while [ "$oks" -lt "$STABLE_PROBES" ]; do
    if [ $(( $(date +%s) - START )) -gt "$T" ]; then
      echo "wait-guest-ready: timeout after ${T}s: ssh answered but never held for ${STABLE_PROBES} consecutive probes (${drops} drop(s)); sshd unstable - guest or UTM unhealthy (TIF-220)" >&2
      exit 1
    fi
    sleep "$STABLE_SPACING"
    if ssh_answers; then
      oks=$(( oks + 1 ))
    else
      drops=$(( drops + 1 ))
      oks=0
      if [ "$drops" -ge "$MAX_DROPS" ]; then
        echo "wait-guest-ready: ssh answered, then dropped ${drops} times; sshd is not settling - guest or UTM unhealthy, not a boot blip (TIF-220)" >&2
        exit 1
      fi
      echo "wait-guest-ready: ssh dropped after answering (drop ${drops}/${MAX_DROPS}); sshd still settling after boot, re-probing (TIF-220)" >&2
    fi
  done
  echo "wait-guest-ready: ssh up after $(( $(date +%s) - START ))s, stable for ${STABLE_PROBES} consecutive probes ${STABLE_SPACING}s apart (guest CPU ${CUR}s)"
  exit 0
}

START=$(date +%s)
PID=""
until PID=$(guest_pid) && [ -n "$PID" ]; do
  [ $(( $(date +%s) - START )) -gt "$T" ] && { echo "wait-guest-ready: timeout: no qemu process after ${T}s" >&2; exit 1; }
  sleep "$INTERVAL"
done

# Watch CPU time advance. A guest that is paused or stuck in early UEFI stays
# flat; a booting one gains seconds every interval.
LAST=$(cpu_seconds "$PID")
FIRST=$LAST
FLAT=0
# A booting guest must show at least one CPU advance before SSH alone can be
# trusted. Without this, a flat-CPU guest whose sshd still answers passes in
# 10s - which is the TIF-164 shape exactly, since the unreliable signal there
# was SSH. This is the AND the comment below promises.
SEEN_PROGRESS=0
while :; do
  NOW=$(date +%s)
  if [ $(( NOW - START )) -gt "$T" ]; then
    echo "wait-guest-ready: timeout after ${T}s: guest pid $PID consumed ${LAST}s CPU and has not booted (status may still claim 'started'; see TIF-164)" >&2
    exit 1
  fi
  sleep "$INTERVAL"
  CUR=$(cpu_seconds "$PID")
  if [ -z "$CUR" ]; then
    echo "wait-guest-ready: guest pid $PID disappeared while waiting" >&2
    exit 1
  fi
  # Progress resumes the flat-run counter; three consecutive flat intervals with
  # a live process is a stall, not a slow boot.
  if [ "$CUR" -gt "$LAST" ]; then
    FLAT=0
    # Progress counts only once the cumulative gain since the first sample has
    # reached MIN_DELTA, so a lone blip cannot satisfy the AND on its own.
    if [ $(( CUR - FIRST )) -ge "$MIN_DELTA" ]; then
      SEEN_PROGRESS=1
    fi
  else
    FLAT=$(( FLAT + 1 ))
    if [ "$FLAT" -ge 3 ]; then
      # Report the cumulative gain, not just the current reading: a guest that
      # advanced 0.6s has integer-truncated samples showing as "flat at 0s",
      # which reads as "no CPU at all" and misdescribes what was measured.
      echo "wait-guest-ready: guest pid $PID CPU flat for 3 intervals (gained $(( CUR - FIRST ))s of the ${MIN_DELTA}s needed) - not booting (TIF-164). UTM status may still report 'started'; do not trust it." >&2
      exit 1
    fi
  fi
  LAST=$CUR
  # Boot is confirmed once CPU has advanced AND SSH answers. The `SEEN_PROGRESS`
  # guard is what makes that an AND: SSH answering on its own is not evidence of
  # a boot, because a stalled guest's sshd can still respond while the guest
  # itself is not executing.
  #
  # `tr -d '\r'` is load-bearing, not tidiness. The guest's default shell is
  # PowerShell, which terminates lines with CRLF. Command substitution strips the
  # trailing `\n` and leaves the `\r`, so the capture is the three bytes `ok\r`
  # and `[ "$v" = "ok" ]` can NEVER match - the gate then ignores SEEN_PROGRESS
  # and runs to its full timeout, reporting a booting guest as dead. That is what
  # happened on 2026-11-23, and it is why wait-ssh.sh has always worked beside it:
  # that one compares with `ssh ... | grep -q ok`, which tolerates the CR.
  #
  # The repo already strips CR this way at reset-trial-vm.sh:49, so this is the
  # house idiom rather than a new one.
  #
  # The first answer is not the end: wait_stable (TIF-220) then requires the
  # answer to hold. It runs outside this CPU loop on purpose - an idle, fully
  # booted guest can gain under 1s of CPU per interval, and the flat-CPU check
  # must not misread that as a stall while we are only checking sshd.
  if [ "$SEEN_PROGRESS" = "1" ] && ssh_answers; then
    wait_stable
  fi
done
