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
#   mN: a descriptor path outside the evidence root fails open (TIF-265 follow-up round 2 D3).
#   mO: the binding fails open when realpath(root) fails (round 2 D3).
#   mP: a "(deleted)" suffix is stripped before the path compare (round 2 D3).
#   mQ: the outside-root test accepts `startsWith(realRoot)` without the "/" (round 3 nit):
#       a sibling <root>-evil is then reported as a path inside the root.
#   mR: the descriptor path is compared by suffix, not exactly (round 3 D1): a borrowed run
#       also named r (x/r, <root>-evil/r) then passes.
#   mS: the open-failure reason carries Node's error message (with the host path) (round 3 D2).
#   mT: the read-failure reason carries Node's error message (round 3 D2).
#   mU: "reader threw" carries String(error) (TIF-265 follow-up 2).
#   mV: "oracle threw" carries String(error) (follow-up 2).
#   mW: "decision log write failed" carries String(error), i.e. the audit-log path (follow-up 2).
#   mX: "gate error" carries String(error) (follow-up 2).
#   mY: the todo-items family's "store does not parse" carries String(error) (follow-up 2).
#   mZ: errorCode accepts any string `code` (a code holding a path passes through) (follow-up 2).
#   mA: errorCode accepts any string `name` (follow-up 2).
#   mB: a throwing onDiagnostic sink is not contained (follow-up 2).
#   mC: a reader that throws synchronously escapes readWithin (follow-up 2).
#   mD: errorCode falls back to the error's message instead of "error" (follow-up 2 round 2 D1).
#   mF: `instanceof StateCorruptError` is not guarded, so a revoked Proxy thrown by the
#       oracle escapes to "gate error" (follow-up 2 round 2 nit).
# mL, mM, mN, mP, mQ and mR are caught only on Linux, where the binding applies; elsewhere
# their tests skip. mO's test forces the binding on, and mS/mT's tests run everywhere.
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
    edit("src/gate/gate.ts", "await readWithin(config.reader, runId, task.stateFile, readTimeoutMs, diagnose)", "await config.reader.read(runId, task.stateFile)")
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
    edit("src/gate/gate.ts", "const second = walk(absoluteRoot, segments, where, hooks.beforeLstat);", "const second = first;")
elif which == "mK":
    edit("src/gate/gate.ts", "if (last && !stat.isFile()) {", "if (false) {")
elif which == "mL":
    edit("src/gate/gate.ts", "        if (!bound.ok) return bound;\n", "")
elif which == "mM":
    edit("src/gate/gate.ts", "    actual = readlinkSync(join(hooks.procFdDir ?? \"/proc/self/fd\", String(fd)));\n  } catch (error) {\n", "    actual = readlinkSync(join(hooks.procFdDir ?? \"/proc/self/fd\", String(fd)));\n  } catch (error) {\n    if (error) return { ok: true };\n")
elif which == "mN":
    edit("src/gate/gate.ts", "  if (actual !== join(realRoot, ...segments)) {", "  if (actual !== join(realRoot, ...segments) && actual.startsWith(`${realRoot}/`)) {")
elif which == "mO":
    edit("src/gate/gate.ts", "    realRoot = realpathSync(absoluteRoot);\n  } catch (error) {\n", "    realRoot = realpathSync(absoluteRoot);\n  } catch (error) {\n    if (error) return { ok: true };\n")
elif which == "mP":
    edit("src/gate/gate.ts", "  if (actual !== join(realRoot, ...segments)) {", "  actual = actual.replace(/ \\(deleted\\)$/, \"\");\n  if (actual !== join(realRoot, ...segments)) {")
elif which == "mQ":
    edit("src/gate/gate.ts", "    const shown = actual.startsWith(`${realRoot}/`)", "    const shown = actual.startsWith(realRoot)")
elif which == "mR":
    edit("src/gate/gate.ts", "  if (actual !== join(realRoot, ...segments)) {", "  if (!actual.endsWith(join(...segments))) {")
elif which == "mS":
    edit("src/gate/gate.ts", "`${where}: open failed: ${errorCode(error)}`", "`open failed: ${String(error)}`")
elif which == "mT":
    edit("src/gate/gate.ts", "`${where}: read failed: ${errorCode(error)}`", "`read failed: ${String(error)}`")
elif which == "mU":
    edit("src/gate/gate.ts", "`reader threw: ${diagnose(\"reader\", error)}`", "`reader threw: ${String(error)}`")
elif which == "mV":
    edit("src/gate/gate.ts", "`oracle threw: ${diagnose(\"oracle\", error)}`", "`oracle threw: ${String(error)}`")
elif which == "mW":
    edit("src/gate/gate.ts", "`decision log write failed: ${diagnose(\"decision-log\", error)}`", "`decision log write failed: ${String(error)}`")
elif which == "mX":
    edit("src/gate/gate.ts", "`gate error: ${diagnose(\"gate\", error)}`", "`gate error: ${String(error)}`")
elif which == "mY":
    edit("src/gate/families.ts", "`store does not parse (${errorCode(error)})`", "`store does not parse: ${String(error)}`")
elif which == "mZ":
    edit("src/gate/reasons.ts", "if (typeof code === \"string\" && CODE.test(code)) return code;", "if (typeof code === \"string\") return code;")
elif which == "mA":
    edit("src/gate/reasons.ts", "if (typeof name === \"string\" && NAME.test(name)) return name;", "if (typeof name === \"string\") return name;")
elif which == "mB":
    edit("src/gate/gate.ts", """    try {
      config.onDiagnostic?.({ stage, code, error });
    } catch {
      // Diagnostics never change a verdict.
    }""", "    config.onDiagnostic?.({ stage, code, error });")
elif which == "mC":
    edit("src/gate/gate.ts", """      Promise.resolve()
        .then(() => reader.read(runId, stateFile))
        .catch(""", "      reader.read(runId, stateFile).catch(")
elif which == "mD":
    edit("src/gate/reasons.ts", "  return \"error\";\n}", "  return String(error?.message ?? \"error\");\n}")
elif which == "mF":
    edit("src/gate/gate.ts", "      try {\n        if (error instanceof StateCorruptError) corrupt = error;\n      } catch {\n        corrupt = undefined;\n      }", "      if (error instanceof StateCorruptError) corrupt = error;")
EOF
}

status=0
for mutant in m1 m2 m3 m4 m5 m6 m7 m8 m9 mE mG mH mI mJ mK mL mM mN mO mP mQ mR mS mT mU mV mW mX mY mZ mA mB mC mD mF; do
  if [[ "$mutant" =~ ^m[LMNPQR]$ ]] && [[ "$(uname -s)" != Linux ]]; then
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
