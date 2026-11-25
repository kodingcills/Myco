#!/usr/bin/env bash
# Mutation proofs for the gate (TIF-265). Not run in CI: it edits src/gate in place and
# restores it on exit. Each mutant must make `vitest run test/gate` fail; the script
# exits 0 only when every mutant is caught and the restored tree passes.
#
#   m1: the gate returns `verified` when the oracle refuses.
#   m2: the gate accepts agent-supplied oracle input (request fields flow into the spec).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
if ! git diff --quiet -- src/gate; then
  echo "gate-mutation-proof: src/gate has uncommitted changes; commit or discard them first" >&2
  exit 3
fi
restore() { git checkout -- src/gate; }
trap restore EXIT

mutate() {
  python3 - "$1" <<'EOF'
import sys
which = sys.argv[1]
def edit(path, old, new):
    s = open(path).read()
    assert old in s, f"{path}: anchor not found: {old!r}"
    open(path, "w").write(s.replace(old, new))
if which == "m1":
    edit("src/gate/gate.ts",
         'return { verdict: "refuted", code: "ORACLE_FAIL" };',
         'return { verdict: "verified", code: "ORACLE_PASS" };')
elif which == "m2":
    edit("src/gate/api.ts", "if (oracleInputs.length > 0) {", "if (false) {")
    edit("src/gate/api.ts", "if (unknown.length > 0) {", "if (false) {")
    edit("src/gate/api.ts", "  const request: GateRequest = {", "  const request: GateRequest = {\n    ...record,")
    edit("src/gate/gate.ts", "structuredClone(task.spec),", "{ ...(task.spec as object), ...(raw as object) },")
EOF
}

status=0
for mutant in m1 m2; do
  mutate "$mutant"
  if npx vitest run test/gate >/dev/null 2>&1; then
    echo "$mutant: SURVIVED (no test failed)"
    status=1
  else
    echo "$mutant: caught"
  fi
  restore
done
if npx vitest run test/gate >/dev/null 2>&1; then echo "restored: pass"; else echo "restored: FAIL"; status=1; fi
exit "$status"
