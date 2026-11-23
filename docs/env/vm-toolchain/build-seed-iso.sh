#!/usr/bin/env bash
# Builds ~/VMs/myco-win11/seed.iso: autounattend.xml + first-logon script + SSH pubkey + ARM64 drivers + guest tools + offline installers.
# The password is read from credentials.txt and never printed. seed.iso is chmod 600 because it contains it.
set -euo pipefail
VM=~/VMs/myco-win11; S=$VM/scripts; GT=~/VMs/iso/dl/utm-guest-tools-latest.iso; PAY=~/VMs/iso/payload
[ -f $VM/credentials.txt ] || { echo "missing credentials.txt"; exit 1; }
PW=$(awk -F': ' '/^password:/{print $2}' $VM/credentials.txt)
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT; chmod 700 "$W"; R=$W/root; mkdir -p $R/payload
PW="$PW" python3 - "$S/seed/autounattend.xml.tmpl" "$R/autounattend.xml" <<'PY'
import os,sys; from xml.sax.saxutils import escape
t=open(sys.argv[1]).read().replace('@@PASSWORD@@',escape(os.environ['PW'])).replace('@@HOSTNAME@@','MYCO-WIN11')
open(sys.argv[2],'w').write(t)
PY
cp $S/seed/firstlogon.ps1 $R/; cp $VM/id_ed25519.pub $R/myco_authorized_keys; echo myco > $R/myco-seed.marker
M=$(mktemp -d); hdiutil attach -quiet -nobrowse -readonly -mountpoint "$M" "$GT"
cp "$M"/utm-guest-tools-*.exe $R/
( cd "$M" && find Drivers -path '*/w11/ARM64/*' -type f -exec rsync -R {} $R/ \; )
hdiutil detach -quiet "$M"
cp $PAY/*.exe $PAY/*.msi $PAY/SOURCES.txt $R/payload/ 2>/dev/null || true
mkisofs -quiet -J -joliet-long -R -V MYCOSEED -o $VM/seed.iso $R
chmod 600 $VM/seed.iso; ls -la $VM/seed.iso
