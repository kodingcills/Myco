#!/usr/bin/env bash
# Full rebuild from nothing (about 45-60 min, mostly downloads). Assumes UTM installed (brew install --cask utm).
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd); VM=~/VMs/myco-win11
ls ~/VMs/iso/Win11_*ARM64*.iso >/dev/null 2>&1 || "$D/build-win-iso.sh"
# offline installers (checksums in payload/SOURCES.txt; Git + LibreOffice verified against publisher SHA-256)
[ -f ~/VMs/iso/dl/utm-guest-tools-latest.iso ] || { mkdir -p ~/VMs/iso/dl; curl -sL -o ~/VMs/iso/dl/utm-guest-tools-latest.iso https://getutm.app/downloads/utm-guest-tools-latest.iso; }
[ -f ~/VMs/iso/empty.iso ] || { mkdir -p /tmp/e && echo empty > /tmp/e/EMPTY.TXT && mkisofs -quiet -V EMPTY -o ~/VMs/iso/empty.iso /tmp/e; }
[ -f $VM/id_ed25519 ] || ssh-keygen -q -t ed25519 -N "" -C myco-win11 -f $VM/id_ed25519
[ -f $VM/credentials.txt ] || { umask 077; P=$(python3 -c "import secrets,string;a=string.ascii_letters+string.digits;print('My'+''.join(secrets.choice(a) for _ in range(20))+'!7')"); printf 'VM: myco-win11\nuser: myco\npassword: %s\n' "$P" > $VM/credentials.txt; }
"$D/build-seed-iso.sh"
"$D/create-vm.sh"
"$D/vm.sh" start
"$D/wait-ssh.sh" 3600                         # unattended Setup + OOBE + first-logon script
# new VMs: drive 1 = NVMe system disk, 2 = installer ISO, 3 = seed ISO (has the offline payload and the password).
# The seed stays attached for provisioning and is ejected before snapshotting.
scp -q -F $VM/ssh_config -o LogLevel=ERROR "$D"/guest/* myco-win11:C:/myco/bin/
"$D/vssh" 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\myco\bin\provision.ps1'
"$D/vssh" 'C:\myco\bin\smoke.ps1'
"$D/shutdown.sh"; "$D/set-cd.sh" 2 ~/VMs/iso/empty.iso; "$D/set-cd.sh" 3 ~/VMs/iso/empty.iso
"$D/convert-disk-virtio.sh"
"$D/vssh" 'Remove-Item -Recurse -Force C:\myco\smoke, C:\myco\lo-headless-profile -EA 0'
"$D/shutdown.sh"; "$D/vm.sh" snapshot clean-base
"$D/vm.sh" start; "$D/wait-ssh.sh" 600; sleep 45; "$D/vm.sh" snapshot clean-base-live
"$D/vm.sh" snapshots
