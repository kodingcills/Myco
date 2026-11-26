/**
 * TIF-220: deploy-to-vm.sh must survive sshd dropping a connection mid-copy
 * just after a cold boot, without ever trusting a partial copy, and must still
 * fail loudly when the drops do not stop.
 *
 * The incident: row-8 trial 14's reset printed `ready on 'clean-base'`, then the
 * deploy's first scp died with "Connection to 127.0.0.1 closed by remote host" /
 * "scp: Connection closed" and the trial was recorded `deploy-failed`.
 *
 * Every scenario drives the real script against stub `ssh`, `scp` and `nc`
 * first on PATH, with a temp directory standing in for the guest's C: drive.
 * The real VM is never contacted: HOME and VM_SSH_CONFIG point into the temp
 * dir, the stubs refuse to act on any other ssh config, and each stub writes a
 * marker so a stub shadowed by a real binary fails the run instead of silently
 * reaching the guest (the negative-control lesson in wait-guest-ready.test.ts).
 */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const DEPLOY = join(import.meta.dirname, "..", "agent", "bootstrap", "deploy-to-vm.sh");

let dir = "";
let stubDir = "";
let src = "";
let guest = "";
let cfg = "";
let wheels = "";
let egressStub = "";

const AGENT_DIR_REL = "C/Program Files/Myco/agent";

function writeStub(name: string, body: string): void {
  const marker = join(dir, `${name}.marker`);
  writeFileSync(
    join(stubDir, name),
    `#!/bin/bash
echo ran >> "${marker}"
# Refuse anything but the test's own ssh config: never the real VM's.
if [ "${name}" != nc ]; then
  prev=""; ok=0
  for a in "$@"; do [ "$prev" = "-F" ] && [ "$a" = "${cfg}" ] && ok=1; prev="$a"; done
  [ "$ok" = 1 ] || { echo "stub ${name}: refusing, not the test ssh config" >&2; exit 99; }
fi
${body}
`,
    { mode: 0o755 },
  );
}

/**
 * Install the fake guest.
 *
 * `scpDrops` = how many initial scp invocations drop the connection;
 * `treeDrops` = how many initial tree (`scp -r`) copies drop. A dropped
 * tree copy first lands a PARTIAL tree (one file truncated, the rest missing),
 * so a deploy that trusted it would carry a broken agent forward.
 * `silentTruncate` = the first tree copy exits 0 but leaves a truncated file:
 * only the manifest check can catch that.
 */
