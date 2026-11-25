#!/usr/bin/env bash
# Mutation proofs for the gate (TIF-265). Not run in CI: it edits src/gate in place and
# restores it on exit. Each mutant must make `vitest run test/gate` fail; the script
# exits 0 only when every mutant is caught and the restored tree passes.
#
#   m1: the gate returns `verified` when the oracle refuses.
#   m2: the gate accepts agent-supplied oracle input (request fields flow into the spec).
#   m3: no assignment check: the agent's taskId/runId choose the run (round 1 D1).
#   m4: the reader follows symlinks below the root (round 1 D1).
#   m5: the decision log is not awaited, so an async reject fails open (round 1 D2).
#   m6: the evidence digest is not computed from the bytes read (round 1 D3a).
#   m7: "verdict" is dropped from the oracle-input rejection list (round 1 D3b).
#   m8: the reader has no deadline (round 1 nit).
#   m9: an over-long claim is accepted (round 1 nit).
#   mE: the walk checks for a symlink on the final component only (round 2 D-A).
#   mG: the open drops O_NOFOLLOW (round 2 D-A).
#   mH: the open drops O_NONBLOCK, so a FIFO swapped in blocks (round 2 D-B).
#   mI: no dev/ino comparison between the walk and the descriptor (round 2 D-A).
#   mJ: no second walk after the open (round 2 D-A).
#   mK: the walk does not require a regular file (round 2 D-B).
#   mL: no descriptor-path binding (/proc/self/fd) after the checks (TIF-265 follow-up,
#       round-3 D-A'): the intermediate-swap pin tests fail on Linux.
#   mM: the binding fails open when /proc/self/fd cannot be read (TIF-265 follow-up).
# mL and mM are caught only on Linux, where the binding applies; elsewhere their tests skip.
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
elif which == "m3":
    edit("src/gate/gate.ts", "if (taskId !== assignment.taskId || runId !== assignment.runId) {", "if (false) {")
elif which == "m4":
    edit("src/gate/gate.ts", "if (stat.isSymbolicLink()) {", "if (false) {")
    edit("src/gate/gate.ts", "constants.O_RDONLY | constants.O_NOFOLLOW", "constants.O_RDONLY")
elif which == "m5":
    edit("src/gate/gate.ts", "await config.onDecision(result);", "void config.onDecision(result);")
elif which == "m6":
    edit("src/gate/gate.ts", "sha256: sha256(read.bytes),", 'sha256: "0".repeat(64),')
elif which == "m7":
    edit("src/gate/api.ts", '\n  "verdict",\n', "\n")
elif which == "m8":
    edit("src/gate/gate.ts", "await readWithin(config.reader, runId, task.stateFile, readTimeoutMs)", "await config.reader.read(runId, task.stateFile)")
elif which == "m9":
    edit("src/gate/api.ts", "record.claim.length > CLAIM_LIMIT", "false")
elif which == "mE":
    edit("src/gate/gate.ts", "if (stat.isSymbolicLink()) {", "if (index === segments.length - 1 && stat.isSymbolicLink()) {")
elif which == "mG":
    edit("src/gate/gate.ts", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK", "constants.O_RDONLY | constants.O_NONBLOCK")
elif which == "mH":
    edit("src/gate/gate.ts", "constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK", "constants.O_RDONLY | constants.O_NOFOLLOW")
elif which == "mI":
    edit("src/gate/gate.ts", """          second.final.dev !== opened.dev ||
          second.final.ino !== opened.ino ||
          first.final.dev !== opened.dev ||
          first.final.ino !== opened.ino""", "          false")
elif which == "mJ":
    edit("src/gate/gate.ts", "const second = walk(absoluteRoot, segments, where);", "const second = first;")
elif which == "mK":
    edit("src/gate/gate.ts", "if (last && !stat.isFile()) {", "if (false) {")
elif which == "mL":
    edit("src/gate/gate.ts", "        if (!bound.ok) return bound;\n", "")
elif which == "mM":
    edit("src/gate/gate.ts", "    actual = readlinkSync(join(hooks.procFdDir ?? \"/proc/self/fd\", String(fd)));\n  } catch (error) {\n", "    actual = readlinkSync(join(hooks.procFdDir ?? \"/proc/self/fd\", String(fd)));\n  } catch (error) {\n    if (error) return { ok: true };\n")
EOF
}

status=0
for mutant in m1 m2 m3 m4 m5 m6 m7 m8 m9 mE mG mH mI mJ mK mL mM; do
  if [[ "$mutant" == mL || "$mutant" == mM ]] && [[ "$(uname -s)" != Linux ]]; then
    echo "$mutant: skipped (the /proc/self/fd binding applies on Linux only)"
    continue
  fi
  mutate "$mutant"
  if npx vitest run test/gate --testTimeout=10000 >/dev/null 2>&1; then
    echo "$mutant: SURVIVED (no test failed)"
    status=1
  else
    echo "$mutant: caught"
  fi
  restore
done
if npx vitest run test/gate >/dev/null 2>&1; then echo "restored: pass"; else echo "restored: FAIL"; status=1; fi
exit "$status"
