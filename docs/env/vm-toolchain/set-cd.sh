#!/usr/bin/env bash
# set-cd.sh <drive-number> <iso-path>: swap the image in removable drive N (new VMs: 1 = NVMe disk, 2 = installer ISO, 3 = seed ISO; the original myco-win11 was built with 1 = installer, 2 = seed, 3 = disk). VM must be stopped.
set -euo pipefail
N=$1; ISO=$2; NAME=${VM_NAME:-myco-win11}
osascript <<OSA
tell application "UTM"
  set vm to virtual machine named "$NAME"
  set cfg to configuration of vm
  set d to drives of cfg
  set dr to item $N of d
  set source of dr to (POSIX file "$ISO")
  set item $N of d to dr
  set drives of cfg to d
  update configuration of vm with cfg
end tell
OSA
osascript -e "tell application \"UTM\"" -e "set c to configuration of virtual machine named \"$NAME\"" -e "return source of item $N of (drives of c)" -e "end tell"
