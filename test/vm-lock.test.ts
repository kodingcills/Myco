import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import process from "node:process";
import { expect, it } from "vitest";

const GUARD = join(__dirname, "..", "scripts", "vm-lock.sh");

function fixture(legacyCommand = "") {
  const dir = mkdtempSync(join(tmpdir(), "myco-lock-test-"));
  const bin = join(dir, "bin");
  const lock = join(dir, "test.lock");
  mkdirSync(bin);
  // Match the guard's actual regex against a synthetic process list.
  writeFileSync(
    join(bin, "pgrep"),
    '#!/bin/bash\nprintf "%s\\n" "$LEGACY_COMMAND" | grep -Eq "$2" || exit 1\nprintf "%s\\n" "$LEGACY_PID"\n',
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "ps"), '#!/bin/bash\nprintf "%s\\n" "$LEGACY_COMMAND"\n', {
    mode: 0o755,
  });
  function run(script: string) {
    return spawnSync("bash", ["-c", script, "guard-test", GUARD], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        MYCO_VM_LOCK_PATH: lock,
        MYCO_VM_LOCK_OWNER: "",
        LEGACY_COMMAND: legacyCommand,
        LEGACY_PID: String(process.pid),
      },
    });
  }
  return { dir, lock, run };
}

it("refuses the exact pre-lock sweep command before param work and logs its holder", () => {
  const command = "bash scripts/m1-sweep.sh /tmp/m1-013/sweep-v3";
  const { dir, run } = fixture(command);
  const log = join(dir, "progress.log");
  // No driver runs. The guard receives a synthetic match from pgrep.
  const result = run(
    `source "$1"; vm_lock_acquire m1-corrupt-suite.sh "${log}" || exit "$?"; echo PARAMETERS`,
  );
  expect(result.status, result.stderr).toBe(10);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain(`REFUSED_VM_LOCKED: holder ${process.pid} ${command}`);
  expect(readFileSync(log, "utf8")).toContain(command);
});

it("allows a driver with a caffeinate launcher when no other driver is running", () => {
  const { run } = fixture("caffeinate -dimsu scripts/m1-corrupt-suite.sh /tmp/corrupt-output");
  expect(run('source "$1"; vm_lock_acquire m1-corrupt-suite.sh || exit "$?"').status).toBe(0);
});

it("excludes another driver and permits its own reset child to inherit the lock", () => {
  const { run } = fixture();
  const result = run(`
    source "$1"
    vm_lock_acquire m1-sweep.sh || exit "$?"
    trap vm_lock_release EXIT
    bash -c 'source "$1"; vm_lock_acquire m1-corrupt-suite.sh' guard-child "$1"
    [ "$?" -eq 10 ] || exit 1
    bash -c 'source "$1"; vm_lock_owned_by_parent' guard-reset "$1" || exit 2
    echo "child inherited lock"
  `);
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("child inherited lock");
  expect(result.stderr).toMatch(/REFUSED_VM_LOCKED: holder \d+ m1-sweep\.sh/);
  expect(run('source "$1"; vm_lock_acquire m1-corrupt-suite.sh').status).toBe(0);
});

it("reacquires a stale lock after the owning process dies without running its trap", () => {
  const { run, lock } = fixture();
  const holder = run('source "$1"; vm_lock_acquire m1-sweep.sh || exit "$?"; kill -KILL "$$"');
  expect(holder.signal).toBe("SIGKILL");
  expect(readFileSync(lock, "utf8")).toMatch(/ m1-sweep\.sh/);
  const next = run(
    'source "$1"; vm_lock_acquire m1-corrupt-suite.sh || exit "$?"; trap vm_lock_release EXIT',
  );
  expect(next.status, next.stderr).toBe(0);
  expect(readFileSync(lock, "utf8")).toMatch(/ m1-corrupt-suite\.sh/);
});
