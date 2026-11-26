#!/usr/bin/env bash
# base-parity.sh: does the oracle read the same state on two trial bases?
# (TIF-98 follow-up: clean-base vs trial-base-v2.) Free: run-live drives a
# scripted Calc program; no model is called.
#
# usage (straight after `lsof /tmp/myco-win11.vm.lock || echo free` prints free):
#   MYCO_TOKEN_OUT=<private token path> \
#   scripts/vm-session.sh -- scripts/base-parity.sh <out-dir> <base> [<base> ...]
#
# For each base: reset onto it (egress check included), deploy (hash-verified),
# session_info, then M1 Calc trials with fixed seeds: N clean (`--mode normal`)
# and one corrupted control (`--mode kill --kill-after-step 3`). Each trial's
# JSON report goes to <out-dir>/<base>/<label>.json; scripts/base-parity-compare.py
# then compares what the oracle read per seed across bases.
set -uo pipefail

OUT=${1:?usage: base-parity.sh <out-dir> <base> [<base> ...]}
shift
[ "$#" -ge 1 ] || { echo "base-parity: name at least one base" >&2; exit 2; }
[ -n "${MYCO_TOKEN_OUT:-}" ] || { echo "base-parity: set MYCO_TOKEN_OUT (runbook §4)" >&2; exit 2; }
REPO=$(cd "$(dirname "$0")/.." && pwd)
SEEDS=${MYCO_PARITY_SEEDS:-m1-013-trial-01 m1-013-trial-02 m1-013-trial-03}
cd "$REPO" || exit 2

source scripts/vm-lock.sh
vm_lock_owned_by_parent || { echo "base-parity: run me under scripts/vm-session.sh" >&2; exit 2; }

rc=0
for base in "$@"; do
  d="$OUT/$base"
  mkdir -p "$d"
  echo "base-parity: == $base"
  bash scripts/reset-trial-vm.sh "$base" > "$d/reset.log" 2>&1 || { echo "base-parity: reset onto $base failed" >&2; exit 1; }
  bash agent/bootstrap/deploy-to-vm.sh > "$d/deploy.log" 2>&1 || { echo "base-parity: deploy on $base failed" >&2; exit 1; }
  node --import tsx src/integration/session-info.ts --token-file "$MYCO_TOKEN_OUT" > "$d/session-info.json" 2> "$d/session-info.err" \
    || { echo "base-parity: session_info on $base failed" >&2; exit 1; }
  for seed in $SEEDS; do
    node --import tsx src/integration/run-live.ts --mode normal --seed "$seed" --runs-dir "$d/runs" \
      --token-file "$MYCO_TOKEN_OUT" > "$d/normal-$seed.json" 2> "$d/normal-$seed.err"
    echo "base-parity: $base normal $seed exit=$?"
  done
  first=${SEEDS%% *}
  node --import tsx src/integration/run-live.ts --mode kill --kill-after-step 3 --seed "$first" --runs-dir "$d/runs" \
    --token-file "$MYCO_TOKEN_OUT" > "$d/kill-$first.json" 2> "$d/kill-$first.err"
  k=$?
  echo "base-parity: $base kill $first exit=$k"
  # Kill mode exits 1 on a verified verdict: a false success. Stop the line.
  [ "$k" = 1 ] && { echo "base-parity: FALSE SUCCESS on $base corrupted control; stopping" >&2; rc=1; break; }
done
exit "$rc"
