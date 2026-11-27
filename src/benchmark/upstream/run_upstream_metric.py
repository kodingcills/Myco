"""Run an upstream benchmark's own metric functions on a captured end state (#675, #682).

Invoked only by src/benchmark/upstream/evaluate.ts as
    python3 -I run_upstream_metric.py <spec.json>
The spec names the upstream checkout root, the metrics package, and for each metric the
module, the function, the result value, the expected value (or none) and the options, all
taken from the upstream task file by the TypeScript side. The verified SHA-256 of every
module file is in the spec too; this script re-hashes each file and refuses to import one
whose bytes differ (EVALUATOR_HASH_MISMATCH), so the code that runs is the code pinned in the
manifest.

What is upstream and what is not:
  * every metric function, and every helper it imports, is the upstream file, unmodified;
  * the package parents (desktop_env, desktop_env.evaluators, ...metrics) are registered as
    bare packages pointing at the upstream directories, so the metric modules load without
    running the upstream package __init__ files, which eagerly import every metric of every
    app (chrome, gimp, OCR...) and their heavy dependencies. No upstream code is replaced;
  * the getters are not run: they talk to the VM. The caller passes what a getter returns:
    a local file path for vm_file / cloud_file (None when the file was not captured, as
    upstream's get_vm_file returns None), and the rules dict for `rule` (upstream get_rule
    returns config["rules"]);
  * the combination of several metrics follows DesktopEnv.evaluate() at the OSWorld pin
    (desktop_env/desktop_env.py, lines 557-602): with conj "and", the first 0.0 returns 0,
    else the mean; with conj "or", the first 1.0 returns 1, else the max.

Output: one JSON object on stdout: {"ok": true, "score": float, "scores": [...]} or
{"ok": false, "code": "..."} (codes only).
"""

import hashlib
import importlib
import io
import json
import os
import sys
import types
import contextlib


def fail(code):
    sys.stdout.write(json.dumps({"ok": False, "code": code}) + "\n")
    sys.exit(0)


def register_package(name, path):
    module = types.ModuleType(name)
    module.__path__ = [path]
    module.__package__ = name
    sys.modules[name] = module


def main():
    if len(sys.argv) != 2:
        fail("BAD_ARGS")
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as f:
            spec = json.load(f)
    except Exception:
        fail("BAD_SPEC")

    root = spec["root"]
    package = spec["metricsPackage"]
    metrics_dir = os.path.join(root, *spec["metricsDir"].split("/"))
    parts = package.split(".")
    # Parents of the metrics package point at their real directories under the checkout.
    package_dir = metrics_dir
    for _ in parts:
        package_dir = os.path.dirname(package_dir)
    if os.path.join(package_dir, *parts) != metrics_dir:
        fail("BAD_SPEC")
    for i in range(1, len(parts) + 1):
        register_package(".".join(parts[:i]), os.path.join(package_dir, *parts[:i]))

    for rel, digest in spec["files"].items():
        path = os.path.join(root, *rel.split("/"))
        try:
            with open(path, "rb") as f:
                actual = hashlib.sha256(f.read()).hexdigest()
        except OSError:
            fail("EVALUATOR_FILE_MISSING")
        if actual != digest:
            fail("EVALUATOR_HASH_MISMATCH")

    conj = spec["conj"]
    scores = []
    for metric in spec["metrics"]:
        try:
            # Upstream metrics print diagnostics; keep stdout for the verdict line only.
            with contextlib.redirect_stdout(io.StringIO()):
                module = importlib.import_module(package + "." + metric["module"])
        except Exception:
            fail("EVALUATOR_IMPORT_FAILED")
        func = getattr(module, metric["func"], None)
        if func is None:
            fail("EVALUATOR_FUNC_MISSING")
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                if metric["hasExpected"]:
                    score = func(metric["result"], metric["expected"], **metric["options"])
                else:
                    score = func(metric["result"], **metric["options"])
            score = float(score)
        except Exception:
            fail("EVALUATOR_RAISED")
        if conj == "and" and score == 0.0:
            scores.append(score)
            sys.stdout.write(json.dumps({"ok": True, "score": 0.0, "scores": scores}) + "\n")
            return
        if conj == "or" and score == 1.0:
            scores.append(score)
            sys.stdout.write(json.dumps({"ok": True, "score": 1.0, "scores": scores}) + "\n")
            return
        scores.append(score)

    total = sum(scores) / len(scores) if conj == "and" else max(scores)
    sys.stdout.write(json.dumps({"ok": True, "score": total, "scores": scores}) + "\n")


if __name__ == "__main__":
    main()
