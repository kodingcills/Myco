#!/usr/bin/env bash
# RT-013 (TIF-47): host memory discipline measurement.
#
# Why this exists: the post-M1 "second VM?" question (TIF-92) needs measured host
# cost, not a guess. This script is read-only — it samples `ps`/`vm_stat`/
# `vm.swapusage` and never starts, stops, snapshots, or locks any VM. In particular
# it never touches `myco-win11` beyond reading its process RSS.
#
# Run it with the guest up (the Myco Linux guest, the M1 Windows guest, or both) to
# record what each actually costs the host:
#
#   scripts/memory-budget.sh              # sample now, human-readable
#   scripts/memory-budget.sh --json       # same, machine-readable (for TIF-92)
#
# The numbers it reports are what a running guest commits, which is NOT the same as
# the `-m` cap it was configured with: both QEMU/UTM guests overcommit and grow into
# their cap lazily, so the cap is a ceiling and the RSS is the real charge at sample
# time. Report both; neither alone answers "can the host take a second VM?".
set -euo pipefail

JSON=0
[[ "${1:-}" == "--json" ]] && JSON=1

PAGE_SIZE=$(sysctl -n hw.pagesize)
HOST_MB=$(( $(sysctl -n hw.memsize) / 1048576 ))

# --- host-wide memory pressure -------------------------------------------------
# `vm_stat` pages are reported in units of the system page size. The awk emits one
# line of six numbers; `read` is guarded because a short read under `set -e` would
# otherwise abort the whole script (the fields are matched on label text, and a new
# macOS release renames a label at its peril).
VMSTAT_FIELDS=$(
  vm_stat | awk '
    /Pages free:/        { free=$3 }
    /Pages active:/      { active=$3 }
    /Pages inactive:/    { inactive=$3 }
    /Pages speculative:/ { spec=$3 }
    /Pages wired down:/  { wired=$4 }
    /compressor:/        { comp=$5 }
    END { gsub(/\./,"",free); gsub(/\./,"",active); gsub(/\./,"",inactive)
          gsub(/\./,"",spec); gsub(/\./,"",wired); gsub(/\./,"",comp)
          print free+0, active+0, inactive+0, spec+0, wired+0, comp+0 }'
)
read -r FREE ACTIVE INACTIVE SPECULATIVE WIRED COMPRESSED <<<"$VMSTAT_FIELDS" || true
to_mb() { echo $(( $1 * PAGE_SIZE / 1048576 )); }

FREE_MB=$(to_mb "$FREE"); ACTIVE_MB=$(to_mb "$ACTIVE"); INACTIVE_MB=$(to_mb "$INACTIVE")
SPEC_MB=$(to_mb "$SPECULATIVE"); WIRED_MB=$(to_mb "$WIRED"); COMP_MB=$(to_mb "$COMPRESSED")

# Reclaimable approximation: what the kernel could hand out under pressure without
# swapping. Deliberately conservative — it does NOT count compressed pages as free,
# because on this host they are the signal that pressure is already real.
RECLAIMABLE_MB=$(( FREE_MB + INACTIVE_MB + SPEC_MB ))

