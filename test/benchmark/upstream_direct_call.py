"""Test-only reference: call ONE upstream metric directly, outside Myco's grader (#682).

    python3 -I upstream_direct_call.py <root> <metrics_dir> <task_file> <result> <expected>

A deliberately different path from src/benchmark/upstream/run_upstream_metric.py: it copies
the upstream metrics directory into a fresh temporary package tree with empty __init__ files,
imports it the ordinary way, reads the function name and options straight from the upstream
task file, and prints the metric's raw score. test/benchmark/upstream-evaluator.test.ts
checks that Myco's verdict and score equal this, case by case. Single-metric tasks only.
"""

import importlib
import io
import contextlib
import json
import os
import shutil
import sys
import tempfile


def main():
    root, metrics_dir, task_file, result, expected = sys.argv[1:6]
    with open(os.path.join(root, task_file), "r", encoding="utf-8") as f:
        evaluator = json.load(f)["evaluator"]
    func_name = evaluator["func"]
    options = evaluator.get("options", {})
    tmp = tempfile.mkdtemp()
    try:
        pkg = os.path.join(tmp, "desktop_env", "evaluators", "metrics")
        shutil.copytree(os.path.join(root, metrics_dir), pkg)
        for d in (os.path.join(tmp, "desktop_env"), os.path.join(tmp, "desktop_env", "evaluators"), pkg):
            with open(os.path.join(d, "__init__.py"), "w") as f:
                f.write("")
        sys.path.insert(0, tmp)
        found = None
        for name in sorted(os.listdir(pkg)):
            if not name.endswith(".py") or name == "__init__.py":
                continue
            with open(os.path.join(pkg, name), "r", encoding="utf-8") as f:
                if ("\ndef " + func_name + "(") in ("\n" + f.read()):
                    found = name[:-3]
                    break
        with contextlib.redirect_stdout(io.StringIO()):
            module = importlib.import_module("desktop_env.evaluators.metrics." + found)
            score = getattr(module, func_name)(None if result == "-" else result, expected, **options)
        sys.stdout.write(json.dumps({"score": float(score)}) + "\n")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
