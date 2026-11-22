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

echo "2. Running all 5 scenarios (1 run each) with fake MCP server"
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

echo "df005-runner selftest OK: all 5 scenarios executed and evidenced cleanly"
