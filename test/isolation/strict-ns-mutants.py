#!/usr/bin/env python3
"""Mutation proof for the strict-linux-ns guards (track L2).

Applies one mutant at a time to src/isolation/strict-linux-ns.ts, runs
`npx vitest run test/isolation` with MYCO_STRICT_NS_REQUIRED=1, records KILLED (the
suite failed) or SURVIVED, then restores the file byte for byte. Needs a host where
the strict backend starts (unprivileged user namespaces). Exit 1 if an unexpected
mutant survives.

Usage: python3 test/isolation/strict-ns-mutants.py [MUTANT_ID ...]
"""

import os
import subprocess
import sys

SRC = "src/isolation/strict-linux-ns.ts"

# (id, guard, old, new, expected) — expected is "killed", or "survives" for a layered
# guard whose other layer still holds (listed so the table is honest).
MUTANTS = [
    ("M1", "detach the host root after pivot_root", "umount -l /.old\n", "\n", "killed"),
    ("M2", "agent runs in a NESTED user namespace (locked mounts, no caps over them)",
     # (--map-user implies --user in util-linux, so the whole clause has to go.)
     "unshare --user --mount --pid --fork --kill-child --mount-proc"
     " --map-user=${AGENT_UID} --map-group=${AGENT_UID}",
     "unshare --mount --pid --fork --kill-child --mount-proc", "killed"),
    ("M3", "agent is uid 1000, not root, in its namespace",
     "--map-user=${AGENT_UID} --map-group=${AGENT_UID}", "--map-root-user", "killed"),
    ("M4", "no_new_privs", "exec setpriv --no-new-privs -- unshare", "exec unshare", "killed"),
    ("M5", "trial root is read-only", 'mount -o remount,bind,ro,nosuid,nodev "$NEW"\n', "\n",
     "killed"),
    ("M6", "system dirs are read-only binds", 'mount -o remount,bind,ro,nosuid,nodev "$NEW/$d"\n',
     "\n", "killed"),
    ("M7", "/evidence is read-only", 'mount -o remount,bind,ro,nosuid,nodev "$NEW/evidence"\n',
     "\n", "killed"),
    ("M8", "trial has its own network namespace", '"--pid",\n        "--net",',
     '"--pid",', "killed"),
    ("M9", "trial has its own pid namespace", '        "--pid",\n        "--net",',
     '        "--net",', "killed"),
    ("M10", "exec checks it reached the right trial (nonce)",
     '[ "$n" = "$1" ] || exit ${SETUP_EXIT}', "true", "killed"),
    ("M11", "harness requires the in-trial handshake on fd 3",
     'if (!entered.startsWith("MYCO-ENTERED\\n")) {', "if (false) {", "killed"),
    ("M12", "empty agent environment (env -i)", '-- env -i "$@"', '-- env "$@"', "killed"),
    ("M13", "pid 1 reaps orphans", "cat >/dev/null <&3 &\nexec 3<&-\nwait $!",
     "exec cat >/dev/null <&3", "killed"),
    ("M14", "trial dies with the harness (holder exits on stdin EOF)",
     "cat >/dev/null <&3 &\nexec 3<&-\nwait $!", "sleep 2147483647 &\nwait $!", "killed"),
    ("M15", "timeout kills the command's process tree",
     "for (const c of inits.length > 0 ? inits : kids) killQuietly(c);",
     "void inits;", "killed"),
    ("M16", "each exec has its own pid ns and /proc", " --mount-proc", "", "killed"),
    ("M17", "per-process memory/CPU rlimits", 'prlimit --as="$AS" --cpu="$CPU" --',
     'prlimit --', "killed"),
    ("M18", "root must be a real dir (no symlink)",
     "if (!st.isDirectory() || realpathSync(root) !== path.resolve(root))",
     "if (!st.isDirectory())", "killed"),
    ("M19", "hide dir must not be inside the trial root",
     "if (within(form, realRoot))", "if (false)", "killed"),
    ("M20", "self-check: agent uid", 'if (kv.get("uid") !== String(AGENT_UID))', "if (false)",
     "killed"),
    ("M21", "self-check: no_new_privs", 'if (kv.get("NoNewPrivs") !== "1")', "if (false)", "killed"),
    ("M22", "self-check: right trial root", 'if (kv.get("nsroot") !== want.nonce)', "if (false)",
     "killed"),
    ("M23", "self-check: root not writable", 'if (kv.get("rootwritable") === "1")', "if (false)",
     "killed"),
    ("M24", "self-check: fresh pid namespace", '|| Number(kv.get("pid")) > 64', "", "killed"),
    ("M25", "self-check: only allowed mounts", "if (!ALLOWED_MOUNTS.has(mp))", "if (false)",
     "killed"),
    ("M26", "self-check: read-only mounts", "if (MUST_BE_RO.has(mp) &&", "if (false &&", "killed"),
    ("M27", "self-check: loopback only", 'if (d.replace(/:$/, "") !== "lo")', "if (false)",
     "killed"),
    ("M28", "self-check: hide paths invisible (evaluation)",
     'if (kv.get(`visible${i}`) === "1")', "if (false)", "killed"),
    ("M29", "self-check: hide paths invisible (in-trial probe)",
     "then echo \"visible${i}=1\"; fi", "then :; fi", "killed"),
    ("M30", "self-check: capabilities empty",
     'if (!/^0+$/.test(kv.get(c) ?? ""))', "if (false)", "killed"),
    # #551 round 1 D1: capture walks one component at a time, never following a link.
    ("M31", "capture: final component opened O_NOFOLLOW",
     "fsc.O_RDONLY | fsc.O_NOFOLLOW | fsc.O_NONBLOCK", "fsc.O_RDONLY | fsc.O_NONBLOCK", "killed"),
    ("M32", "capture: fstat refuses non-regular files",
     'if (!fst.isFile()) throw new StrictIsolationError("STRICT_NS_BAD_FILE", "not a regular file");',
     "", "killed"),
    ("M33", "capture: directory components opened O_NOFOLLOW",
     "next = openSync(`/proc/self/fd/${dirFd}/${name}`, DIR);",
     "next = openSync(`/proc/self/fd/${dirFd}/${name}`, fsc.O_RDONLY | fsc.O_DIRECTORY);",
     "killed"),
    ("M34", "destroy: never delete the root while trial processes live",
     "if (processesGone) rmSync(root", "if (true) rmSync(root", "survives"),
    ("M35", "spec: refuse Xvfb display", 'if (spec.display !== "none")', "if (false)", "killed"),
    ("M36", "capture: walk per component (revert to one full-path open, #551 D1 as found)",
     "for (const name of parts.slice(0, -1)) {", "for (const name of [] as string[]) {", "killed",
     ("`/proc/self/fd/${dirFd}/${parts[parts.length - 1]}`", "path.join(real, ...parts)")),
    ("M37", "capture: base must be a real directory",
     "if (real !== path.resolve(base))", "if (false)", "killed"),
    ("M38", "capture: refuse '..' components",
     'if (parts.length === 0 || parts.includes(".."))', "if (parts.length === 0)", "killed"),
    # #551 round 1 D2: hide entries compared by real path.
    ("M39", "spec: hide entries compared by real path (revert to lexical)",
     "for (const form of new Set([path.resolve(h), realPathOf(h)])) {",
     "for (const form of [path.resolve(h)]) {", "killed"),
    ("M40", "spec: system bind sources include their real paths",
     "    out.add(realPathOf(s));\n", "", "killed"),
    ("M41", "self-check: probe each hide entry at its real path too",
     "    out.add(realPathOf(h));\n", "", "killed"),
    ("M42", "spec: a hide entry's real path must be plain",
     "if (!SAFE_PATH.test(realPathOf(h)))", "if (false)", "killed"),
    ("M43", "spec: a dangling hide link is followed to where it would land",
     "if (link !== undefined) return", "if (false) return", "killed"),
    # #551 round 1 verifier V5/V6.
    ("M44", "/workspace is nosuid,nodev (now checked by the self-check)",
     'mount -o remount,bind,nosuid,nodev "$NEW/workspace"\n', "\n", "killed"),
    ("M45", "self-check: writable mounts are nosuid,nodev",
     "MUST_BE_NOSUID_NODEV.has(mp) &&", "false &&", "killed"),
    ("M46", "the agent does not inherit the fd-3 handshake pipe",
     "exec 3>&-\nexec setpriv", "exec setpriv", "killed"),
]


