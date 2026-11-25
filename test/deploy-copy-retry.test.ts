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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  *"-Stage register"*) echo registered ;;
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

function runDeploy(): Promise<DeployRun> {
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
  });
});