function installStubs(opts: {
  scpDrops: number;
  treeDrops?: number;
  silentTruncate?: boolean;
  registerFails?: boolean;
  /** The agent never answers the ping: every nc returns a non-ok reply. */
  pingFails?: boolean;
}): void {
  const counter = join(dir, "scp.count");
  writeFileSync(counter, "0");
  const treeCounter = join(dir, "tree.count");
  writeFileSync(treeCounter, "0");
  writeStub(
    "scp",
    `n=$(( $(cat "${counter}") + 1 )); echo "$n" > "${counter}"
recursive=0; args=()
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    -q) ;;
    -r) recursive=1 ;;
    -F|-o) skip=1 ;;
    *) args+=("$a") ;;
  esac
done
dest="\${args[\${#args[@]}-1]}"
unset 'args[\${#args[@]}-1]'
path="\${dest#*:}"; path="${guest}/\${path/C:/C}"
t=$(cat "${treeCounter}")
if [ "$recursive" = 1 ]; then t=$(( t + 1 )); echo "$t" > "${treeCounter}"; fi
if [ "$n" -le ${opts.scpDrops} ] || { [ "$recursive" = 1 ] && [ "$t" -le ${opts.treeDrops ?? 0} ]; }; then
  if [ "$recursive" = 1 ]; then
    # Partial copy: the first file of the first source, truncated.
    first=$(find "\${args[0]}" -type f | sort | head -1)
    rel="\${first#\${args[0]%/*}/}"
    mkdir -p "$path/$(dirname "$rel")"
    head -c 3 "$first" > "$path/$rel"
  fi
  echo "Connection to 127.0.0.1 closed by remote host." >&2
  echo "scp: Connection closed" >&2
  exit 255
fi
if [ "$recursive" = 1 ]; then
  cp -R "\${args[@]}" "$path"
  if [ "${opts.silentTruncate ? 1 : 0}" = 1 ] && [ ! -e "${dir}/truncated" ]; then
    touch "${dir}/truncated"
    : > "$path/myco_agent/core.py"
  fi
else
  case "$path" in
    *ProgramData*)
      # Token write: record whether the tree on the guest was complete at this moment.
      if cmp -s "${src}/myco_agent/core.py" "${guest}/${AGENT_DIR_REL}/myco_agent/core.py"; then
        echo core_ok=yes; else echo core_ok=no; fi >> "${dir}/token.log" ;;
  esac
  mkdir -p "$(dirname "$path")"
  cp "\${args[@]}" "$path"
fi
exit 0`,
  );
  writeStub(
    "ssh",
    `for a in "$@"; do [ "$a" = "-N" ] && exec sleep 30; done
cmd="\${*: -1}"
case "$cmd" in
  *"-Stage prepare"*)
    mkdir -p "${guest}/${AGENT_DIR_REL}" "${guest}/C/ProgramData/Myco"; echo prepared ;;
  *"-Stage manifest"*)
    cd "${guest}/${AGENT_DIR_REL}" 2>/dev/null || exit 0
    for r in myco_agent bootstrap pyproject.toml; do [ -e "$r" ] && find "$r" -type f; done \\
      | while IFS= read -r f; do shasum -a 256 "$f"; done | sed 's/$/\\r/' ;;
  *"-Stage register"*)
    # Record whether the tree on the guest was complete when the agent was registered.
    if cmp -s "${src}/myco_agent/core.py" "${guest}/${AGENT_DIR_REL}/myco_agent/core.py"; then
      echo core_ok=yes; else echo core_ok=no; fi >> "${dir}/register.log"
    if [ "${opts.registerFails ? 1 : 0}" = 1 ]; then echo "register failed" >&2; exit 1; fi
    echo registered ;;
  *) echo "stub ssh: unexpected command: $cmd" >&2; exit 98 ;;
esac`,
  );
  writeStub(
    "nc",
    opts.pingFails
      ? `cat >/dev/null; echo '{"ok": false, "id": 1, "error": {"code": "AUTH_FAILED"}}'`
      : `cat >/dev/null; echo '{"ok": true, "id": 1, "result": {}}'`,
  );
}

interface DeployRun {
  status: number | null;
  stdout: string;
  stderr: string;
  scpCalls: number;
}