SWAP_LINE=$(sysctl -n vm.swapusage)
# Truncate to whole MB: these are used in shell arithmetic later, and a float
# silently breaks $(( )).
SWAP_TOTAL_MB=$(echo "$SWAP_LINE" | sed -n 's/.*total = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
SWAP_USED_MB=$(echo "$SWAP_LINE" | sed -n 's/.*used = \([0-9.]*\)M.*/\1/p' | cut -d. -f1)
SWAP_TOTAL_MB=${SWAP_TOTAL_MB:-0}; SWAP_USED_MB=${SWAP_USED_MB:-0}

# --- per-guest RSS -------------------------------------------------------------
# Match the two QEMU process trees this repo can have running. UTM wraps its QEMU in
# a QEMULauncher helper; both the launcher and the helper's child carry the guest's
# RSS, so sum the whole family per guest and report the largest single process too.
guest_rss_mb() {
  # $1 = a grep -E pattern matching the guest's qemu command line.
  # `|| true` because an absent guest means grep finds nothing, and under
  # `set -o pipefail` that nonzero would abort the script instead of reporting 0.
  {
    ps -Ao pid,rss,command | grep -E "$1" | grep -v grep | awk '
      { sum += $2; if ($2 > max) { max = $2 } }
      END { printf "%.0f %.0f\n", sum/1024, max/1024 }'
  } || echo "0 0"
}

# Guarded reads: an absent guest yields empty output, and `read` returning nonzero
# under `set -e` would abort the script exactly when there is nothing running — the
# case a memory budget most wants to report.
MYCO_RSS=$(guest_rss_mb 'qemu-system-aarch64')
WIN_RSS=$(guest_rss_mb 'myco-win11\.utm|QEMULauncher.*myco-win11')
read -r MYCO_SUM MYCO_MAX <<<"${MYCO_RSS:-0 0}" || true
read -r WIN_SUM WIN_MAX <<<"${WIN_RSS:-0 0}" || true
MYCO_SUM=${MYCO_SUM:-0}; MYCO_MAX=${MYCO_MAX:-0}
WIN_SUM=${WIN_SUM:-0}; WIN_MAX=${WIN_MAX:-0}

# --- configured caps (read from the command line, not assumed) ------------------
# `-m <MB>` is the hard cap each guest was started with.
guest_cap_mb() {
  ps -Ao command | grep -E "$1" | grep -v grep \
    | grep -oE '(^| )-m [0-9]+' | head -1 | grep -oE '[0-9]+' || echo 0
}
MYCO_CAP_MB=$(guest_cap_mb 'qemu-system-aarch64' || true)
WIN_CAP_MB=$(guest_cap_mb 'myco-win11\.utm|QEMULauncher.*myco-win11' || true)
MYCO_CAP_MB=${MYCO_CAP_MB:-0}; WIN_CAP_MB=${WIN_CAP_MB:-0}

# --- verdict for the second-VM question ----------------------------------------
# A second VM of the same class as the Myco guest needs, at minimum, its RSS as
# headroom (the cap is a lazy ceiling, so RSS is the honest near-term charge). If
# swap is already used, say so — that is the pressure signal, not free pages.
SECOND_VM_MB=$(( MYCO_SUM > 2048 ? MYCO_SUM : 2048 ))   # next guest ≥ 2 GB committed
HEADROOM_MB=$(( RECLAIMABLE_MB - SECOND_VM_MB ))

if [[ $JSON -eq 1 ]]; then
  cat <<EOF
{
  "host_total_mb": $HOST_MB,
  "host_free_mb": $FREE_MB,
  "host_active_mb": $ACTIVE_MB,
  "host_inactive_mb": $INACTIVE_MB,
  "host_speculative_mb": $SPEC_MB,
  "host_wired_mb": $WIRED_MB,
  "host_compressed_mb": $COMP_MB,
  "host_reclaimable_mb": $RECLAIMABLE_MB,
  "swap_total_mb": ${SWAP_TOTAL_MB:-0},
  "swap_used_mb": ${SWAP_USED_MB:-0},
  "myco_linux_guest": { "rss_sum_mb": $MYCO_SUM, "rss_max_proc_mb": $MYCO_MAX, "cap_mb": $MYCO_CAP_MB },
  "windows_guest":    { "rss_sum_mb": $WIN_SUM,  "rss_max_proc_mb": $WIN_MAX,  "cap_mb": $WIN_CAP_MB },
  "second_vm_estimate_mb": $SECOND_VM_MB,
  "second_vm_headroom_mb": $HEADROOM_MB
}
EOF
  exit 0
fi

cat <<EOF
Host: ${HOST_MB} MB total
  free ${FREE_MB} MB · inactive ${INACTIVE_MB} MB · speculative ${SPEC_MB} MB
  active ${ACTIVE_MB} MB · wired ${WIRED_MB} MB · compressed ${COMP_MB} MB
  reclaimable (free+inactive+spec) ${RECLAIMABLE_MB} MB
Swap: ${SWAP_USED_MB:-0} MB used of ${SWAP_TOTAL_MB:-0} MB

Myco Linux guest : RSS ${MYCO_SUM} MB (largest proc ${MYCO_MAX} MB), cap ${MYCO_CAP_MB} MB
Windows guest    : RSS ${WIN_SUM} MB (largest proc ${WIN_MAX} MB), cap ${WIN_CAP_MB} MB

Second-VM (${SECOND_VM_MB} MB committed) headroom: ${HEADROOM_MB} MB reclaimable
EOF

if (( SWAP_USED_MB > 1024 )); then
  echo "NOTE: swap already in use — the host is under pressure now, before any second VM."
fi
