#!/usr/bin/env bash
# load-gate-sample.sh: sample host load, the guest's own QEMU CPU share and host
# memory pressure, one JSON line per sample (TIF-218).
#
# usage: load-gate-sample.sh <out.jsonl> <state> <seconds> [interval_s]
#   Appends a line every interval_s (default 15) for <seconds>, or until SIGTERM.
#   Read-only on the host: it reads sysctl, vm_stat, memory_pressure and a
#   names-only process table (pid, %cpu, executable path; never arguments or
#   environment). It never touches the VM or the VM lock.
#
# Fields per line:
#   ts_utc, state, ncpu
#   load1                 host 1-minute load average
#   qemu_pcpu             sum of %cpu over processes whose executable is QEMULauncher
#                         (UTM's guest process); 100 = one core
#   qemu_procs            how many such processes were seen
#   swap_used_mb, swap_free_mb
#   mem_free_pct          `memory_pressure -Q` system-wide memory free percentage
#   pageins, pageouts, swapins, swapouts   vm_stat cumulative counters (pages)
set -uo pipefail

OUT=${1:?usage: load-gate-sample.sh <out.jsonl> <state> <seconds> [interval_s]}
STATE=${2:?state}
SECS=${3:?seconds}
STEP=${4:-15}
NCPU=$(sysctl -n hw.ncpu)

stop=0
trap 'stop=1' TERM INT

sample() {
  local load1 qemu swap used free mem vm
  load1=$(sysctl -n vm.loadavg | awk '{print $2}')
  qemu=$(ps -Ao pid=,pcpu=,comm= | awk '{c=$2; $1=""; $2=""; sub(/^ +/, ""); n=split($0, a, "/");
          if (a[n] == "QEMULauncher") { s += c; k++ } } END { printf "%.1f %d", s, k }')
  swap=$(sysctl -n vm.swapusage)
  # -n ... p: an unexpected format gives an empty value, written as null (valid JSON).
  used=$(sed -nE 's/.*used = ([0-9.]+)M.*/\1/p' <<<"$swap")
  free=$(sed -nE 's/.*free = ([0-9.]+)M.*/\1/p' <<<"$swap")
  mem=$(memory_pressure -Q 2>/dev/null | sed -nE 's/.*free percentage: ([0-9]+)%.*/\1/p')
  vm=$(vm_stat | awk -F: '/^Pageins/{i=$2} /^Pageouts/{o=$2} /^Swapins/{si=$2} /^Swapouts/{so=$2}
        END { gsub(/[ .]/, "", i); gsub(/[ .]/, "", o); gsub(/[ .]/, "", si); gsub(/[ .]/, "", so); print i, o, si, so }')
  # shellcheck disable=SC2086  # intended split into positional fields
  set -- $qemu $vm
  printf '{"ts_utc":"%s","state":"%s","ncpu":%s,"load1":%s,"qemu_pcpu":%s,"qemu_procs":%s,"swap_used_mb":%s,"swap_free_mb":%s,"mem_free_pct":%s,"pageins":%s,"pageouts":%s,"swapins":%s,"swapouts":%s}\n' \
    "$(date -u +%FT%TZ)" "$STATE" "$NCPU" "$load1" "$1" "$2" "${used:-null}" "${free:-null}" "${mem:-null}" "$3" "$4" "$5" "$6" >> "$OUT"
}

end=$(( $(date +%s) + SECS ))
while [ "$stop" = 0 ] && [ "$(date +%s)" -lt "$end" ]; do
  sample
  for _ in $(seq 1 "$STEP"); do [ "$stop" = 0 ] || break; sleep 1; done
done
