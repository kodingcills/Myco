/**
 * Track L2: strict-linux-ns. The unit block runs everywhere. The namespace block needs
 * unprivileged user namespaces; without them it skips with "skipped: no userns", and
 * MYCO_STRICT_NS_REQUIRED=1 (set in CI) turns that skip into a failure.
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGENT_UID,
  checkSpec,
  evaluateSelfCheck,
  readTrialFile,
  runInTrial,
  StrictIsolationError,
  type StrictTrialDesktop,
  type StrictTrialSpec,
  strictLinuxNs,
  trialPids,
} from "../../src/isolation/strict-linux-ns.ts";

const scratch: string[] = [];
function mkRun(): string {
  const d = mkdtempSync(path.join(realpathSync(tmpdir()), "myco-strict-test-"));
  scratch.push(d);
  return d;
}
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function spec(root: string, over: Partial<StrictTrialSpec> = {}): StrictTrialSpec {
  return {
    runId: "trial-a",
    root,
    hide: [],
    memoryMbPerTrial: 1024,
    cpuSecondsPerTrial: 60,
    display: "none",
    ...over,
  };
}

async function codeOf(p: Promise<unknown> | (() => unknown)): Promise<string> {
  try {
    if (typeof p === "function") p();
    else await p;
  } catch (e) {
    if (e instanceof StrictIsolationError) return e.code;
    return `non-coded: ${String(e)}`;
  }
  return "no error";
}

/** Every file under `dir` with its bytes, for before/after comparisons. */
function snapshot(dir: string, skip: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (skip.some((s) => p === s || p.startsWith(`${s}/`))) continue;
      if (e.isDirectory()) {
        out[`${p}/`] = "dir";
        walk(p);
      } else if (e.isSymbolicLink()) out[p] = `link:${readlinkSync(p)}`;
      else out[p] = readFileSync(p).toString("base64");
    }
  };
  walk(dir);
  return out;
}

/* ================================================================== unit (no userns) */

describe("strict-linux-ns: spec checks (fail closed before the kernel)", () => {
  it("refuses a missing, symlinked, non-empty or system-dir root", async () => {
    const run = mkRun();
    expect(await codeOf(() => checkSpec(spec(path.join(run, "nope"))))).toBe("STRICT_NS_BAD_ROOT");
    mkdirSync(path.join(run, "real"));
    symlinkSync(path.join(run, "real"), path.join(run, "link"));
    expect(await codeOf(() => checkSpec(spec(path.join(run, "link"))))).toBe("STRICT_NS_BAD_ROOT");
    // A real dir under a symlinked ancestor: the binds would follow the link.
    mkdirSync(path.join(run, "real2", "t"), { recursive: true });
    symlinkSync(path.join(run, "real2"), path.join(run, "link2"));
    expect(await codeOf(() => checkSpec(spec(path.join(run, "link2", "t"))))).toBe(
      "STRICT_NS_BAD_ROOT",
    );
    mkdirSync(path.join(run, "full"));
    writeFileSync(path.join(run, "full", "x"), "x");
    expect(await codeOf(() => checkSpec(spec(path.join(run, "full"))))).toBe("STRICT_NS_BAD_ROOT");
    expect(await codeOf(() => checkSpec(spec("relative/dir")))).toBe("STRICT_NS_BAD_ROOT");
    expect(await codeOf(() => checkSpec(spec("/usr/share")))).toBe("STRICT_NS_BAD_ROOT");
    expect(await codeOf(() => checkSpec(spec(path.join(run, "real"))))).toBe("no error");
  });

  it("refuses hide dirs that the trial's binds would expose", async () => {
    const run = mkRun();
    const root = path.join(run, "t");
    mkdirSync(root);
    expect(
      await codeOf(() => checkSpec(spec(root, { hide: [path.join(root, "workspace")] }))),
    ).toBe("STRICT_NS_HIDE_OVERLAP");
    expect(await codeOf(() => checkSpec(spec(root, { hide: [root] })))).toBe(
      "STRICT_NS_HIDE_OVERLAP",
    );
    expect(await codeOf(() => checkSpec(spec(root, { hide: ["/usr/lib/secret-run"] })))).toBe(
      "STRICT_NS_HIDE_OVERLAP",
    );
    // The run root containing the trial root is the normal case.
    expect(await codeOf(() => checkSpec(spec(root, { hide: [run] })))).toBe("no error");
  });

  it("refuses an Xvfb display rather than pretending to give one", async () => {
    const run = mkRun();
    expect(await codeOf(() => checkSpec(spec(run, { display: "xvfb" })))).toBe(
      "STRICT_NS_DISPLAY_UNSUPPORTED",
    );
  });

  it("refuses bad run ids, caps and env keys", async () => {
    const run = mkRun();
    expect(await codeOf(() => checkSpec(spec(run, { runId: "../x" })))).toBe("STRICT_NS_BAD_SPEC");
    expect(await codeOf(() => checkSpec(spec(run, { memoryMbPerTrial: 0 })))).toBe(
      "STRICT_NS_BAD_SPEC",
    );
    expect(await codeOf(() => checkSpec(spec(run, { cpuSecondsPerTrial: Number.NaN })))).toBe(
      "STRICT_NS_BAD_SPEC",
    );
    expect(await codeOf(() => checkSpec(spec(run, { env: { "A=B": "x" } })))).toBe(
      "STRICT_NS_BAD_SPEC",
    );
  });
});