function runDeploy(extra: Record<string, string> = {}): Promise<DeployRun> {
  return new Promise((resolve) => {
    // A minimal environment, never an inherited one: an inherited PATH could
    // put the host's real ssh ahead of the stubs.
    const child = spawn("bash", [DEPLOY, src], {
      env: {
        PATH: `${stubDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: dir,
        VM_SSH_CONFIG: cfg,
        VM_SSH_HOST: "myco-win11-stub",
        MYCO_AGENT_PORT: "65531",
        MYCO_DEPLOY_COPY_BACKOFF: "0",
        MYCO_GUEST_WHEELS: wheels,
        MYCO_EGRESS_SCRIPT: egressStub,
        ...extra,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (b: Buffer) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b: Buffer) => {
      stderr += b.toString();
    });
    child.on("close", (status) => {
      const countFile = join(dir, "scp.count");
      const scpCalls = existsSync(countFile) ? Number(readFileSync(countFile, "utf8").trim()) : 0;
      resolve({ status, stdout, stderr, scpCalls });
    });
  });
}

/** Lines a stub appended (register.log / token.log), or [] if it never ran. */
function stubLog(name: string): string[] {
  const f = join(dir, name);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean) : [];
}

function guestFile(rel: string): string {
  return readFileSync(join(guest, AGENT_DIR_REL, rel), "utf8");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "myco-deploy-retry-"));
  stubDir = join(dir, "stub");
  src = join(dir, "agent");
  guest = join(dir, "guest");
  cfg = join(dir, "ssh_config");
  mkdirSync(stubDir);
  mkdirSync(guest);
  writeFileSync(cfg, "# test-only; no real host\n");
  mkdirSync(join(src, "myco_agent", "sub dir"), { recursive: true });
  mkdirSync(join(src, "bootstrap"));
  writeFileSync(join(src, "myco_agent", "__init__.py"), "# agent package\n");
  writeFileSync(join(src, "myco_agent", "core.py"), "def main():\n    return 42\n");
  writeFileSync(join(src, "myco_agent", "sub dir", "a b.py"), "X = 'space in path'\n");
  writeFileSync(join(src, "bootstrap", "MycoAgent.xml"), "<Task/>\n");
  writeFileSync(join(src, "bootstrap", "guest-deploy.ps1"), "# stub guest script\n");
  writeFileSync(join(src, "pyproject.toml"), "[project]\nname = 'myco-agent'\n");
  writeFileSync(join(src, "bootstrap", "guest-requirements.txt"), "pkg==1 --hash=sha256:00\n");
  // Pre-staged wheels (TIF-275), so no test ever reaches PyPI.
  wheels = join(dir, "wheels-in");
  mkdirSync(wheels);
  writeFileSync(join(wheels, "pkg-1-py3-none-any.whl"), "not a real wheel\n");
  // TIF-275: the deploy verifies guest egress first; a passing stub by default.
  egressStub = join(dir, "egress-ok.sh");
  writeFileSync(egressStub, `#!/bin/bash\necho "$1" >> "${join(dir, "egress.calls")}"\nexit 0\n`, {
    mode: 0o755,
  });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const SLOW = 30_000;

describe("deploy-to-vm copy phase (TIF-220)", () => {
  it("refuses a non-numeric attempts bound instead of looping forever", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 999 });
    const r = await runDeploy({ MYCO_DEPLOY_COPY_ATTEMPTS: "three" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MYCO_DEPLOY_COPY_ATTEMPTS must be a positive integer");
    expect(r.scpCalls).toBe(0);
  });

  it("deploys cleanly with no drops, verifying the tree", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy();
    expect(r.stderr).not.toContain("refusing");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("verified 7 files on the guest");
    expect(r.stdout).toContain("DEPLOY OK");
    expect(r.stderr).not.toContain("copy attempt");
    // ps1, tree, token: one pass, no retries.
    expect(r.scpCalls).toBe(3);
    expect(stubLog("register.log")).toEqual(["core_ok=yes"]);
    expect(stubLog("token.log")).toEqual(["core_ok=yes"]);
  });

  it("survives the trial-14 drop on the first scp after ready", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 1 });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("copy attempt 1/3 failed");
    expect(r.stderr).toContain("copy succeeded on attempt 2/3");
    expect(r.stdout).toContain("DEPLOY OK");
  });

  it("redoes the copy when a dropped tree copy left a partial tree", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0, treeDrops: 1 });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("scp: Connection closed");
    expect(r.stderr).toContain("copy succeeded on attempt 2/3");
    expect(guestFile("myco_agent/__init__.py")).toBe("# agent package\n");
    expect(r.stdout).toContain("DEPLOY OK");
  });

  it("catches a copy that exited 0 but left a truncated file", { timeout: SLOW }, async () => {
    // Only the manifest check can see this: scp reported success.
    installStubs({ scpDrops: 0, silentTruncate: true });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("copied tree does not match the source");
    expect(r.stderr).toContain("myco_agent/core.py");
    expect(r.stderr).toContain("copy succeeded on attempt 2/3");
    expect(guestFile("myco_agent/core.py")).toBe("def main():\n    return 42\n");
    // The truncated first copy must never reach register or the token write:
    // both happen once, and only after the verified second copy.
    expect(stubLog("register.log")).toEqual(["core_ok=yes"]);
    expect(stubLog("token.log")).toEqual(["core_ok=yes"]);
  });

  it("fails loudly after 3 attempts when the drops persist", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 999 });
    const r = await runDeploy();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("copy to guest failed on all 3 attempts");
    expect(r.stderr).toContain("guest or UTM unhealthy");
    expect(r.stdout).not.toContain("DEPLOY OK");
    expect(r.stdout).not.toContain("registering MycoAgent");
    // Bounded: one dropped scp per attempt, three attempts, nothing more.
    expect(r.scpCalls).toBe(3);
  });

  it("refuses to register when every tree copy lands partial", { timeout: SLOW }, async () => {
    // Every tree copy drops after landing a truncated first file; the ps1
    // copies succeed, so each attempt reaches the partial-tree path.
    installStubs({ scpDrops: 0, treeDrops: 999 });
    const r = await runDeploy();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("copy to guest failed on all 3 attempts");
    expect(r.stdout).not.toContain("registering MycoAgent");
    // The partial tree is on the guest, and it was not trusted.
    expect(guestFile("myco_agent/__init__.py").length).toBe(3);
    expect(stubLog("register.log")).toEqual([]);
    expect(stubLog("token.log")).toEqual([]);
  });
});

