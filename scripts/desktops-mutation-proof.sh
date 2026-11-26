#!/usr/bin/env bash
# Mutation proofs for track U (disposable desktops, fleet, dataset exporter). Not run in CI:
# it edits src/desktops and src/dataset in place and restores them on exit. Each mutant must
# make `vitest run test/desktops test/dataset` fail; the script exits 0 only when every
# mutant is caught and the restored tree passes. No VM, no network, no model.
#
# Backend (src/desktops/backend.ts, local-process.ts):
#   d1: a spec asking for network is accepted.
#   d2: `..` / `.` path segments are not refused as escapes.
#   d3: an absolute path is not refused as an escape.
#   d4: the desktop program inherits the host environment.
#   d5: the capture walk follows symlinks (directory component).
#   d6: the capture walk AND O_NOFOLLOW are both dropped (final-component symlink).
#   d7: a non-regular file (directory, FIFO) is captured.
#   d8: the capture size cap is not enforced (truncation/oversize).
#   d9: a destroyed desktop still answers.
#   d10: a handle from another backend is accepted.
#   d11: the host root is not scrubbed from program output.
#   d12: the home is not scrubbed (only the root is), so `<desktop>/home` leaks the layout.
# Fleet (src/desktops/fleet.ts):
#   f1: duplicate trial keys / run ids / canaries are accepted.
#   f2: the canary scan finds nothing (contamination never reported).
#   f3: the concurrency cap is ignored.
#   f4: desktops are not destroyed after a trial.
# Exporter (src/dataset/export.ts, hygiene.ts) and transcript (src/desktops/transcript.ts):
#   e1: the gate's taskId/runId binding is not checked.
#   e2: the grade's capture/fixture binding is not checked.
#   e3: the captured digest is taken from the grade, not recomputed from the bytes.
#   e4: a positive does not need the grader's pass (gate verified alone).
#   e5: a positive does not need the gate's verified (grader pass alone).
#   e6: refuted runs are exported as negatives without includeNegatives.
#   e7: a negative does not need the grader's fail.
#   e8: a positive does not need a done claim.
#   e9: `accepted` inconsistent with `verdict` is not treated as malformed.
#   e10: scripted / mock-gate runs need not be labelled simulated.
#   e11: the leak scan is skipped for records.
#   e12: a leaking object key is echoed into the reported path.
#   e13: host paths are not scanned for.
#   e14: secret-shaped strings are not scanned for.
#   e15: operator-named forbidden strings are not scanned for.
#   e16: object keys are not scanned.
#   e17: duplicate trial keys / run ids are accepted.
#   e18: records are not validated against the schema.
#   e19: an existing output directory is overwritten (both checks dropped).
#   e20: the gate's human-readable reasons are exported (not codes only).
#   e21: a second claim line is accepted (transcript not fail-closed).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
PATHS=(src/desktops src/dataset)
if ! git diff --quiet -- "${PATHS[@]}"; then
  echo "desktops-mutation-proof: ${PATHS[*]} have uncommitted changes; commit or discard them first" >&2
  exit 3
fi
restore() { git checkout -- "${PATHS[@]}"; }
trap restore EXIT

