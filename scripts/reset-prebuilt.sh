#!/usr/bin/env bash
# M1-020: reset myco-win11 to the PRE-DEPLOYED snapshot, so a trial cycle skips
# the ~2 minute agent deploy. `clean-base-live` predates the agent install and
# costs reset (~45s) + deploy (~100-180s); `m1-agent-live` has the agent already
# running in session 1 and restores in ~19s.
#
# The snapshot is never modified. Re-take it (scripts/take-prebuilt-snapshot.sh)
# whenever the deployed agent changes, or the guest will run a stale build.
# usage: reset-prebuilt.sh [snapshot-name]
set -euo pipefail
NAME=${1:-m1-agent-live}
# VM control lives outside the repo on purpose; override when it moves.
VM_SCRIPTS=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
VM=${VM_NAME:-myco-win11}

"$VM_SCRIPTS/vm.sh" status | grep -q started && "$VM_SCRIPTS/vm.sh" kill
# Disks-only snapshots restore while the VM is stopped; the metadata load takes ~10s.
"$VM_SCRIPTS/vm.sh" restore "$NAME"
"$VM_SCRIPTS/vm.sh" start
"$VM_SCRIPTS/wait-ssh.sh" >/dev/null
