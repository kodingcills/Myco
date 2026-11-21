#!/usr/bin/env bash
# Re-take the pre-deployed reset snapshot after the deployed agent changes.
# Requires the agent to already be deployed and running in session 1
# (agent/bootstrap/deploy-to-vm.sh, then verify session_info shows session 1).
set -euo pipefail
NAME=${1:-m1-agent-live}
# VM control lives outside the repo on purpose; override when it moves.
VM_SCRIPTS=${MYCO_VM_SCRIPTS:-$HOME/VMs/myco-win11/scripts}
"$VM_SCRIPTS/vm.sh" snapshot "$NAME"
"$VM_SCRIPTS/vm.sh" snapshots
