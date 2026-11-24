import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readSecretFromFile, resolveAnthropicKey } from "../../src/baseline/secret-file.ts";

// Synthetic values only. Nothing here touches a real secrets file. FAKE is a plain
// fixture string, deliberately not key-shaped, so the tracked-file credential scan
// (FORBIDDEN_IN_COMMITTED_FILES) and gitleaks never match it. Nothing below depends on
// the value having a real key's shape.
const FAKE = "fixture-anthropic-key-not-a-real-secret";
const dirs: string[] = [];
function secretsFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "myco-secret-file-"));
  dirs.push(dir);
  const path = join(dir, "anthropic.env");
  writeFileSync(path, body);
  return path;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("readSecretFromFile (TIF-206)", () => {
  it("reads plain, exported and quoted NAME=value lines", () => {
    expect(
      readSecretFromFile(secretsFile(`ANTHROPIC_API_KEY=${FAKE}\n`), "ANTHROPIC_API_KEY"),
    ).toBe(FAKE);
    expect(
      readSecretFromFile(
        secretsFile(`# c\nexport ANTHROPIC_API_KEY="${FAKE}"\n`),
        "ANTHROPIC_API_KEY",
      ),
    ).toBe(FAKE);
    expect(
      readSecretFromFile(
        secretsFile(`OTHER=1\r\nANTHROPIC_API_KEY='${FAKE}'\r\n`),
        "ANTHROPIC_API_KEY",
      ),
    ).toBe(FAKE);
  });

  it("errors name the file and variable but never echo the contents", () => {
    const path = secretsFile(`SOMETHING_ELSE=${FAKE}\n`);
    expect(() => readSecretFromFile(path, "ANTHROPIC_API_KEY")).toThrow(
      /ANTHROPIC_API_KEY not found/,
    );
    try {
      readSecretFromFile(path, "ANTHROPIC_API_KEY");
    } catch (e) {
      expect(String(e)).not.toContain(FAKE);
    }
    expect(() =>
      readSecretFromFile(join(tmpdir(), "no-such-myco-file.env"), "ANTHROPIC_API_KEY"),
    ).toThrow(/cannot read secrets file/);
  });
});

describe("resolveAnthropicKey (TIF-206)", () => {
  it("prefers an explicit env key, then the key file, and has no default path", () => {
    const path = secretsFile(`ANTHROPIC_API_KEY=${FAKE}\n`);
    expect(
      resolveAnthropicKey({ ANTHROPIC_API_KEY: "explicit", MYCO_ANTHROPIC_KEY_FILE: path }),
    ).toBe("explicit");
    expect(resolveAnthropicKey({ MYCO_ANTHROPIC_KEY_FILE: path })).toBe(FAKE);
    expect(resolveAnthropicKey({})).toBeUndefined();
  });
});

describe("launchers pass the key file path, not the key (TIF-206)", () => {
  // The key must never be exported into the launcher environment: `ps eww` on the sweep
  // printed it (TIF-193). Run only the key-loading prologue of each launcher, with a
  // fake HOME, and check what the child environment would contain.
  for (const script of ["scripts/c1-baseline.sh", "scripts/c1-spike.sh"]) {
    it(`${script} exports MYCO_ANTHROPIC_KEY_FILE and not ANTHROPIC_API_KEY`, () => {
      const home = mkdtempSync(join(tmpdir(), "myco-secret-home-"));
      dirs.push(home);
      const secrets = join(home, ".myco", "secrets");
      mkdirSync(secrets, { recursive: true });
      writeFileSync(join(secrets, "anthropic.env"), `ANTHROPIC_API_KEY=${FAKE}\n`);
      const src = readFileSync(script, "utf8");
      const start = src.indexOf('SECRETS="$HOME/.myco/secrets/anthropic.env"');
      const end = src.indexOf('export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"');
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      const prologue = `${src.slice(start, end)}export MYCO_ANTHROPIC_KEY_FILE="$SECRETS"\nenv | cut -d= -f1\n`;
      const env = { PATH: process.env.PATH, HOME: home };
      const run = spawnSync("bash", ["-c", prologue], { encoding: "utf8", env });
      expect(run.status).toBe(0);
      const names = run.stdout.split("\n");
      expect(names).toContain("MYCO_ANTHROPIC_KEY_FILE");
      expect(names).not.toContain("ANTHROPIC_API_KEY");
      expect(`${run.stdout}${run.stderr}`).not.toContain(FAKE);

      const missing = spawnSync("bash", ["-c", prologue], {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: join(home, "nowhere") },
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/ANTHROPIC_API_KEY required/);
    });
  }
});
