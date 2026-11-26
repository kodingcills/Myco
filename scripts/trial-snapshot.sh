#!/usr/bin/env bash
# trial-snapshot.sh: which snapshot a trial driver resets to, pinned per $OUT
# (TIF-98). Source it from scripts/m1-sweep.sh and scripts/m1-corrupt-suite.sh.
#
# Why: the default trial snapshot moved from clean-base to trial-base-v2. A
# sweep resumed after a load pause, or after the switch, must not silently mix
# the two, and every row must say which snapshot its trial ran on.
#
#   ts_resolve
#       Print the snapshot this run uses: $MYCO_TRIAL_SNAPSHOT, else
#       trial-base-v2. Refuses (rc 11), with the reason on stderr:
#         - MYCO_COMPARISON_RUN set to anything but empty, 0 or 1 (a typo such
#           as `true` must not silently mean "not a comparison");
#         - a snapshot that is not a Myco trial base (trial-base-v2 or
#           clean-base), so a typo fails here, at pin time, not on every trial.
#           That also refuses *-live (the live path wedges UTM under rapid
#           cycling, runbook §3.3) and cua-c1-base (the baseline arms' base);
#         - a comparison run (MYCO_COMPARISON_RUN=1) that does not explicitly
#           set MYCO_TRIAL_SNAPSHOT=clean-base. The baseline arms (C1/C2:
#           cua-c1-base) are clean-base derivatives, and both arms of a
#           comparison must start from the same base (m1-state acceptance #7;
#           docs/baseline/screenshot-agent.md §2). There is no trial-base-v2
#           derivative for the baseline arms yet.
#   ts_pin <out_dir> <trials.jsonl> <snapshot>
#       First run: write <snapshot> to <out_dir>/snapshot. Resume: refuse
#       (rc 11) unless it matches. A symlink at <out_dir>/snapshot is refused
#       (never written through). An existing <trials.jsonl> with rows but no
#       pin file was started before pinning existed, on clean-base (the only
#       default then): refuse unless MYCO_TRIAL_SNAPSHOT=clean-base, then pin
#       that.
#   ts_reset <snapshot> <progress.log>
#       Run the reset with the snapshot named explicitly, append its output to
#       the progress log, set TS_BOOT to the reset's cold-boot record
#       (class:first_ssh_s:guest_cpu_first_ssh_s:total_s:attempts, TIF-98; empty if
#       the reset printed none), and set TS_READY to the snapshot its
#       `reset-trial-vm: ready on '<snap>'` line names (empty if none). Returns
#       the reset's status, or 12 if it reported ready on a different snapshot.
#       MYCO_RESET_SCRIPT overrides the reset script (tests only).
#
# Every message goes to stderr; callers append it to their progress log.

ts_resolve() {
  local snap=${MYCO_TRIAL_SNAPSHOT:-trial-base-v2}
  case "${MYCO_COMPARISON_RUN:-}" in
    ''|0|1) ;;
    *)
      echo "REFUSED_SNAPSHOT: MYCO_COMPARISON_RUN='${MYCO_COMPARISON_RUN}' is not empty, 0 or 1" >&2
      return 11 ;;
  esac
  case "$snap" in
    trial-base-v2|clean-base) ;;
    *)
      echo "REFUSED_SNAPSHOT: MYCO_TRIAL_SNAPSHOT='$snap' is not a Myco trial base (trial-base-v2 or clean-base); live snapshots and the baseline arms' cua-c1-base are never a sweep's base (runbook §3.3, §3.5)" >&2
      return 11 ;;
  esac
  if [ "${MYCO_COMPARISON_RUN:-}" = 1 ] && [ "${MYCO_TRIAL_SNAPSHOT:-}" != clean-base ]; then
    echo "REFUSED_SNAPSHOT: a comparison run (MYCO_COMPARISON_RUN=1) must set MYCO_TRIAL_SNAPSHOT=clean-base: the baseline arms run on cua-c1-base, a clean-base derivative, and both arms must start from the same base (docs/baseline/screenshot-agent.md §2)" >&2
    return 11
  fi
  printf '%s\n' "$snap"
}

