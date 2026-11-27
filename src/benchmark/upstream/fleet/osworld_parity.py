"""Parity harness: score scripted action sequences with upstream DesktopEnv.evaluate() (#741).

Lead ruling 14:05Z: before any live run, a pre-declared small sample of OSWorld LibreOffice
tasks (docs/benchmark/upstream/r1-parity-sample.json) must score the same on the Myco fleet as
on OSWorld's reference environment, with the same scripted known-good and known-bad action
sequences on both, graded by the upstream evaluator, recorded per task. No model is involved.

For one environment, this script runs every sequence of every sample task (or one task) as
OSWorld's own loop would: ``DesktopEnv(provider_name=..., action_space="claude_computer_use")``,
``env.reset(task_config=task)`` (OSWorld's own setup steps), ``env.step(action)`` for each
scripted action (PythonController), then ``env.evaluate()`` (postconfig, getters, metric, the
FAIL-action rule). It appends one JSON record per (task, sequence) to ``--out``. The analysis is
``src/benchmark/upstream/parity.ts`` (``assessParity``).

  python3 -I osworld_parity.py --osworld <checkout at the pin, providers patch applied> \
      --env fleet --host-label "<host>" --out parity-fleet.jsonl [--task <id>]

``--env reference`` runs against OSWorld's guest image in UTM (utm-reference provider; stated
deviation, 15:21Z). It is refused unless ``--reference-approved`` names the comment that
approved the run: the reference run waits for Tiffany's OK and the ~40 GB disk question
(14:37Z ruling). Myco's tooling and CI never run either environment; the tests drive
``run_sequence`` and ``main`` with fakes.
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys

OSWORLD_COMMIT = "0ad41bee56565efe7bb3c3a5ebc67590a1b8276f"
OSWORLD_REPO = "https://github.com/xlang-ai/OSWorld"
GRADER_VERSION = "osworld-desktopenv-evaluate@" + OSWORLD_COMMIT
LABEL = "LIVE-SCRIPTED"
PROVIDERS = {"fleet": "myco-fleet", "reference": "utm-reference"}
SEQUENCES = (("known-good", "knownGood"), ("known-bad", "knownBad"))
APPROVAL = re.compile(r"^https://github\.com/kodingcills/Myco/(pull|issues)/[0-9]+#issuecomment-[0-9]+$")
HERE = os.path.dirname(os.path.abspath(__file__))
# The OSWorld files a run's stamp records (the same keys as OSWORLD_HARNESS.files in
# src/benchmark/upstream/pins.ts; test/benchmark/osworld-fleet.test.ts checks they agree).
HARNESS_FILES = (
    "scripts/python/run_multienv_claude.py",
    "lib_run_single.py",
    "desktop_env/desktop_env.py",
    "desktop_env/controllers/python.py",
    "desktop_env/controllers/setup.py",
    "mm_agents/anthropic/main.py",
    "mm_agents/anthropic/utils.py",
    "desktop_env/providers/__init__.py",
    "desktop_env/providers/base.py",
    "desktop_env/server/__init__.py",
    "desktop_env/server/main.py",
    "desktop_env/server/pyxcursor.py",
    "desktop_env/server/screen_recording.py",
)
# The Myco files each environment's provider runs (repo-relative; pins.ts MYCO_FLEET).
FLEET_FILES = {
    "myco-fleet": (
        "src/benchmark/upstream/fleet/Dockerfile",
        "src/benchmark/upstream/fleet/start.sh",
        "src/benchmark/upstream/fleet/registrymodifications.xcu",
        "src/benchmark/upstream/fleet/requirements-fleet.txt",
        "src/benchmark/upstream/fleet/server.sha256",
        "src/benchmark/upstream/fleet/myco_fleet_provider.py",
        "src/benchmark/upstream/fleet/desktop_env_providers.patch",
    ),
    "utm-reference": (
        "src/benchmark/upstream/fleet/myco_fleet_provider.py",
        "src/benchmark/upstream/fleet/utm_reference_provider.py",
        "src/benchmark/upstream/fleet/desktop_env_providers.patch",
    ),
}
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))


class ParityError(Exception):
    """The parity run cannot go ahead. The message is a code."""


def canonical_json(value):
    """The same canonical JSON as src/benchmark/upstream/prereg.ts canonicalJson."""
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def sample_sha256(sample):
    return hashlib.sha256(canonical_json(sample).encode("utf-8")).hexdigest()


def sha256_file(path):
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def stamp(osworld_dir, commit, provider, image_digest):
    """What this run used: OSWorld's harness files and the provider's Myco files, by digest."""
    files = {}
    for rel in HARNESS_FILES:
        digest = sha256_file(os.path.join(osworld_dir, rel))
        if digest is not None:
            files[rel] = digest
    fleet = {}
    for rel in FLEET_FILES[provider]:
        digest = sha256_file(os.path.join(REPO_ROOT, rel))
        if digest is not None:
            fleet[rel] = digest
    return {"repo": OSWORLD_REPO, "commit": commit, "files": files, "provider": provider,
            "imageDigest": image_digest, "fleetFiles": fleet}


def run_sequence(make_env, task_config, actions):
    """Run one scripted sequence through upstream's env; return (score or None, error code or None)."""
    env = make_env()
    try:
        env.reset(task_config=task_config)
        for action in actions:
            env.step(action)
        score = env.evaluate()
    except Exception:  # noqa: BLE001 - any failure is recorded as ungradable, never a score
        return None, "RUN_RAISED"
    finally:
        try:
            env.close()
        except Exception:  # noqa: BLE001
            pass
    if isinstance(score, bool) or not isinstance(score, (int, float)):
        return None, "SCORE_NOT_A_NUMBER"
    return float(score), None