describe("strict-linux-ns: the backend refuses to start on a host that cannot do it", () => {
  it("off Linux: create and probe refuse with a code", async () => {
    const run = mkRun();
    const b = strictLinuxNs({ platform: "darwin" });
    expect(await codeOf(b.create(spec(run)))).toBe("STRICT_NS_UNSUPPORTED_PLATFORM");
    const p = await b.probe();
    expect(p).toMatchObject({ available: false, code: "STRICT_NS_UNSUPPORTED_PLATFORM" });
  });

  it("a missing tool: refuse with a code", async () => {
    const run = mkRun();
    const b = strictLinuxNs({
      platform: "linux",
      tools: { unshare: path.join(run, "no-such-unshare") },
    });
    expect(await codeOf(b.create(spec(run)))).toBe("STRICT_NS_TOOL_MISSING");
    expect((await b.probe()).code).toBe("STRICT_NS_TOOL_MISSING");
  });

  it("namespaces denied (unshare fails): refuse with a code, leave nothing behind", async () => {
    if (process.platform !== "linux") return;
    const run = mkRun();
    const stub = path.join(run, "unshare-denied");
    writeFileSync(stub, "#!/bin/sh\necho 'unshare: Operation not permitted' >&2\nexit 1\n");
    chmodSync(stub, 0o755);
    const root = path.join(run, "t");
    mkdirSync(root);
    const b = strictLinuxNs({ tools: { unshare: stub } });
    expect(await codeOf(b.create(spec(root)))).toBe("STRICT_NS_SETUP_FAILED");
    expect(existsSync(root)).toBe(false);
    expect(await b.probe()).toMatchObject({ available: false, code: "STRICT_NS_SETUP_FAILED" });
  });
});

