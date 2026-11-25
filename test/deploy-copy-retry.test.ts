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
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  writeStub("nc", `cat >/dev/null; echo '{"ok": true, "id": 1, "result": {}}'`);
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
    expect(r.stdout).toContain("verified 6 files on the guest");
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
    expect(r.stderr).toContain("MYCO_TOKEN_OUT directory");
    expect(r.scpCalls).toBe(0);
  });
});