mutate() {
  python3 - "$1" <<'EOF'
import sys
which = sys.argv[1]
def edit(path, old, new, count=-1):
    s = open(path).read()
    assert old in s, f"{path}: anchor not found: {old!r}"
    open(path, "w").write(s.replace(old, new, count))
B = "src/desktops/backend.ts"
L = "src/desktops/local-process.ts"
F = "src/desktops/fleet.ts"
T = "src/desktops/transcript.ts"
E = "src/dataset/export.ts"
H = "src/dataset/hygiene.ts"
M = {
  "d1": [(B, 'if (spec.network !== "off") throw', 'if (false) throw')],
  "d2": [(B, 'if (segment === ".." || segment === ".") throw', 'if (false) throw')],
  "d3": [(B, 'if (path.startsWith("/") || ', 'if (')],
  "d4": [(L, 'const env: Record<string, string> = {};', 'const env: Record<string, string> = { ...process.env } as Record<string, string>;')],
  "d5": [(L, 'if (stat.isSymbolicLink()) throw new DesktopError("SYMLINK_REFUSED");', '')],
  "d6": [(L, 'if (stat.isSymbolicLink()) throw new DesktopError("SYMLINK_REFUSED");', ''),
         (L, 'constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK', 'constants.O_RDONLY | constants.O_NONBLOCK')],
  "d7": [(L, 'if (!stat.isFile())', 'if (false)')],
  "d8": [(L, 'if (stat.size > this.#maxCapture)', 'if (false)')],
  "d9": [(L, 'if (desktop.destroyed) throw', 'if (false) throw')],
  "d10": [(L, 'if (handle?.backend !== this.kind) throw', 'if (false) throw', 1)],
  "d11": [(L, '    return out;', '    return text;')],
  "d12": [(L, 'const realHome = join(desktop.realRoot, "home");', 'const realHome = "\\u0000never";'),
          (L, '[desktop.home, "<home>"],', '')],
  "f1": [(F, 'if (keys.has(t.trialKey) || runs.has(t.runId) || canaries.has(t.canary)) {', 'if (false) {')],
  "f2": [(F, 'if (text.includes(other.canary)) {', 'if (false) {')],
  "f3": [(F, 'length: Math.min(options.concurrency, trials.length)', 'length: trials.length')],
  "f4": [(F, 'await backend.destroy(handle);', 'void 0;')],
  "e1": [(E, 'if (gate.request.taskId !== c.taskId || gate.request.runId !== c.runId) {', 'if (false) {')],
  "e2": [(E, 'if (c.grade.persistedSha256 !== captured || c.grade.fixtureSha256 !== c.fixtureSha256) {', 'if (false) {')],
  "e3": [(E, 'const captured = sha256Hex(c.persisted.bytes);', 'const captured = c.grade.persistedSha256;')],
  "e4": [(E, 'if (gate.verdict === "verified" && gate.accepted && c.grade.status === "pass") {', 'if (gate.verdict === "verified" && gate.accepted) {')],
  "e5": [(E, 'if (gate.verdict === "verified" && gate.accepted && c.grade.status === "pass") {', 'if (c.grade.status === "pass") {')],
  "e6": [(E, 'return includeNegatives ? { label: "negative" } : { excluded: "NEGATIVES_NOT_REQUESTED" };', 'return { label: "negative" };')],
  "e7": [(E, 'if (gate.verdict === "refuted" && !gate.accepted && c.grade.status === "fail") {', 'if (gate.verdict === "refuted" && !gate.accepted) {')],
  "e8": [(E, 'return c.claim.done ? { label: "positive" } : { excluded: "NOT_CLAIMED" };', 'return { label: "positive" };')],
  "e9": [(E, 'gate.accepted !== (gate.verdict === "verified")', 'false')],
  "e10": [(E, 'if (mustBeSimulated(c) && c.provenance.simulated !== true) {', 'if (false) {')],
  "e11": [(E, 'const leaks = scanForLeaks(record, options.hygiene);', 'const leaks: Array<{ path: string; kind: string }> = [];')],
  "e12": [(H, 'const name = keyLeaks.length > 0 ? "<key>" : key;', 'const name = key;')],
  "e13": [(H, 'if (HOST_PATH.some((re) => re.test(text))) kinds.push("host-path");', '')],
  "e14": [(H, 'if (SECRET_SHAPED.some((re) => re.test(text))) kinds.push("secret-shaped");', '')],
  "e15": [(H, 'if (s.length > 0 && text.includes(s)) {', 'if (false) {')],
  "e16": [(H, 'for (const kind of keyLeaks) out.push', 'for (const kind of []) out.push')],
  "e17": [(E, 'if (trialKeys.has(c.trialKey) || runIds.has(c.runId)) {', 'if (false) {')],
  "e18": [(E, 'const issues = validateSchema(record, datasetRecordSchema);', 'const issues: Array<{ path: string; keyword: string }> = [];')],
  "e19": [(E, 'if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");', ''),
          (E, 'writeFileSync(join(staging, "records.jsonl"), recordsJsonl, { flag: "wx" });', 'rmSync(options.outDir, { recursive: true, force: true }); writeFileSync(join(staging, "records.jsonl"), recordsJsonl, { flag: "wx" });')],
  "e20": [(E, 'reasonCodes: [...gate.reasonCodes],', 'reasonCodes: [...gate.reasonCodes], reasons: (gate as unknown as { reasons: unknown }).reasons,')],
  "e21": [(T, 'if (claim !== null || typeof body.done', 'if (typeof body.done')],
}
for edit_args in M[which]:
    edit(*edit_args)
EOF
}

MUTANTS=(d1 d2 d3 d4 d5 d6 d7 d8 d9 d10 d11 d12 f1 f2 f3 f4 e1 e2 e3 e4 e5 e6 e7 e8 e9 e10 e11 e12 e13 e14 e15 e16 e17 e18 e19 e20 e21)
status=0
for mutant in "${MUTANTS[@]}"; do
  mutate "$mutant"
  if npx vitest run test/desktops test/dataset >/dev/null 2>&1; then
    echo "$mutant: SURVIVED (no test failed)"
    status=1
  else
    echo "$mutant: caught"
  fi
  restore
done
if npx vitest run test/desktops test/dataset >/dev/null 2>&1; then echo "restored: pass"; else echo "restored: FAIL"; status=1; fi
exit "$status"
