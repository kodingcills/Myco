#!/usr/bin/env bash
# Mutation proofs for track U (disposable desktops, fleet, episode-container dataset
# exporter, leak scan). Not run in CI: it edits src/desktops and src/dataset in place and
# restores them on exit. Each mutant must make `vitest run test/desktops test/dataset` fail;
# the script exits 0 only when every mutant is caught and the restored tree passes. No VM,
# no network, no model.
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
#   d13: a file that shrinks mid-capture is captured partially (round-1 V10).
#   d14: the host PATH is passed through to the desktop program.
# Fleet (src/desktops/fleet.ts):
#   f1: duplicate trial keys / run ids / canaries are accepted.
#   f2: the canary scan finds nothing (contamination never reported).
#   f3: the concurrency cap is ignored.
#   f4: desktops are not destroyed after a trial.
# Exporter (src/dataset/export.ts), episode mirror (episode.ts), transcript (transcript.ts):
#   e1: the gate's taskId/runId binding is not checked.
#   e2: the grade's persisted-bytes binding is not checked.
#   e2b: the grade's fixture binding is not checked.
#   e2c: the episode task's fixture binding is not checked.
#   e3: the captured digest is taken from the grade, not recomputed from the bytes.
#   e4: a positive does not need the grader's pass (gate verified alone).
#   e5: a positive does not need the gate's verified (grader pass alone).
#   e6: refuted episodes are exported as negatives without includeNegatives.
#   e7: a negative does not need the grader's fail.
#   e8: a positive does not need a done claim.
#   e9: `accepted` inconsistent with `verdict` is not treated as malformed.
#   e10: scripted / non-gated episodes need not be labelled simulated.
#   e11: the output leak scan is skipped entirely.
#   e17: duplicate trial keys / run ids / episodes are accepted.
#   e18: records are not validated against the schema.
#   e19: an existing output directory is overwritten (both checks dropped).
#   e20: the interim episode writer copies the gate record wholesale (gate prose exported).
#   e20b: the interim episode writer copies the ground truth wholesale (grader prose exported).
#   e21: a second claim line is accepted (transcript not fail-closed).
#   n1: an episode whose gate record differs from the raw gate result is accepted.
#   n2: episodes are not checked against the closed myco.episode/1 schema (smuggled fields pass).
#   n3: the episode content id is not checked.
#   n4: blob observations are accepted (dangling references in the container).
#   n5: an episode whose outcome differs from its gate verdict is accepted.
#   n6: out-of-order actions are accepted.
#   s1: manifest.json is not scanned for leaks (round-1 V7).
#   s2: schema.json is not scanned for leaks.
#   s3: records.jsonl is not scanned for leaks.
#   s4: episode files are not scanned for leaks.
#   t1: a step's action is not checked against the episode action schema.
#   t2: over-long status text is kept instead of withheld.
# Leak scan (src/dataset/hygiene.ts):
#   e12: a leaking object key is echoed into the reported path.
#   e13: host paths are not scanned for.
#   e14: secret-shaped strings are not scanned for.
#   e15: operator-named forbidden strings are not scanned for.
#   e16: object keys are not scanned.
#   h1: home roots matched only after a boundary character (D1: `a.b/home/x`).
#   h2: the round-1 leading class `[^A-Za-z0-9_.<>-]` is restored (D1: `>/tmp/x`, `-f/etc/x`).
#   h3: the added roots (scratch, Library, dev) are dropped (D1).
#   h4: no decoding at all (encoded paths pass).
#   h5: JSON `\/` escapes not decoded.
#   h6: percent escapes not decoded.
#   h7: HTML numeric entities not decoded.
#   h8: Windows forward-slash drive paths not matched.
#   h9: backslash home roots without a drive not matched.
#   h10: `~user/` home-relative paths not matched (only `~/`).
#   h11: `$HOME` / `%USERPROFILE%` spellings not matched.
#   h12: the username scan is off (round-1 V5, D2).
#   h13: the hostname scan is off (round-1 V11, D2).
#   h14: an injected identity is ignored (machine identity only, D2).
#   h15: identity matching is case-sensitive.
#   h16: placeholders are not neutralised (`<home>/tmp` refused as a host path).
#   h17: forbiddenStringsFromFiles keeps whole lines only (a vault `NAME=value` value missed, D4).
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
P = "src/dataset/episode.ts"
SCAN_LOOP = "  for (const [name, text] of files) {\n"
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
  "d13": [(L, 'if (read !== stat.size) throw new DesktopError("CAPTURE_CHANGED");', '')],
  "d14": [(L, 'env.PATH = DESKTOP_PATH;', 'env.PATH = process.env.PATH ?? DESKTOP_PATH;')],
  "f1": [(F, 'if (keys.has(t.trialKey) || runs.has(t.runId) || canaries.has(t.canary)) {', 'if (false) {')],
  "f2": [(F, 'if (text.includes(other.canary)) {', 'if (false) {')],
  "f3": [(F, 'length: Math.min(options.concurrency, trials.length)', 'length: trials.length')],
  "f4": [(F, 'await backend.destroy(handle);', 'void 0;')],
  "e1": [(E, 'if (gate.request.taskId !== ep.task.id || gate.request.runId !== ep.provenance.runId) {', 'if (false) {')],
  "e2": [(E, 'truth.persistedSha256 !== captured ||', '')],
  "e2b": [(E, 'truth.fixtureSha256 !== c.fixtureSha256 ||', '')],
  "e2c": [(E, '    ep.task.fixtureSha256 !== c.fixtureSha256\n', '    false\n')],
  "e3": [(E, 'const captured = sha256Hex(c.capture.bytes);', 'const captured = truth.persistedSha256;')],
  "e4": [(E, 'if (gate.verdict === "verified" && gate.accepted && truth.status === "pass") {', 'if (gate.verdict === "verified" && gate.accepted) {')],
  "e5": [(E, 'if (gate.verdict === "verified" && gate.accepted && truth.status === "pass") {', 'if (truth.status === "pass") {')],
  "e6": [(E, 'return includeNegatives ? { label: "negative" } : { excluded: "NEGATIVES_NOT_REQUESTED" };', 'return { label: "negative" };')],
  "e7": [(E, 'if (gate.verdict === "refuted" && !gate.accepted && truth.status === "fail") {', 'if (gate.verdict === "refuted" && !gate.accepted) {')],
  "e8": [(E, 'return ep.agentClaim === "done" ? { label: "positive" } : { excluded: "NOT_CLAIMED" };', 'return { label: "positive" };')],
  "e9": [(E, '    gate.accepted !== (gate.verdict === "verified")\n', '    false\n')],
  "e10": [(E, 'if (mustBeSimulated(ep) && ep.simulated !== true) {', 'if (false) {')],
  "e11": [(E, 'const leak = firstLeak(outputs, options.hygiene);', 'const leak = null as { where: string; kind: string } | null;')],
  "e17": [(E, '      (trialKey !== null && trialKeys.has(trialKey)) ||\n      runIds.has(ep.provenance.runId) ||\n      episodeIds.has(ep.episodeId)\n', '      false\n')],
  "e18": [(E, 'const issues = validateSchema(record, datasetRecordSchema);', 'const issues: Array<{ path: string; keyword: string }> = [];')],
  "e19": [(E, 'if (existsSync(options.outDir)) throw new ExportRefused("OUT_EXISTS", "outDir");', ''),
          (E, 'const staging = mkdtempSync(', 'rmSync(options.outDir, { recursive: true, force: true }); const staging = mkdtempSync(')],
  "e20": [(P, '        : {\n            verdict: d.gate.verdict,\n            accepted: d.gate.accepted,\n            reasonCodes: d.gate.reasonCodes === null ? null : [...d.gate.reasonCodes],\n            oracle: null,\n          },', '        : { ...d.gate, oracle: null },')],
  "e20b": [(P, '    groundTruth:\n      d.groundTruth.source === "independent-grader"', '    groundTruth: d.groundTruth,\n    _unused:\n      d.groundTruth.source === "independent-grader"')],
  "e21": [(T, 'if (claim !== null || typeof body.done', 'if (typeof body.done')],
  "n1": [(E, '    ep.gate.verdict !== gate.verdict ||\n    ep.gate.accepted !== gate.accepted ||\n    !sameCodes(ep.gate.reasonCodes, gate.reasonCodes)\n', '    false\n')],
  "n2": [(E, 'const issues = validateSchema(ep, episodeMirrorSchema);', 'const issues: Array<{ path: string; keyword: string }> = [];')],
  "n3": [(E, 'if (episodeIdOf(e) !== e.episodeId) return', 'if (false) return')],
  "n4": [(E, '    if (o.kind !== "ui-status") {\n      return { path: `$.observations.items[${i}]`, detail: "BLOBS_UNSUPPORTED" };\n    }\n', '    if (o.kind !== "ui-status") continue;\n')],
  "n5": [(E, 'if (decided.includes(e.outcome) && e.gate?.verdict !== e.outcome) {', 'if (false) {')],
  "n6": [(E, 'if (a.seq !== i) return', 'if (false) return')],
  "s1": [(E, SCAN_LOOP, SCAN_LOOP + '    if (name === "manifest.json") continue;\n')],
  "s2": [(E, SCAN_LOOP, SCAN_LOOP + '    if (name === "schema.json") continue;\n')],
  "s3": [(E, SCAN_LOOP, SCAN_LOOP + '    if (name === "records.jsonl") continue;\n')],
  "s4": [(E, SCAN_LOOP, SCAN_LOOP + '    if (name.startsWith("episodes/")) continue;\n')],
  "t1": [(T, 'if (validateSchema({ seq: 0, atMs: null, ...action }, episodeActionSchema).length > 0) {', 'if (false) {')],
  "t2": [(T, 'if (observation.length > EPISODE_MAX_STATUS_TEXT) withheld += 1;\n        else observations', 'observations')],
  "e12": [(H, 'const name = keyLeaks.length > 0 ? "<key>" : key;', 'const name = key;')],
  "e13": [(H, 'if (HOST_PATH.some((re) => pathForms.some((f) => re.test(f)))) kinds.push("host-path");', '')],
  "e14": [(H, 'if (SECRET_SHAPED.some((re) => forms.some((f) => re.test(f)))) kinds.push("secret-shaped");', '')],
  "e15": [(H, 'if (s.length > 0 && forms.some((f) => f.includes(s))) {', 'if (false) {')],
  "e16": [(H, 'for (const kind of keyLeaks) out.push', 'for (const kind of []) out.push')],
  "h1": [(H, r'new RegExp(`\\/(?:${HOME_ROOTS})(?:', r'new RegExp(`(?:^|[^A-Za-z0-9_.<>-])\\/(?:${HOME_ROOTS})(?:')],
  "h2": [(H, r'new RegExp(`(?:^|[^A-Za-z0-9_])\\/(?:${SYSTEM_ROOTS})', r'new RegExp(`(?:^|[^A-Za-z0-9_.<>-])\\/(?:${SYSTEM_ROOTS})')],
  "h3": [(H, '  "scratch",\n', ''), (H, '  "Library",\n', ''), (H, '  "dev",\n', '')],
  "h4": [(H, '    const next = decodeOnce(current);', '    const next = current;')],
  "h5": [(H, r'      .replace(/\\\//g, "/")' + '\n', '')],
  "h6": [(H, '      .replace(/%([0-9A-Fa-f]{2})/g,', '      .replace(/%NEVER([0-9A-Fa-f]{2})/g,')],
  "h7": [(H, '      .replace(/&#([0-9]{1,7});/g,', '      .replace(/&#NEVER([0-9]{1,7});/g,')],
  "h8": [(H, r'/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/,', r'/(?:^|[^A-Za-z0-9])[A-Za-z]:\\/,')],
  "h9": [(H, r'  new RegExp(`\\\\(?:${HOME_ROOTS})\\\\`, "i"),' + '\n', '')],
  "h10": [(H, r'~(?:[A-Za-z_][A-Za-z0-9._-]*)?[\\/]/', r'~[\\/]/')],
  "h11": [(H, r'  /\$HOME\b|\$\{HOME\}|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|APPDATA|LOCALAPPDATA|TEMP|TMP)%/i,' + '\n', '')],
  "h12": [(H, 'out.push(["username", wordPattern(user)]);', 'void 0;')],
  "h13": [(H, 'out.push(["hostname", wordPattern(host)]);', 'void 0;')],
  "h14": [(H, 'const { user, host: fullHost } = options.identity ?? machineIdentity();', 'const { user, host: fullHost } = machineIdentity();')],
  "h15": [(H, '(?:$|[^A-Za-z0-9])`, "i");', '(?:$|[^A-Za-z0-9])`);')],
  "h16": [(H, 'const pathForms = forms.map((f) => f.replace(PLACEHOLDER, "PLACEHOLDER"));', 'const pathForms = forms;')],
  "h17": [(H, 'if (value !== undefined && value.length >= minLength) out.add(value);', '')],
}
for edit_args in M[which]:
    edit(*edit_args)
EOF
}

MUTANTS=(d1 d2 d3 d4 d5 d6 d7 d8 d9 d10 d11 d12 d13 d14 f1 f2 f3 f4
  e1 e2 e2b e2c e3 e4 e5 e6 e7 e8 e9 e10 e11 e17 e18 e19 e20 e20b e21
  n1 n2 n3 n4 n5 n6 s1 s2 s3 s4 t1 t2
  e12 e13 e14 e15 e16 h1 h2 h3 h4 h5 h6 h7 h8 h9 h10 h11 h12 h13 h14 h15 h16 h17)
if [ "$#" -gt 0 ]; then MUTANTS=("$@"); fi
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