describe("strict-linux-ns: self-check evaluation", () => {
  const good = [
    `uid=${AGENT_UID}`,
    "CapInh=0000000000000000",
    "CapPrm=0000000000000000",
    "CapEff=0000000000000000",
    "CapAmb=0000000000000000",
    "NoNewPrivs=1",
    "nsroot=N",
    "mount=/ ro,nosuid,nodev,relatime",
    "mount=/usr ro,nosuid,nodev,relatime",
    "mount=/workspace rw,nosuid,nodev,relatime",
    "mount=/evidence ro,nosuid,nodev,relatime",
    "mount=/tmp rw,nosuid,nodev,relatime",
    "mount=/proc rw,nosuid,nodev,noexec,relatime",
    "netdev=lo:",
    "pid=1",
    "end=1",
  ];
  const want = { nonce: "N", hideCount: 1 };
  const without = (prefix: string) => good.filter((l) => !l.startsWith(prefix));

  it("accepts the strict shape", () => {
    expect(evaluateSelfCheck(good.join("\n"), want)).toEqual([]);
  });
  it.each([
    ["root uid", [...without("uid="), "uid=0"]],
    ["a capability", [...without("CapEff="), "CapEff=000001ffffffffff"]],
    ["no no_new_privs", [...without("NoNewPrivs="), "NoNewPrivs=0"]],
    ["another trial's root", [...without("nsroot="), "nsroot=OTHER"]],
    ["a writable root", [...good, "rootwritable=1"]],
    ["a host pid namespace", [...without("pid="), "pid=4242"]],
    ["an extra mount (the run root)", [...good, "mount=/srv/run rw,relatime"]],
    ["a writable /usr", [...without("mount=/usr"), "mount=/usr rw,nosuid,nodev"]],
    ["a writable /evidence", [...without("mount=/evidence"), "mount=/evidence rw,nosuid"]],
    ["a host network device", [...good, "netdev=eth0:"]],
    ["a visible hide dir", [...good, "visible0=1"]],
    ["a visible host root", [...good, "visible1=1"]],
    ["a truncated report", without("end=")],
    ["no private /tmp", without("mount=/tmp")],
  ])("refuses %s", (_name, lines) => {
    expect(evaluateSelfCheck(lines.join("\n"), want).length).toBeGreaterThan(0);
  });
});

describe("strict-linux-ns: host-side capture of trial files (no follow, no block)", () => {
  it("reads a regular file", () => {
    const run = mkRun();
    writeFileSync(path.join(run, "f"), "hello");
    expect(readTrialFile(path.join(run, "f")).toString()).toBe("hello");
  });
  it("refuses a symlink, a directory, a FIFO (without hanging) and an oversize file", async () => {
    const run = mkRun();
    writeFileSync(path.join(run, "target"), "x");
    symlinkSync(path.join(run, "target"), path.join(run, "link"));
    mkdirSync(path.join(run, "dir"));
    writeFileSync(path.join(run, "big"), "0123456789");
    expect(await codeOf(() => readTrialFile(path.join(run, "link")))).toBe("STRICT_NS_BAD_FILE");
    expect(await codeOf(() => readTrialFile(path.join(run, "dir")))).toBe("STRICT_NS_BAD_FILE");
    expect(await codeOf(() => readTrialFile(path.join(run, "big"), 4))).toBe("STRICT_NS_BAD_FILE");
    expect(await codeOf(() => readTrialFile(path.join(run, "missing")))).toBe("STRICT_NS_BAD_FILE");
    if (process.platform === "linux") {
      const r = spawn("mkfifo", [path.join(run, "fifo")]);
      await new Promise((res) => r.on("close", res));
      expect(await codeOf(() => readTrialFile(path.join(run, "fifo")))).toBe("STRICT_NS_BAD_FILE");
    }
  });
});

/* ================================================================== namespaces */

const probe =
  process.platform === "linux"
    ? await strictLinuxNs().probe()
    : { available: false, code: "STRICT_NS_UNSUPPORTED_PLATFORM", detail: process.platform };
const required = process.env.MYCO_STRICT_NS_REQUIRED === "1";
if (!probe.available)
  process.stderr.write(`strict-linux-ns: skipped: no userns (${probe.detail})\n`);

describe("strict-linux-ns: availability", () => {
  it.runIf(required)("is available where CI requires it (MYCO_STRICT_NS_REQUIRED=1)", () => {
    expect(probe).toMatchObject({ available: true });
  });
  if (!probe.available && !required) it.skip(`skipped: no userns (${probe.detail})`, () => {});
});

/** Lay out a run root the way a pool does: trials/<id>/ plus a vault dir. */
function runLayout(ids: readonly string[]): { run: string; roots: Record<string, string> } {
  const run = mkRun();
  const roots: Record<string, string> = {};
  for (const id of ids) {
    roots[id] = path.join(run, "trials", id);
    mkdirSync(roots[id], { recursive: true });
  }
  mkdirSync(path.join(run, "vaults", "B"), { recursive: true });
  writeFileSync(path.join(run, "vaults", "B", "sealed.json"), '{"sealed":true}\n');
  return { run, roots };
}

