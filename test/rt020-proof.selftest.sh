#!/usr/bin/env bash
# VM-free self-test of scripts/rt020-proof.py against a stub MCP server.
set -u
here="$(cd "$(dirname "$0")/.." && pwd)"
stub="python3 $here/test/fake_mcp.py"
fail=0
python3 "$here/scripts/rt020-proof.py" --server-cmd "$stub" >/dev/null || { echo "FAIL: happy path"; fail=1; }
log="$(mktemp)"
FAKE_LOG="$log" FAKE_FAIL=evidence python3 "$here/scripts/rt020-proof.py" --server-cmd "$stub" >/dev/null \
  && { echo "FAIL: broken evidence not detected"; fail=1; }
grep -q destroy "$log" || { echo "FAIL: no cleanup destroy after failure"; fail=1; }
: > "$log"
FAKE_LOG="$log" FAKE_FAIL=reset python3 "$here/scripts/rt020-proof.py" --server-cmd "$stub" >/dev/null \
  && { echo "FAIL: broken reset not detected"; fail=1; }
grep -q destroy "$log" || { echo "FAIL: no cleanup destroy after failed reset"; fail=1; }
rm -f "$log"
python3 "$here/scripts/rt020-proof.py" >/dev/null 2>&1 && { echo "FAIL: ran a VM without --go"; fail=1; }
[ "$fail" = 0 ] && echo "rt020-proof selftest OK"
exit "$fail"
