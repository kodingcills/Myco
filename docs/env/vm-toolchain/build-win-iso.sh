#!/usr/bin/env bash
# Builds an official Windows 11 ARM64 ISO from Microsoft's Windows Update (UUP) servers via uupdump.net's scripts.
# Why not microsoft.com/software-download/windows11arm64? Its scripted download API answered
# "Sentinel marked this request as rejected" (Microsoft anti-automation; retrying risks an IP ban), so we use UUP files,
# which aria2 verifies against Microsoft-published SHA-1 hashes. Output: ~/VMs/iso/Win11_<build>_Pro_ARM64_en-US.iso
# Note: the macOS converter cannot integrate cumulative updates, so the ISO is the 26100.1 (24H2) base.
set -euo pipefail
UUID=${UUID:-59551cf9-c9f9-4ee9-965c-977653b57296}   # "Windows 11, version 25H2 (26200.10066) arm64" on uupdump.net
brew install aria2 cabextract wimlib cdrtools libgcrypt pkg-config
# chntpw: build from Debian's libgcrypt-ported source (the Homebrew tap needs untrusted openssl@1.0)
if [ ! -x ~/VMs/tools/bin/chntpw ]; then
  mkdir -p ~/VMs/tools/chntpw ~/VMs/tools/bin && cd ~/VMs/tools/chntpw
  B=https://deb.debian.org/debian/pool/main/c/chntpw
  curl -sLO $B/chntpw_140201.orig.tar.xz; curl -sLO $B/chntpw_140201-1.3.debian.tar.xz
  tar xf chntpw_140201.orig.tar.xz; cd chntpw-140201; tar xf ../chntpw_140201-1.3.debian.tar.xz
  for p in $(grep -v '^#' debian/patches/series); do patch -p1 -s < debian/patches/$p; done
  sed -i '' 's/ -m32//' Makefile; make CC=clang chntpw; cp chntpw ~/VMs/tools/bin/
fi
export PATH=~/VMs/tools/bin:$PATH
mkdir -p ~/VMs/iso/uup && cd ~/VMs/iso/uup
curl -sL -X POST -d "autodl=2&updates=1&cleanup=1" "https://uupdump.net/get.php?id=$UUID&pack=en-us&edition=professional" -o pkg.zip
unzip -o -q pkg.zip
aria2c --no-conf --console-log-level=warn -d files -i files/converter_multi --allow-overwrite=true --auto-file-renaming=false
# Optional patch (used for the current ISO): boot without "Press any key to boot from CD". Safe because create-vm.sh
# puts the NVMe disk first in boot order, so after Setup's first reboot the disk boots instead of the ISO.
grep -q MYCO files/convert.sh || sed -i '' '/^# Use mkisofs as fallback to genisoimage/i\
[ -f ISODIR/efi/microsoft/boot/efisys_noprompt.bin ] \&\& cp ISODIR/efi/microsoft/boot/efisys_noprompt.bin ISODIR/efi/microsoft/boot/efisys.bin \&\& echo "MYCO: using efisys_noprompt.bin"
' files/convert.sh
bash uup_download_macos.sh
ISO=$(ls *_PROFESSIONAL_ARM64_EN-US.ISO | head -1); B=${ISO%%_*}
mv "$ISO" ~/VMs/iso/Win11_${B}_Pro_ARM64_en-US.iso
cd ~/VMs/iso && shasum -a 256 Win11_${B}_Pro_ARM64_en-US.iso | tee Win11_${B}_Pro_ARM64_en-US.iso.sha256
