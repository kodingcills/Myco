#!/usr/bin/env bash
# Creates the UTM QEMU VM "myco-win11" (aarch64, HVF, UEFI + TPM 2.0 + Secure Boot keys, NVMe disk,
# Drive order = boot order: the NVMe disk is first, so the empty disk falls through to the installer ISO on first boot,
# and after Setup's first reboot the firmware boots Windows Boot Manager from disk instead of re-running Setup.
# virtio-net in emulated/NAT mode with 127.0.0.1:2222 -> guest:22, ramfb display).
# Uses UTM's AppleScript interface via osascript (utmctl is blocked by macOS Automation/TCC outside a GUI-granted context).
set -euo pipefail
NAME=${NAME:-myco-win11}; CPUS=${CPUS:-6}; MEM=${MEM:-8192}; DISK_MB=${DISK_MB:-65536}; SSH_PORT=${SSH_PORT:-2222}
WINISO=${WINISO:-$(ls ${ISO_ROOT:-$HOME/VMs/iso}/Win11_*ARM64*.iso | head -1)}; SEED=${SEED:-${VM_ROOT:-$HOME/VMs/myco-win11}/seed.iso}
osascript <<OSA
tell application "UTM"
  if exists (virtual machine named "$NAME") then error "VM $NAME already exists"
  set winiso to POSIX file "$WINISO"
  set seediso to POSIX file "$SEED"
  set vm to make new virtual machine with properties {backend:qemu, configuration:{name:"$NAME", icon:"windows-11", notes:"Myco M1 Windows 11 ARM64 test VM. See ~/VMs/myco-win11/README.md", architecture:"aarch64", machine:"virt", memory:$MEM, cpu cores:$CPUS, hypervisor:true, uefi:true, tpm:true, rng device:true, rtc local time:true, drives:{{interface:NVMe, guest size:$DISK_MB}, {removable:true, interface:USB, source:winiso}, {removable:true, interface:USB, source:seediso}}, network interfaces:{{hardware:"virtio-net-pci", mode:emulated, port forwards:{{protocol:TCP, host address:"127.0.0.1", host port:$SSH_PORT, guest address:"", guest port:22}}}}, displays:{{hardware:"ramfb"}}}}
  return id of vm
end tell
OSA
