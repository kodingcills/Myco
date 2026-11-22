import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";

// Runs scripts/reset-trial-vm.sh against a STUB vm.sh/wait-ssh.sh/vssh, with the
// VM lock and the process-detection tools stubbed too. It never contacts the real
// VM: the script refuses to fall back to the real VM when MYCO_VM_SCRIPTS is set
// but not executable, and every guest interaction goes through $VM_SCRIPTS.
const SCRIPT = join(__dirname, "..", "scripts", "reset-trial-vm.sh");

function run(snapshot?: string) {
  const dir = mkdtempSync(join(tmpdir(), "myco-reset-allowlist-"));
  const stubs = join(dir, "stubs");
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  mkdirSync(stubs);
  mkdirSync(bin);
  const stub = (name: string, body: string) =>
    writeFileSync(join(stubs, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  // vm.sh logs every call; `status` reports a stopped VM so the script proceeds.
  stub("vm.sh", `echo "vm.sh $*" >> "${log}"\n[ "$1" = status ] && echo stopped\nexit 0`);
  stub("wait-ssh.sh", `echo "wait-ssh.sh $*" >> "${log}"\nexit 0`);
  stub("vssh", `echo "vssh" >> "${log}"\nexit 0`);
  // Keep the lock guard independent of whatever is running on the host.
  writeFileSync(join(bin, "pgrep"), "#!/bin/bash\nexit 1\n", { mode: 0o755 });
  writeFileSync(join(bin, "ps"), "#!/bin/bash\nexit 0\n", { mode: 0o755 });
  const args = snapshot === undefined ? [SCRIPT] : [SCRIPT, snapshot];
  const result = spawnSync("bash", args, {
    encoding: "utf8",
    timeout: 20000,
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      MYCO_VM_SCRIPTS: stubs,
      MYCO_VM_LOCK_PATH: join(dir, "test.lock"),
      MYCO_VM_LOCK_OWNER: "",
      MYCO_STOP_TIMEOUT: "2",
      MYCO_SSH_WAIT_TIMEOUT: "2",
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8") : "";
  return { ...result, calls };
}

describe("reset-trial-vm.sh snapshot allowlist", () => {
  // Guards against dropping a protected name from the allowlist.
  it.each(["clean-base", "clean-base-live", "m1-agent-live", "cua-c1-base"])(
    "restores the allowed snapshot %s",
    (name) => {
      const r = run(name);
      expect(r.stderr).not.toContain("refusing to restore");
      expect(r.status).toBe(0);
      expect(r.calls).toContain(`vm.sh restore ${name}`);
      expect(r.stdout).toContain(`ready on '${name}'`);
    },
  );

  // Guards against the default silently changing away from clean-base.
  it("defaults to clean-base when no snapshot is given", () => {
    const r = run();
    expect(r.status).toBe(0);
    expect(r.calls).toContain("vm.sh restore clean-base");
  });

  // Guards the refuse-anything-else behaviour: a refused name must exit non-zero,
  // say why, and never call into the VM at all (no kill, no restore).
  it.each([
    "cua-c1-base2",
    "cua-c1",
    "Cua-C1-Base",
    "cua-c1-base ",
    "xcua-c1-base",
    "clean-base-evil",
    "clean-base2",
    "m1-agent",
    "../clean-base",
    "cua-c1-base;true",
    "*",
  ])("refuses the unexpected snapshot %j without touching the VM", (name) => {
    const r = run(name);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("refusing to restore unexpected snapshot");
    expect(r.calls).toBe("");
  });
});