/**
 * Row-8 H5: the deploy leaves the fresh token in a host file, so §5 and §6 never
 * fetch it back from the guest. Values are compared, never printed: every
 * assertion on a token is a boolean, so a failure message cannot carry one.
 */
describe("deploy-to-vm host token file (row-8 H5)", () => {
  /** The token the scp stub delivered to the fake guest (its only ProgramData file). */
  function guestToken(): Buffer {
    const root = join(guest, "C", "ProgramData");
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
    expect(files.length).toBe(1);
    return readFileSync(files[0] as string);
  }

  function mode(path: string): number {
    return statSync(path).mode & 0o777;
  }

  function leaksToken(r: DeployRun, token: string): boolean {
    return token.length === 0 || r.stdout.includes(token) || r.stderr.includes(token);
  }

  it("writes the verified token to MYCO_TOKEN_OUT, mode 600, never printing it", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const outDir = join(dir, "private");
    mkdirSync(outDir);
    const out = join(outDir, "agent-token");
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEPLOY OK");
    expect(r.stdout).toContain(`wrote the fresh token to ${out} (mode 600)`);
    expect(existsSync(out)).toBe(true);
    expect(mode(out).toString(8)).toBe("600");
    const host = readFileSync(out);
    const sent = guestToken();
    expect(host.length).toBeGreaterThan(0);
    expect(host.equals(sent)).toBe(true);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
    // The same-directory temp file was renamed, not left behind.
    expect(readdirSync(outDir)).toEqual(["agent-token"]);
    // Only the explicit path was written: the default under HOME was not.
    expect(existsSync(join(dir, ".myco-token"))).toBe(false);
  });

  it("replaces an existing token file and defaults to ~/.myco-token", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const def = join(dir, ".myco-token");
    writeFileSync(def, "stale-previous-deploy\n", { mode: 0o644 });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(mode(def).toString(8)).toBe("600");
    const sent = guestToken();
    expect(readFileSync(def).equals(sent)).toBe(true);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });

  it("leaves an existing token file byte-identical when the copy keeps dropping", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 999 });
    const out = join(dir, "kept-token");
    writeFileSync(out, "previous-working-value\r\n");
    chmodSync(out, 0o600);
    const before = readFileSync(out);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("copy to guest failed on all 3 attempts");
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(mode(out).toString(8)).toBe("600");
    expect(readdirSync(dir).filter((n) => n.startsWith(".myco-token."))).toEqual([]);
  });

  it("leaves it untouched when the guest got the new token but the deploy then failed", {
    timeout: SLOW,
  }, async () => {
    // The worst case: the guest token already rotated, the deploy is unverified.
    installStubs({ scpDrops: 0, registerFails: true });
    const out = join(dir, "kept-token");
    writeFileSync(out, "previous-working-value\n");
    chmodSync(out, 0o600);
    const before = readFileSync(out);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("DEPLOY OK");
    const sent = guestToken();
    expect(sent.length).toBeGreaterThan(0);
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });

  it("refuses a MYCO_TOKEN_OUT in a missing directory before copying anything", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy({ MYCO_TOKEN_OUT: join(dir, "no-such-dir", "tok") });
    expect(r.status).toBe(1);
    const missing = join(dir, "no-such-dir");
    // The full line: the missing-directory check, not the writability check that
    // would also fail on a missing directory, and the remedy (TIF-229).
    expect(r.stderr).toContain(
      `deploy-to-vm: MYCO_TOKEN_OUT directory ${missing} does not exist: create it (mkdir -p -m 700 '${missing}') or point MYCO_TOKEN_OUT into an existing directory you own\n`,
    );
    expect(r.stderr).not.toContain("is not writable");
    expect(r.scpCalls).toBe(0);
  });

  it("refuses a MYCO_TOKEN_OUT whose parent is a file, before copying anything", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const notDir = join(dir, "plain-file");
    writeFileSync(notDir, "x\n");
    const r = await runDeploy({ MYCO_TOKEN_OUT: `${notDir}/tok` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      `deploy-to-vm: MYCO_TOKEN_OUT directory ${notDir} exists but is not a directory: point MYCO_TOKEN_OUT into a directory you own\n`,
    );
    expect(r.scpCalls).toBe(0);
  });

  it("refuses a MYCO_TOKEN_OUT that is a directory, or a symlink to one, before copying", {
    timeout: SLOW,
  }, async () => {
    // mv onto a directory (or a link to one) would move the token INTO it.
    installStubs({ scpDrops: 0 });
    const tokDir = join(dir, "tokdir");
    mkdirSync(tokDir);
    const linkToDir = join(dir, "tokdir-link");
    symlinkSync(tokDir, linkToDir);
    for (const out of [tokDir, linkToDir]) {
      const r = await runDeploy({ MYCO_TOKEN_OUT: out });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `deploy-to-vm: MYCO_TOKEN_OUT ${out} is a directory, not a file path: set MYCO_TOKEN_OUT to a file inside it, e.g. ${out}/agent-token\n`,
      );
      expect(r.scpCalls).toBe(0);
      expect(readdirSync(tokDir)).toEqual([]);
    }
  });

  it("leaves it untouched when the agent never answers the ping", {
    timeout: SLOW,
  }, async () => {
    // Copy and register succeed, so the guest token has rotated; only the
    // ping check fails. The file must be written after that check, not before.
    installStubs({ scpDrops: 0, pingFails: true });
    // The ping loop sleeps 2 s between 30 tries; a no-op sleep keeps this fast.
    writeFileSync(join(stubDir, "sleep"), `#!/bin/bash\necho ran >> "${dir}/sleep.marker"\n`, {
      mode: 0o755,
    });
    const outDir = join(dir, "private");
    mkdirSync(outDir);
    const out = join(outDir, "agent-token");
    writeFileSync(out, "previous-working-value\n");
    chmodSync(out, 0o600);
    const before = readFileSync(out);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("agent did not answer ping");
    expect(r.stdout).not.toContain("DEPLOY OK");
    expect(stubLog("register.log")).toEqual(["core_ok=yes"]);
    expect(stubLog("nc.marker").length).toBe(30);
    expect(existsSync(join(dir, "sleep.marker"))).toBe(true);
    const sent = guestToken();
    expect(sent.length).toBeGreaterThan(0);
    expect(readFileSync(out).equals(before)).toBe(true);
    expect(mode(out).toString(8)).toBe("600");
    expect(readdirSync(outDir)).toEqual(["agent-token"]);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });

  it("refuses an unwritable MYCO_TOKEN_OUT directory before copying anything", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const outDir = join(dir, "readonly");
    mkdirSync(outDir);
    chmodSync(outDir, 0o500);
    try {
      const r = await runDeploy({ MYCO_TOKEN_OUT: join(outDir, "agent-token") });
      // Zero copies first: a late failure (at mktemp, after the guest token
      // rotated) also exits 1, so the exit code alone cannot tell them apart.
      expect(r.scpCalls).toBe(0);
      expect(r.status).toBe(1);
      const out = join(outDir, "agent-token");
      expect(r.stderr).toContain(
        `deploy-to-vm: MYCO_TOKEN_OUT directory ${outDir} is not writable: the token is written to a temp file there and renamed over ${out}, so you need write and search permission on the directory. Fix: chmod u+wx '${outDir}' if you own it, or point MYCO_TOKEN_OUT into a directory you own\n`,
      );
      expect(existsSync(join(dir, "scp.marker"))).toBe(false);
      expect(readdirSync(outDir)).toEqual([]);
    } finally {
      chmodSync(outDir, 0o700);
    }
  });

  /**
   * Make the script see every existing file as another user's. A test cannot
   * chown a file away without root, so a stub `id` (first on PATH) reports a uid
   * that owns nothing here; the script's ownership check compares against it.
   */
  function pretendOtherUser(): void {
    writeFileSync(join(stubDir, "id"), `#!/bin/bash\necho 4242999\n`, { mode: 0o755 });
  }

  for (const kind of ["file", "symlink"] as const) {
    it(`refuses an existing MYCO_TOKEN_OUT ${kind} owned by another user, before copying`, {
      timeout: SLOW,
    }, async () => {
      installStubs({ scpDrops: 0 });
      pretendOtherUser();
      const target = join(dir, "someone-elses-token");
      writeFileSync(target, "another-operators-value\n");
      chmodSync(target, 0o600);
      const out = kind === "file" ? target : join(dir, "someone-elses-link");
      if (kind === "symlink") symlinkSync(target, out);
      const before = readFileSync(target);
      const r = await runDeploy({ MYCO_TOKEN_OUT: out });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(
        `deploy-to-vm: MYCO_TOKEN_OUT ${out} exists and is owned by another user (another operator's token, G25); the deploy replaces this file and will not replace someone else's. Fix: set MYCO_TOKEN_OUT to a private path (docs/eval-runbook.md section 4), or have its owner remove it\n`,
      );
      expect(r.scpCalls).toBe(0);
      expect(readFileSync(target).equals(before)).toBe(true);
      expect(lstatSync(out).isSymbolicLink()).toBe(kind === "symlink");
    });
  }

  it("replaces your own mode-400 token file: the rename never writes into it (TIF-229)", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const outDir = join(dir, "private");
    mkdirSync(outDir);
    const out = join(outDir, "agent-token");
    writeFileSync(out, "previous-deploy-value\n");
    chmodSync(out, 0o400);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.stderr).not.toContain("MYCO_TOKEN_OUT");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEPLOY OK");
    expect(mode(out).toString(8)).toBe("600");
    const sent = guestToken();
    expect(readFileSync(out).equals(sent)).toBe(true);
    expect(readdirSync(outDir)).toEqual(["agent-token"]);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });

  it("replaces your own symlink to an unwritable target, leaving the target alone (TIF-229)", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const target = join(dir, "readonly-target");
    writeFileSync(target, "not-a-token-file\n");
    chmodSync(target, 0o400);
    const before = readFileSync(target);
    const outDir = join(dir, "private");
    mkdirSync(outDir);
    const out = join(outDir, "agent-token");
    symlinkSync(target, out);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.stderr).not.toContain("MYCO_TOKEN_OUT");
    expect(r.status).toBe(0);
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(mode(target).toString(8)).toBe("400");
    const st = lstatSync(out);
    expect(st.isSymbolicLink()).toBe(false);
    expect((st.mode & 0o777).toString(8)).toBe("600");
    const sent = guestToken();
    expect(readFileSync(out).equals(sent)).toBe(true);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });

  it("replaces a symlink at MYCO_TOKEN_OUT with a regular file, leaving its target alone", {
    timeout: SLOW,
  }, async () => {
    // Pins the temp-file-plus-mv write: writing straight to the path would
    // follow the link and overwrite whatever it points at.
    installStubs({ scpDrops: 0 });
    const target = join(dir, "link-target");
    writeFileSync(target, "not-a-token-file\n", { mode: 0o644 });
    const before = readFileSync(target);
    const outDir = join(dir, "private");
    mkdirSync(outDir);
    const out = join(outDir, "agent-token");
    symlinkSync(target, out);
    const r = await runDeploy({ MYCO_TOKEN_OUT: out });
    expect(r.status).toBe(0);
    expect(readFileSync(target).equals(before)).toBe(true);
    expect(mode(target).toString(8)).toBe("644");
    const st = lstatSync(out);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.isFile()).toBe(true);
    expect((st.mode & 0o777).toString(8)).toBe("600");
    const sent = guestToken();
    expect(readFileSync(out).equals(sent)).toBe(true);
    expect(readdirSync(outDir)).toEqual(["agent-token"]);
    expect(leaksToken(r, sent.toString("utf8"))).toBe(false);
  });
});