ts_pin() {
  local out=$1 log=$2 snap=$3 pinned
  if [ -L "$out/snapshot" ]; then
    echo "REFUSED_SNAPSHOT_PIN: $out/snapshot is a symlink; the pin is never written or read through one" >&2
    return 11
  fi
  if [ -f "$out/snapshot" ]; then
    pinned=$(tr -d '\r\n' < "$out/snapshot")
    if [ "$pinned" != "$snap" ]; then
      echo "REFUSED_SNAPSHOT_MISMATCH: $out was started on '$pinned', this run resolves '$snap'; resume with MYCO_TRIAL_SNAPSHOT=$pinned, or start a fresh OUT" >&2
      return 11
    fi
    return 0
  fi
  # A pin that was deleted: the rows already record their snapshot (#529 S4). Re-pin only when
  # every recorded snapshot is the one this run resolves; anything else would mix bases.
  local recorded
  recorded=$( { grep -oE '"snapshot": "[^"]+"' "$log" 2>/dev/null || true; } | sort -u)
  if [ -n "$recorded" ]; then
    if [ "$recorded" != "\"snapshot\": \"$snap\"" ]; then
      echo "REFUSED_SNAPSHOT_PIN_DELETED: $out has no pin but its rows record $(printf '%s' "$recorded" | tr '\n' ' ')and this run resolves '$snap'; restore the pin or start a fresh OUT" >&2
      return 11
    fi
    printf '%s\n' "$snap" > "$out/snapshot"
    return 0
  fi
  if [ -s "$log" ] && [ "${MYCO_TRIAL_SNAPSHOT:-}" != clean-base ]; then
    echo "REFUSED_SNAPSHOT_UNKNOWN: $log has rows but $out has no snapshot pin, so it was started before 2026-11-26, on clean-base; resume it with MYCO_TRIAL_SNAPSHOT=clean-base, or start a fresh OUT" >&2
    return 11
  fi
  printf '%s\n' "$snap" > "$out/snapshot"
}

ts_reset() {
  local snap=$1 progress=$2 script=${MYCO_RESET_SCRIPT:-scripts/reset-trial-vm.sh} capture rc
  capture=$(mktemp "${TMPDIR:-/tmp}/trial-reset.XXXXXX") || return 1
  bash "$script" "$snap" > "$capture" 2>&1
  rc=$?
  cat "$capture" >> "$progress"
  TS_READY=$(sed -n "s/^reset-trial-vm: ready on '\\([^']*\\)'\$/\\1/p" "$capture" | tail -n 1)
  # TIF-98 cold-boot record for the row: class:first_ssh_s:guest_cpu_first_ssh_s:total_s:attempts,
  # from the reset's `boot class=...` and `timing ... total=` lines (empty when either is missing).
  local boot total
  boot=$(sed -nE 's/^reset-trial-vm: boot class=([a-z]+) first_ssh_s=([0-9]+) guest_cpu_first_ssh_s=([0-9]+) attempts=([0-9]+)$/\1:\2:\3:\4/p' "$capture" | tail -n 1)
  total=$(sed -nE 's/^reset-trial-vm: timing .* total=([0-9]+)$/\1/p' "$capture" | tail -n 1)
  TS_BOOT=""
  if [ -n "$boot" ] && [ -n "$total" ]; then
    TS_BOOT="${boot%:*}:$total:${boot##*:}"
  fi
  rm -f "$capture"
  [ "$rc" -eq 0 ] || return "$rc"
  if [ "$TS_READY" != "$snap" ]; then
    echo "SNAPSHOT_READY_MISMATCH: asked for '$snap', the reset reported ready on '${TS_READY:-nothing}'" >&2
    return 12
  fi
  return 0
}

# ts_boot_json <class:first_ssh_s:guest_cpu_s:total_s:attempts or empty>
#   The reset boot record as JSON members for a hand-written row, null when absent
#   (#546 round 1 nit 1: every row carries the keys).
ts_boot_json() {
  local v=${1:-} c f g t a
  IFS=: read -r c f g t a <<< "$v"
  if [ -n "$v" ] && [[ "$c" =~ ^(cold|fast)$ ]] && [[ "$f$g$t$a" =~ ^[0-9]+$ ]] && [ -n "$a" ]; then
    printf '"resetBootClass": "%s", "resetFirstSshS": %s, "resetGuestCpuFirstSshS": %s, "resetTotalS": %s, "resetBootAttempts": %s' "$c" "$f" "$g" "$t" "$a"
  else
    printf '"resetBootClass": null, "resetFirstSshS": null, "resetGuestCpuFirstSshS": null, "resetTotalS": null, "resetBootAttempts": null'
  fi
}