def load_task(osworld_dir, task):
    path = os.path.join(osworld_dir, task["taskFile"])
    if sha256_file(path) != task["taskFileSha256"]:
        raise ParityError("TASK_FILE_CHANGED")
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def records_for(sample, osworld_dir, env_name, make_env, host_label, image_digest, commit,
                task_id=None, now=None):
    provider = PROVIDERS[env_name]
    run_stamp = stamp(osworld_dir, commit, provider, image_digest)
    digest = sample_sha256(sample)
    out = []
    tasks = [t for t in sample["tasks"] if task_id is None or t["taskId"] == task_id]
    if not tasks:
        raise ParityError("TASK_NOT_IN_SAMPLE")
    for task in tasks:
        config = load_task(osworld_dir, task)
        for sequence, key in SEQUENCES:
            score, error = run_sequence(make_env, config, task[key])
            out.append({
                "schema": "myco.parity.record/1",
                "label": LABEL,
                "env": env_name,
                "provider": provider,
                "taskId": task["taskId"],
                "sequence": sequence,
                "score": score,
                "error": error,
                "graderVersion": GRADER_VERSION,
                "sampleSha256": digest,
                "hostLabel": host_label,
                "at": (now or (lambda: datetime.datetime.now(datetime.timezone.utc)
                                .strftime("%Y-%m-%dT%H:%M:%SZ")))(),
                "stamp": run_stamp,
            })
    return out


def real_env_factory(osworld_dir, provider):
    """Upstream DesktopEnv with the patched provider registry. Imported only when running."""
    for path in (HERE, osworld_dir):
        if path not in sys.path:
            sys.path.insert(0, path)
    from desktop_env.desktop_env import DesktopEnv  # noqa: PLC0415 - only in a real run

    def make():
        return DesktopEnv(provider_name=provider, action_space="claude_computer_use",
                          screen_size=(1920, 1080), headless=True, os_type="Ubuntu",
                          require_a11y_tree=False, enable_proxy=False)
    return make


def git_head(osworld_dir):
    head = os.path.join(osworld_dir, ".git", "HEAD")
    if not os.path.isfile(head):
        return None
    with open(head, encoding="utf-8") as f:
        value = f.read().strip()
    return value if re.match(r"^[0-9a-f]{40}$", value) else None


def main(argv=None, make_env_for=real_env_factory):
    p = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    p.add_argument("--osworld", required=True)
    p.add_argument("--sample", default=os.path.join(REPO_ROOT, "docs/benchmark/upstream/r1-parity-sample.json"))
    p.add_argument("--env", required=True, choices=sorted(PROVIDERS))
    p.add_argument("--host-label", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--task", default=None)
    p.add_argument("--reference-approved", default=None)
    args = p.parse_args(argv)
    if args.env == "reference" and not APPROVAL.match(args.reference_approved or ""):
        raise ParityError("REFERENCE_RUN_NOT_APPROVED")
    if not args.host_label.strip():
        raise ParityError("HOST_UNLABELLED")
    commit = git_head(args.osworld)
    if commit != OSWORLD_COMMIT:
        raise ParityError("OSWORLD_NOT_AT_PIN")
    image_digest = None
    if args.env == "fleet":
        ref = os.environ.get("MYCO_FLEET_IMAGE", "")
        image_digest = ref.rpartition("@")[2] if "@sha256:" in ref else None
        if image_digest is None:
            raise ParityError("IMAGE_NOT_DIGEST_PINNED")
    with open(args.sample, encoding="utf-8") as f:
        sample = json.load(f)
    records = records_for(sample, args.osworld, args.env,
                          make_env_for(args.osworld, PROVIDERS[args.env]),
                          args.host_label, image_digest, commit, args.task)
    with open(args.out, "a", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except ParityError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(2)
