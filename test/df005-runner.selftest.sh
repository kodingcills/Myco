#!/usr/bin/env bash
# VM-free self-test of scripts/df005-runner.py against a stub MCP server.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
stub="python3 $here/test/fake_mcp.py"
tmp_out="$(mktemp -d)"
trap 'rm -rf "$tmp_out"' EXIT

echo "1. Checking refusal without --go on default live server"
if python3 "$here/scripts/df005-runner.py" >/dev/null 2>&1; then
    echo "FAIL: ran without --go"
    exit 1
fi

echo "2. Checking refusal when VM lock is held (exit code 10)"
mock_lock="$(mktemp)"
# Hold lock in background process
python3 -c "
import fcntl, time, sys
fd = open('$mock_lock', 'w')
fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
fd.write('99999 holder-test\n')
fd.flush()
time.sleep(3)
" &
lock_pid=$!
# Give python process a moment to acquire
sleep 0.2

lock_out=""
set +e
lock_out=$(MYCO_VM_LOCK_PATH="$mock_lock" python3 "$here/scripts/df005-runner.py" --go 2>&1)
lock_code=$?
set -e
kill -9 "$lock_pid" 2>/dev/null || true
rm -f "$mock_lock"

if [ "$lock_code" -ne 10 ]; then
    echo "FAIL: expected exit 10 when VM locked, got $lock_code (output: $lock_out)"
    exit 1
fi
if [[ "$lock_out" != *"REFUSED_VM_LOCKED"* ]]; then
    echo "FAIL: expected REFUSED_VM_LOCKED message, got: $lock_out"
    exit 1
fi
echo "   VM lock refusal confirmed (exit 10 REFUSED_VM_LOCKED)"

echo "3. Running all 5 scenarios (1 run each) with fake MCP server"
eval_id="selftest-$(date +%s)"
python3 "$here/scripts/df005-runner.py" \
    --scenario all \
    --runs 1 \
    --server-cmd "$stub" \
    --eval-id "$eval_id" \
    --output-dir "$tmp_out" >/dev/null

eval_dir="$tmp_out/$eval_id"
test -f "$eval_dir/ledger.jsonl" || { echo "FAIL: missing ledger.jsonl"; exit 1; }

for s in df-s01 df-s02 df-s03 df-s04 df-s05; do
    run_dir="$eval_dir/run-$s-1"
    test -d "$run_dir" || { echo "FAIL: missing run dir for $s"; exit 1; }
    test -f "$run_dir/trace.jsonl" || { echo "FAIL: missing trace.jsonl for $s"; exit 1; }
    test -f "$run_dir/result.json" || { echo "FAIL: missing result.json for $s"; exit 1; }
done

line_count=$(wc -l < "$eval_dir/ledger.jsonl" | tr -d ' ')
if [ "$line_count" -ne 5 ]; then
    echo "FAIL: expected 5 ledger rows, got $line_count"
    exit 1
fi

echo "4. Validating emitted artifacts against M1-012 schemas"
node --experimental-strip-types -e '
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { traceEventSchema } from "./schemas/trace-events.ts";
import { resultRecordSchema } from "./schemas/result-record.ts";
import { ledgerRowSchema } from "./schemas/ledger-row.ts";
import { validateSchema } from "./schemas/validate.ts";

const evalDir = process.argv[1];
const ledgerPath = join(evalDir, "ledger.jsonl");
const ledgerLines = readFileSync(ledgerPath, "utf8").trim().split("\n");
for (let i = 0; i < ledgerLines.length; i++) {
  const row = JSON.parse(ledgerLines[i]);
  const issues = validateSchema(row, ledgerRowSchema);
  if (issues.length > 0) {
    console.error("Ledger row schema issue:", issues);
    process.exit(1);
  }
}

for (const entry of readdirSync(evalDir)) {
  const runDir = join(evalDir, entry);
  const resultPath = join(runDir, "result.json");
  if (existsSync(resultPath)) {
    const res = JSON.parse(readFileSync(resultPath, "utf8"));
    const issues = validateSchema(res, resultRecordSchema);
    if (issues.length > 0) {
      console.error("Result schema issue in " + entry + ":", issues);
      process.exit(1);
    }
  }
  const tracePath = join(runDir, "trace.jsonl");
  if (existsSync(tracePath)) {
    const lines = readFileSync(tracePath, "utf8").trim().split("\n");
    for (let i = 0; i < lines.length; i++) {
      const ev = JSON.parse(lines[i]);
      const issues = validateSchema(ev, traceEventSchema);
      if (issues.length > 0) {
        console.error("Trace schema issue in " + entry + " line " + i + ":", issues);
        process.exit(1);
      }
    }
  }
}
console.log("   M1-012 schema validation confirmed (ledger, results, traces valid)");
' "$eval_dir"

echo "df005-runner selftest OK: all 5 scenarios executed and evidenced cleanly"