// TIF-275: the guest has no internet, so its Python wheels come from the host
// with the tree copy and are installed offline, hash-pinned.
describe("guest wheels fetched on the host (TIF-275)", () => {
  /** A fake `python3` that logs its argv; `--no-index` (cache) hits only if asked. */
  function stubPython(cacheHit: boolean): string {
    const log = join(dir, "python3.log");
    writeFileSync(
      join(stubDir, "python3"),
      `#!/bin/bash
echo "$*" >> "${log}"
d=""; prev=""
for a in "$@"; do [ "$prev" = "-d" ] && d="$a"; prev="$a"; done
case " $* " in *" --no-index "*) [ "${cacheHit ? 1 : 0}" = 1 ] || exit 1 ;; esac
echo fetched > "$d/pkg-1-py3-none-any.whl"
exit 0
`,
      { mode: 0o755 },
    );
    return log;
  }

  it("copies the staged wheels into the agent directory with the tree", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("staged 1 wheels for the guest");
    // Same three scp calls as before: the wheels ride the tree copy.
    expect(r.scpCalls).toBe(3);
    expect(guestFile("wheels/pkg-1-py3-none-any.whl")).toBe("not a real wheel\n");
  });

  it("refuses before touching the guest when the staged wheel dir is empty", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const empty = join(dir, "no-wheels");
    mkdirSync(empty);
    const r = await runDeploy({ MYCO_GUEST_WHEELS: empty });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no .whl files");
    expect(r.scpCalls).toBe(0);
  });

  it("refuses before touching the guest without the pinned requirements file", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    rmSync(join(src, "bootstrap", "guest-requirements.txt"));
    const r = await runDeploy();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("guest-requirements.txt");
    expect(r.scpCalls).toBe(0);
  });

  it("tries the host cache offline first, then PyPI, always hash-pinned for win_arm64", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const log = stubPython(false);
    const cache = join(dir, "cache");
    const r = await runDeploy({ MYCO_GUEST_WHEELS: "", MYCO_WHEEL_CACHE: cache });
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--no-index");
    expect(calls[1]).not.toContain("--no-index");
    for (const c of calls) {
      expect(c).toContain("--require-hashes");
      expect(c).toContain("--platform win_arm64");
      expect(c).toContain("--only-binary=:all:");
    }
    // A fresh fetch is kept for the next deploy.
    expect(readdirSync(cache)).toContain("pkg-1-py3-none-any.whl");
  });

  it("needs no network on a cache hit", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 0 });
    const log = stubPython(true);
    const r = await runDeploy({ MYCO_GUEST_WHEELS: "", MYCO_WHEEL_CACHE: join(dir, "cache") });
    expect(r.status).toBe(0);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--no-index");
  });
});

