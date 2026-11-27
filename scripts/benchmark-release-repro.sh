#!/usr/bin/env bash
# Reproduce the false-completion grader from a release archive alone (track G, #613).
#
#   scripts/benchmark-release-repro.sh <archive.tar>
#
# First reads the archive's raw tar headers (scripts/benchmark-release-check-archive.ts, not a
# `tar -tv` listing, which applies pax headers silently): it refuses any entry that is not a
# plain ustar regular file (a pax `x`/`g` header such as an xattr record, a GNU `L`/`K` header,
# a directory or link), mode other than 0644, uid or gid other than 0, an owner or group name,
# and any entry SHA256SUMS does not list. Then unpacks the archive into a new, empty directory
# (no clone, no node_modules) and runs, from there and with a bare environment (PATH only),
# the commands the bundle's RELEASE.md lists: every file against SHA256SUMS, the task set
# against its manifest (the bundled verifier), and the bundled grader over the reproduction
# requests, whose output must equal reproduce-expected.jsonl byte for byte. Exit 0 when all pass.
set -euo pipefail

archive="${1:?usage: benchmark-release-repro.sh <archive.tar>}"
test -f "$archive" || { echo "no such archive" >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root="myco-false-completion-fc-v1"
work=$(mktemp -d "${TMPDIR:-/tmp}/myco-release-repro.XXXXXX")
trap 'rm -rf "$work"' EXIT
bare=(env -i "PATH=$PATH")

"${bare[@]}" node "$here/benchmark-release-check-archive.ts" "$archive" "$root"

tar -xf "$archive" -C "$work"
cd "$work/$root"
if command -v sha256sum >/dev/null; then sum=(sha256sum); else sum=(shasum -a 256); fi
"${bare[@]}" "${sum[@]}" -c --quiet SHA256SUMS
"${bare[@]}" node scripts/benchmark-verify-bundle.ts benchmark/false-completion/fc-v1
"${bare[@]}" node scripts/benchmark-grade.ts reproduce-requests.jsonl >"$work/regraded.jsonl"
cmp "$work/regraded.jsonl" reproduce-expected.jsonl
echo "release reproduces: $(wc -l <reproduce-expected.jsonl | tr -d ' ') grade rows identical"