const backend = strictLinuxNs();
const desktops: StrictTrialDesktop[] = [];
async function make(root: string, run: string, runId: string): Promise<StrictTrialDesktop> {
  const d = await backend.create(spec(root, { runId, hide: [run] }));
  desktops.push(d);
  return d;
}
afterAll(async () => {
  for (const d of desktops) await d.destroy();
});

/** Run a script as root of the trial's OWN user namespace (more than an agent gets). */
async function asTrialRoot(holderPid: number, script: string): Promise<string> {
  return await new Promise<string>((resolve) => {
    const c = spawn(
      "nsenter",
      [
        "-t",
        String(holderPid),
        "--user",
        "--mount",
        "--pid",
        "--net",
        "--preserve-credentials",
        "--",
        "/bin/sh",
        "-c",
        script,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let s = "";
    c.stdout.on("data", (d: Buffer) => {
      s += d.toString();
    });
    c.on("close", () => resolve(s));
  });
}

/** Every way a trial controls to unmount, remount, bind, pivot or reach a host path. */
function attackScript(run: string): string {
  const victim = `${run}/trials/B/workspace/record.csv`;
  return String.raw`
PATH=$PATH:/usr/sbin:/sbin
for m in $(awk '{print $5}' /proc/self/mountinfo | sort -r); do umount -l "$m" 2>/dev/null && echo "UMOUNTED $m"; done
umount -l '${run}' 2>/dev/null && echo "UMOUNTED run"
mount -o remount,rw / 2>/dev/null && echo "REMOUNTED /"
mount -o remount,rw /usr 2>/dev/null && echo "REMOUNTED /usr"
mount -o remount,rw /evidence 2>/dev/null && echo "REMOUNTED /evidence"
mount --bind / /tmp 2>/dev/null && echo "BOUND"
unshare -Urm sh -c '
  for m in $(awk "{print \$5}" /proc/self/mountinfo | sort -r); do umount -l "$m" 2>/dev/null && echo "NESTED-UMOUNTED $m"; done
  mount -o remount,rw /usr 2>/dev/null && echo "NESTED-REMOUNTED /usr"
  mount -o remount,rw /evidence 2>/dev/null && echo "NESTED-REMOUNTED /evidence"
  mkdir -p /tmp/new /tmp/new/old && mount -t tmpfs t /tmp/new && cd /tmp/new && mkdir old && pivot_root . old 2>/dev/null && echo NESTED-PIVOTED
  ls -a / ; ls -a /old 2>/dev/null
  echo FORGED > "${victim}" 2>/dev/null && echo NESTED-WROTE
' 2>/dev/null
echo FORGED > '${victim}' 2>/dev/null && echo WROTE-PATH
echo FORGED > '/proc/1/root${victim}' 2>/dev/null && echo WROTE-PROC1
for p in /proc/[0-9]*; do echo FORGED > "$p/root${victim}" 2>/dev/null && echo "WROTE-VIA $p"; done
cd / && cd .. && cd .. && pwd && ls
ln -s '${victim}' /workspace/record.csv 2>/dev/null
ln -s / /workspace/rootlink 2>/dev/null
ls /workspace/rootlink/ | tr '\n' ' '; echo
find / -xdev -name sealed.json 2>/dev/null
find / \( -path /proc -o -path /usr -o -path /lib -o -path /lib32 -o -path /lib64 -o -path /libx32 -o -path /bin -o -path /sbin -o -path /etc \) -prune -o -name 'record.csv' -print 2>/dev/null
echo ATTACK-DONE
`;
}

describe.skipIf(!probe.available)("strict-linux-ns: in namespaces", () => {
  it("reports the strict isolation it verified as the agent", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    expect(a.isolation).toMatchObject({
      backend: "strict-linux-ns",
      privateRoot: true,
      hostDirsHidden: true,
      tmp: "mount-ns",
      network: "netns",
      processes: "pid-ns",
      mountsLocked: true,
      noNewPrivs: true,
      capabilities: "none",
      agentUid: AGENT_UID,
    });
    const r = await a.exec("/bin/sh", [
      "-c",
      "id -u; grep -E '^(CapEff|NoNewPrivs)' /proc/self/status; ls /; pwd",
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`^${AGENT_UID}\\n`));
    expect(r.stdout).toMatch(/CapEff:\s+0+\n/);
    expect(r.stdout).toMatch(/NoNewPrivs:\s+1\n/);
    expect(r.stdout).toContain("/workspace");
    expect(r.stdout).not.toContain("trials");
  });

  it("D1: an agent cannot unmount the hidden run root or write another trial's file", async () => {
    const { run, roots } = runLayout(["A", "B"]);
    const a = await make(roots.A!, run, "A");
    const b = await make(roots.B!, run, "B");
    const victim = path.join(b.paths.workspace, "record.csv");
    writeFileSync(victim, "B-ORIGINAL,1\n");
    const before = snapshot(run, [a.paths.workspace]);

    // The read-only system binds are pruned from the searches: on a CI runner /usr alone is
    // many GB, and the run root cannot be under a system bind (checkSpec refuses that).
    const r = await a.exec("/bin/sh", ["-c", attackScript(run)], { timeoutMs: 45_000 });
    expect(r.timedOut).toBe(false);
    expect(r.stdout).toContain("ATTACK-DONE");
    // Mounts are locked: nothing unmounted, remounted or bound from the agent's seat.
    expect(r.stdout).not.toMatch(/^UMOUNTED|^REMOUNTED|^BOUND|NESTED-REMOUNTED/m);
    // Nested-namespace unmounts of LOCKED mounts are refused (kernel MNT_LOCKED).
    expect(r.stdout).not.toMatch(/NESTED-UMOUNTED \/(workspace|evidence|usr|proc|tmp)?\n/);
    expect(r.stdout).not.toMatch(/WROTE|sealed\.json|trials/);
    // Byte-identical: B's workspace, the vault, the whole run root outside A's workspace.
    expect(readFileSync(victim, "utf8")).toBe("B-ORIGINAL,1\n");
    expect(snapshot(run, [a.paths.workspace])).toEqual(before);
    // The symlink A planted is refused by host-side capture.
    expect(await codeOf(() => readTrialFile(path.join(a.paths.workspace, "record.csv")))).toBe(
      "STRICT_NS_BAD_FILE",
    );
    // B still works and sees only its own file.
    const rb = await b.exec("/bin/cat", ["/workspace/record.csv"]);
    expect(rb.stdout).toBe("B-ORIGINAL,1\n");
  }, 60_000);

  it("D1 even with full capabilities in the trial's namespace: the run root is not in it", async () => {
    // Defense in depth: enter as root of the trial's OWN user namespace (more than any
    // agent gets) and unmount everything. pivot_root + detach left nothing to reveal.
    const { run, roots } = runLayout(["A", "B"]);
    const a = await make(roots.A!, run, "A");
    const b = await make(roots.B!, run, "B");
    const victim = path.join(b.paths.workspace, "record.csv");
    writeFileSync(victim, "B-ORIGINAL,1\n");
    const before = snapshot(run, [a.paths.workspace]);
    const script = `
grep -q . /.myco-trial || exit 3
for m in $(awk '{print $5}' /proc/self/mountinfo | sort -r); do umount -l "$m" 2>/dev/null && echo "UMOUNTED $m"; done
echo FORGED > '${victim}' 2>/dev/null && echo WROTE
[ -e '${run}' ] && echo RUN-VISIBLE
echo PRIV-DONE
`;
    const out = await asTrialRoot(a.target.holderPid, script);
    expect(out).toContain("PRIV-DONE");
    expect(out).toMatch(/UMOUNTED \/workspace/); // it really had the power to unmount ...
    expect(out).not.toMatch(/WROTE|RUN-VISIBLE/); // ... and still found nothing.
    expect(readFileSync(victim, "utf8")).toBe("B-ORIGINAL,1\n");
    expect(snapshot(run, [a.paths.workspace])).toEqual(before);
  }, 60_000);

  it("each exec has its own pid namespace and /proc: other processes are not visible", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    const long = a.exec("/bin/sh", ["-c", "echo $$ > /tmp/long.pid; exec sleep 30"], {
      timeoutMs: 1500,
    });
    await new Promise((r) => setTimeout(r, 300));
    const r = await a.exec("/bin/sh", [
      "-c",
      "ls /proc | grep -E '^[0-9]+$' | wc -l; ls /proc/*/cmdline >/dev/null; cat /proc/[0-9]*/comm | sort -u | tr '\\n' ' '; readlink /proc/1/root",
    ]);
    expect(r.stdout).not.toMatch(/\bsleep\b/);
    expect(Number(r.stdout.split("\n")[0])).toBeLessThan(8);
    expect(r.stdout.trim().endsWith("/")).toBe(true);
    const host = (await long).timedOut;
    expect(host).toBe(true);
  }, 60_000);

  it("network: only a loopback device, no route out", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    const r = await a.exec("/bin/sh", ["-c", "tail -n +3 /proc/net/dev | awk -F: '{print $1}'"]);
    expect(r.stdout.trim().split(/\s+/)).toEqual(["lo"]);
  });

  it("the host environment never reaches the trial", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    process.env.MYCO_STRICT_CANARY = "canary-not-a-secret";
    try {
      const r = await a.exec("/usr/bin/env", [], { env: { MYCO_MARK: "m1" } });
      expect(r.stdout).not.toContain("MYCO_STRICT_CANARY");
      // Exactly the trial's own env: nothing inherited from the harness or the wrapper.
      const keys = r.stdout
        .trim()
        .split("\n")
        .map((l) => l.split("=")[0])
        .sort();
      expect(keys).toEqual(["HOME", "LANG", "MYCO_MARK", "PATH", "TMPDIR", "USER"]);
    } finally {
      delete process.env.MYCO_STRICT_CANARY;
    }
  });

  it("an exec aimed at the wrong trial is refused before the command runs", async () => {
    const { run, roots } = runLayout(["A", "B"]);
    const a = await make(roots.A!, run, "A");
    const b = await make(roots.B!, run, "B");
    const tools = { nsenter: "nsenter" };
    const code = await codeOf(
      runInTrial(
        tools,
        { holderPid: a.target.holderPid, nonce: b.target.nonce },
        { memoryMb: 512, cpuSeconds: 10 },
        "/usr/bin/touch",
        ["/workspace/ran"],
        { PATH: "/usr/bin:/bin" },
      ),
    );
    expect(code).toBe("STRICT_NS_TRIAL_MISMATCH");
    expect(existsSync(path.join(a.paths.workspace, "ran"))).toBe(false);
    expect(existsSync(path.join(b.paths.workspace, "ran"))).toBe(false);
  });

  it("a timeout kills the command's whole process tree", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    const ns = readlinkSync(`/proc/${a.target.holderPid}/ns/pid`);
    const base = trialPids(ns); // the holder and its stdin watcher
    const r = await a.exec("/bin/sh", ["-c", "sleep 100 & sleep 100 & wait"], { timeoutMs: 400 });
    expect(r.timedOut).toBe(true);
    let left: number[] = [];
    for (let i = 0; i < 40; i++) {
      left = trialPids(ns).filter((p) => !base.includes(p));
      if (left.length === 0) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(left).toEqual([]);
  });

  it("planted markers: concurrent trials never see or touch each other", async () => {
    const ids = ["A", "B", "C", "D"];
    const { run, roots } = runLayout(ids);
    const ds = await Promise.all(ids.map((id) => make(roots[id]!, run, id)));
    const results = await Promise.all(
      ds.map((d, i) =>
        d.exec(
          "/bin/sh",
          [
            "-c",
            String.raw`
M="MYCO-MARKER-$MYCO_TRIAL"
for d in /workspace /tmp /home /dev/shm; do echo "$M" > "$d/marker-$MYCO_TRIAL"; done
if command -v python3 >/dev/null; then
  python3 -c '
import socket,os,time,sys
me=os.environ["MYCO_TRIAL"]
s=socket.socket(socket.AF_UNIX); s.bind("\0myco-"+me); s.listen(1)
time.sleep(0.8)
for o in "ABCD":
    if o==me: continue
    c=socket.socket(socket.AF_UNIX)
    try:
        c.connect("\0myco-"+o); print("REACHED-SOCKET",o)
    except OSError: pass
' &
fi
sleep 1
grep -rls "MYCO-MARKER-" / --exclude-dir=proc --exclude-dir=usr --exclude-dir=lib --exclude-dir=lib64 --exclude-dir=lib32 --exclude-dir=libx32 --exclude-dir=bin --exclude-dir=sbin --exclude-dir=etc 2>/dev/null | while read -r f; do echo "SAW $(cat "$f")"; done
wait
`,
          ],
          { env: { MYCO_TRIAL: ids[i]! }, timeoutMs: 60_000 },
        ),
      ),
    );
    results.forEach((r, i) => {
      const me = ids[i]!;
      const saw = [...r.stdout.matchAll(/^SAW MYCO-MARKER-(\w+)$/gm)].map((m) => m[1]);
      expect(saw.length).toBeGreaterThan(0); // it found its own markers ...
      expect(saw.every((s) => s === me)).toBe(true); // ... and only its own.
      expect(r.stdout).not.toContain("REACHED-SOCKET");
    });
    for (const [i, d] of ds.entries()) {
      expect(readdirSync(d.paths.workspace)).toEqual([`marker-${ids[i]}`]);
      expect(readFileSync(path.join(d.paths.workspace, `marker-${ids[i]}`), "utf8")).toBe(
        `MYCO-MARKER-${ids[i]}\n`,
      );
    }
    // Nothing outside the trial workspaces (the host /tmp included) holds a marker.
    const stray = Object.keys(snapshot(run)).filter(
      (p) => p.includes("marker-") && !ds.some((d) => p.startsWith(`${d.paths.workspace}/`)),
    );
    expect(stray).toEqual([]);
    expect(readdirSync(realpathSync(tmpdir())).filter((f) => f.startsWith("marker-"))).toEqual([]);
  }, 60_000);

  it("destroy kills everything, removes the root, is idempotent, and later execs are refused", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await backend.create(spec(roots.A!, { hide: [run] }));
    const ns = readlinkSync(`/proc/${a.target.holderPid}/ns/pid`);
    void a.exec("/bin/sh", ["-c", "sleep 100"]).catch(() => {});
    await new Promise((r) => setTimeout(r, 200));
    const rep = await a.destroy();
    expect(rep).toMatchObject({ processesGone: true, rootRemoved: true });
    expect(trialPids(ns)).toEqual([]);
    expect(existsSync(roots.A!)).toBe(false);
    expect(await a.destroy()).toBe(rep);
    expect(await codeOf(a.exec("/bin/true", []))).toBe("STRICT_NS_DESTROYED");
  });

  it("the trial dies with the harness (harness SIGKILLed)", async () => {
    const run = mkRun();
    const root = path.join(run, "t");
    mkdirSync(root);
    const mod = path.resolve("src/isolation/strict-linux-ns.ts");
    const script = path.join(run, "harness.mts");
    writeFileSync(
      script,
      `import { strictLinuxNs } from ${JSON.stringify(mod)};
const d = await strictLinuxNs().create({ runId: "h", root: ${JSON.stringify(root)}, hide: [], memoryMbPerTrial: 256, cpuSecondsPerTrial: 10, display: "none" });
void d.exec("/bin/sh", ["-c", "sleep 300"]);
setTimeout(() => process.stdout.write("PID " + d.target.holderPid + "\\n"), 300);
setInterval(() => {}, 1000);
`,
    );
    const child = spawn(process.execPath, ["--import", "tsx", script], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pid = await new Promise<number>((resolve, reject) => {
      let s = "";
      child.stdout.on("data", (d: Buffer) => {
        s += d.toString();
        const m = /PID (\d+)/.exec(s);
        if (m) resolve(Number(m[1]));
      });
      child.on("close", () => reject(new Error(`harness exited early: ${s}`)));
    });
    const ns = readlinkSync(`/proc/${pid}/ns/pid`);
    child.kill("SIGKILL");
    let left: number[] = [];
    for (let i = 0; i < 60; i++) {
      left = trialPids(ns);
      if (left.length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(left).toEqual([]);
  }, 30_000);

  it("never falls back: a setup without a network namespace is refused, not reported strict", async () => {
    const run = mkRun();
    const stub = path.join(run, "unshare-weak");
    writeFileSync(
      stub,
      `#!/bin/sh
n=$#; i=0
while [ $i -lt $n ]; do a=$1; shift; i=$((i+1)); [ "$a" = "--net" ] || set -- "$@" "$a"; done
exec unshare "$@"
`,
    );
    chmodSync(stub, 0o755);
    const hostDevs = readFileSync("/proc/net/dev", "utf8")
      .split("\n")
      .slice(2)
      .map((l) => l.split(":")[0]!.trim())
      .filter((x) => x && x !== "lo");
    const root = path.join(run, "t");
    mkdirSync(root);
    const code = await codeOf(strictLinuxNs({ tools: { unshare: stub } }).create(spec(root)));
    if (hostDevs.length === 0) {
      process.stderr.write(
        "strict-linux-ns: host has no network device; no-netns case not distinguishable\n",
      );
      return;
    }
    expect(code).toBe("STRICT_NS_SELFCHECK_FAILED");
    expect(existsSync(root)).toBe(false);
  });

  it("never falls back: a setup without a pid namespace is refused", async () => {
    const run = mkRun();
    const stub = path.join(run, "unshare-nopid");
    writeFileSync(
      stub,
      `#!/bin/sh
n=$#; i=0
while [ $i -lt $n ]; do a=$1; shift; i=$((i+1)); [ "$a" = "--pid" ] || set -- "$@" "$a"; done
exec unshare "$@"
`,
    );
    chmodSync(stub, 0o755);
    const root = path.join(run, "t");
    mkdirSync(root);
    const code = await codeOf(strictLinuxNs({ tools: { unshare: stub } }).create(spec(root)));
    expect(code).toMatch(/^STRICT_NS_(SETUP|SELFCHECK)_FAILED$/);
    expect(existsSync(root)).toBe(false);
  });

  it("pid 1 of the trial reaps orphans (no zombies left after an exec's parent dies)", async () => {
    const { run, roots } = runLayout(["A"]);
    const a = await make(roots.A!, run, "A");
    const ns = readlinkSync(`/proc/${a.target.holderPid}/ns/pid`);
    const base = trialPids(ns);
    // The background sleep outlives its parent, is re-parented to pid 1, then exits.
    await asTrialRoot(a.target.holderPid, "sleep 0.2 & exit 0");
    let left: number[] = [];
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 50));
      left = trialPids(ns).filter((p) => !base.includes(p));
      if (i > 8 && left.length === 0) break;
    }
    expect(left).toEqual([]);
  });

  it("a hide path that exists inside the trial is refused at create (self-check probe)", async () => {
    const run = mkRun();
    const root = path.join(run, "t");
    mkdirSync(root);
    // /etc/hosts exists in the generated /etc, so the in-trial probe must see it.
    const code = await codeOf(backend.create(spec(root, { hide: ["/etc/hosts"] })));
    expect(code).toBe("STRICT_NS_SELFCHECK_FAILED");
    expect(existsSync(root)).toBe(false);
  });

  it("per-process memory and CPU-time limits apply inside the trial", async () => {
    const run = mkRun();
    const root = path.join(run, "t");
    mkdirSync(root);
    const d = await backend.create(
      spec(root, { hide: [run], memoryMbPerTrial: 64, cpuSecondsPerTrial: 1 }),
    );
    desktops.push(d);
    const mem = await d.exec("/bin/sh", [
      "-c",
      'awk \'BEGIN { s = sprintf("%200000000s", ""); print length(s) }\'',
    ]);
    expect(mem.code).not.toBe(0);
    expect(mem.stdout).not.toContain("200000000");
    const t0 = Date.now();
    const cpu = await d.exec("/bin/sh", ["-c", "while :; do :; done"], { timeoutMs: 20_000 });
    expect(cpu.timedOut).toBe(false);
    expect(cpu.code === 0).toBe(false);
    expect(Date.now() - t0).toBeLessThan(15_000);
  }, 30_000);
});
