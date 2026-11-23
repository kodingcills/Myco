#!/usr/bin/env bash
# Move the Windows system disk from NVMe to VirtIO (viostor). Required for LIVE snapshots:
# QEMU refuses to save running state while an emulated NVMe device is active.
# Windows Setup needs NVMe (no virtio driver in WinPE), so we install on NVMe and convert afterwards:
#  1) attach a temporary VirtIO disk so PnP installs viostor (from the UTM guest tools) as a boot-start driver
#  2) switch the system disk's interface to VirtIO and drop the temporary disk.
set -euo pipefail
D=$(dirname "$0"); NAME=${VM_NAME:-myco-win11}
"$D/shutdown.sh"
osascript <<OSA
tell application "UTM"
  set vm to virtual machine named "$NAME"
  set cfg to configuration of vm
  set d to drives of cfg
  set end of d to {interface:VirtIO, guest size:512}
  set drives of cfg to d
  update configuration of vm with cfg
end tell
OSA
"$D/vm.sh" start; "$D/wait-ssh.sh" 600; sleep 20
"$D/vssh" 'if ((Get-ItemProperty HKLM:\SYSTEM\CurrentControlSet\Services\viostor -EA Stop).Start -ne 0) { throw "viostor not boot-start" }; "viostor ok"'
"$D/shutdown.sh"
osascript <<OSA
tell application "UTM"
  set vm to virtual machine named "$NAME"
  set cfg to configuration of vm
  set d to drives of cfg
  set keep to {}
  set n to count of d
  repeat with i from 1 to n
    set x to item i of d
    if (removable of x) then
      set end of keep to x
    else if (interface of x is NVMe) then
      set interface of x to VirtIO
      set end of keep to x
    end if
    -- the temporary 512 MiB VirtIO disk (last, non-removable, already VirtIO) is dropped
  end repeat
  set drives of cfg to keep
  update configuration of vm with cfg
end tell
OSA
"$D/vm.sh" start; "$D/wait-ssh.sh" 300
"$D/vssh" 'Get-Disk | ft Number,FriendlyName,BusType,Size'