def run_suite() -> bool:
    env = dict(os.environ, MYCO_STRICT_NS_REQUIRED="1")
    r = subprocess.run(
        ["npx", "vitest", "run", "test/isolation"],
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=600,
    )
    return r.returncode == 0


def main() -> int:
    want = set(sys.argv[1:])
    original = open(SRC, encoding="utf8").read()
    if not run_suite():
        print("baseline suite fails; fix it first")
        return 1
    bad = 0
    print("| Mutant | Guard | Expected | Result |")
    print("| --- | --- | --- | --- |")
    try:
        for m in MUTANTS:
            mid, guard, old, new, expected = m[:5]
            if want and mid not in want:
                continue
            text = original
            for o, n in [(old, new), *([m[5]] if len(m) > 5 else [])]:
                if text.count(o) != 1:
                    print(f"| {mid} | {guard} | {expected} | NOT APPLIED ({text.count(o)} matches) |")
                    bad += 1
                    break
                text = text.replace(o, n)
            else:
                open(SRC, "w", encoding="utf8").write(text)
                passed = run_suite()
                result = "survives" if passed else "killed"
                if result != expected:
                    bad += 1
                print(f"| {mid} | {guard} | {expected} | **{result}** |", flush=True)
            open(SRC, "w", encoding="utf8").write(original)
    finally:
        open(SRC, "w", encoding="utf8").write(original)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