// TIF-275 round 2 (verifier N3): no agent or token enters a guest whose egress
// is not verified closed.
describe("deploy refuses a guest with egress not verified closed (TIF-275)", () => {
  it("verifies egress before touching the guest", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy();
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "egress.calls"), "utf8").trim()).toBe("verify");
  });

  it("refuses, before any copy, when the egress check fails", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 0 });
    const failing = join(dir, "egress-open.sh");
    writeFileSync(failing, "#!/bin/bash\nexit 1\n", { mode: 0o755 });
    const r = await runDeploy({ MYCO_EGRESS_SCRIPT: failing });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("guest egress is not verified closed");
    expect(r.scpCalls).toBe(0);
  });

  it("refuses when the egress check is missing", { timeout: SLOW }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy({ MYCO_EGRESS_SCRIPT: join(dir, "nope.sh") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("egress check not found");
    expect(r.scpCalls).toBe(0);
  });

  it("refuses outright under MYCO_GUEST_EGRESS=open (maintenance mode)", {
    timeout: SLOW,
  }, async () => {
    installStubs({ scpDrops: 0 });
    const r = await runDeploy({ MYCO_GUEST_EGRESS: "open" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MYCO_GUEST_EGRESS=open");
    expect(r.scpCalls).toBe(0);
  });
});
