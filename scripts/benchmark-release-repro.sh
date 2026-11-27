#!/usr/bin/env bash
# Reproduce the false-completion grader from a release archive alone (track G, #613).
#
#   scripts/benchmark-release-repro.sh <archive.tar>
#
# Unpacks the archive into a new, empty directory (no clone, no node_modules), then runs,
# from there and with a bare environment (PATH only), the commands the bundle's RELEASE.md
# lists: every file against SHA256SUMS, the task set against its manifest, and the bundled
# grader over the reproduction requests, whose output must equal reproduce-expected.jsonl
# byte for byte. Also refuses an archive whose entries carry owner names or anything but
# plain files (tar -tv shows `0/0` and no extended headers). Exit 0 when all pass.
set -euo pipefail

archive="${1:?usage: benchmark-release-repro.sh <archive.tar>}"
test -f "$archive" || { echo "no such archive" >&2; exit 2; }
root="myco-false-completion-fc-v1"
work=$(mktemp -d "${TMPDIR:-/tmp}/myco-release-repro.XXXXXX")
trap 'rm -rf "$work"' EXIT

# Owners: every entry is a regular file owned by 0/0 with no user or group name. Listed
# WITHOUT --numeric-owner, so a stored name shows instead of the number: GNU tar lists
# `-rw-r--r-- 0/0 size ...`, bsdtar (macOS) `-rw-r--r--  0 0 0 size ...`, only when the
# header's user and group names are empty.
listing=$(tar -tvf "$archive")
if grep -Ev '^-rw-r--r-- +(0/0|[0-9]+ +0 +0) ' <<<"$listing" >/dev/null; then
  echo "archive has an entry that is not a 0644 regular file owned by 0/0" >&2
  exit 1
fi

tar -xf "$archive" -C "$work"
cd "$work/$root"
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
bare=(env -i "PATH=$PATH")
"${bare[@]}" "${sum[@]}" -c --quiet SHA256SUMS
"${bare[@]}" node scripts/benchmark-verify-bundle.ts benchmark/false-completion/fc-v1
"${bare[@]}" node scripts/benchmark-grade.ts reproduce-requests.jsonl >"$work/regraded.jsonl"
cmp "$work/regraded.jsonl" reproduce-expected.jsonl
echo "release reproduces: $(wc -l <reproduce-expected.jsonl | tr -d ' ') grade rows identical"
