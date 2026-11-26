/**
 * The shared leak guard, as a CI gate (TIF-98, part 1). In the core smoke set
 * (`SMOKE` in scripts/ci-plan.py), so it runs on every PR whatever the plan mode.
 *
 *  1. Every tracked file is clean outside `src/leak-guard/allowlist.json`.
 *  2. Every outward-bound writer, run on fixtures, produces files and a log that are clean.
 *  3. Revert check: a username, a home path and a key-shaped string seeded into a produced
 *     output, and into a committed fixture, are each caught, fail closed, and no value is
 *     printed (also through the `pnpm leak-guard` CLI).
 *  4. Fail closed: a writer that cannot run, an unreadable output, a malformed, unjustified
 *     or stale allowlist entry are findings, never a pass.
 *
 * All seeded values are generated fakes (`zq...` names, a runtime-assembled key shape).
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hostIdentity, type Identity, mergeIdentity } from "../../src/leak-guard/detect.ts";
import {
  ALLOWLIST_PATH,
  type Finding,
  formatFindings,
  scanDir,
  scanTracked,
} from "../../src/leak-guard/scan.ts";
import { PRODUCERS, type Produced, runProducers } from "./produce.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const ALLOWLIST = readFileSync(join(ROOT, ALLOWLIST_PATH), "utf8");

/** Seeds: generated fakes, assembled at runtime (no literal leak or key in this file). */
const SEED_USER = ["zq", "leak", "user"].join("");
const SEED_HOST = ["zq", "leak", "host", "-01"].join("");
const SEED_HOME = ["C:", "Users", "Zq Person", "AppData", "x.json"].join("\\");
const SEED_KEY = ["sk", "ant", "api03", "Zq".repeat(14)].join("-");
const SEEDS = { username: SEED_USER, "home-path": SEED_HOME, "key-shaped": SEED_KEY } as const;
const PLANTED: Identity = mergeIdentity(hostIdentity(ROOT), {
  users: [SEED_USER],
  hosts: [SEED_HOST],
});

const made: string[] = [];
const scratch = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), `myco-leak-guard-${p}-`));
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) {
    try {
      chmodSync(d, 0o700);
    } catch {}
    rmSync(d, { recursive: true, force: true });
  }
});

/** No seeded value (in any spelling a JSON encoder would give it) appears in a report. */
function expectNoValue(report: string) {
  for (const v of [...Object.values(SEEDS), SEED_HOST, "Zq Person"]) {
    expect(report.includes(v)).toBe(false);
    expect(report.includes(JSON.stringify(v).slice(1, -1))).toBe(false);
  }
}

function firstFile(dir: string): string {
  const walk = (d: string): string | null => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        const f = walk(p);
        if (f !== null) return f;
      } else if (e.name.endsWith(".json") || e.name.endsWith(".jsonl")) return p;
    }
    return null;
  };
  const f = walk(dir);
  if (f === null) throw new Error("writer produced no JSON file");
  return f;
}

describe("leak guard: the repo and every writer are clean (CI gate, fail closed)", () => {
  it("no tracked file leaks a username, home path, hostname or key outside the allowlist", () => {
    const { findings, files } = scanTracked(ROOT, hostIdentity(ROOT), ALLOWLIST);
    expect(files).toBeGreaterThan(100);
    // file:line class only; run `pnpm leak-guard` locally for the same report.
    expect(formatFindings(findings)).toBe("");
  });

  it("every outward writer, run on fixtures, writes files and a log with no leak", async () => {
    const counts = new Map<string, number>();
    const result = await runProducers(hostIdentity(ROOT), PRODUCERS, (name, p) => {
      let n = 0;
      const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true }))
          e.isDirectory() ? walk(join(d, e.name)) : n++;
      };
      walk(p.outDir);
      counts.set(name, n);
      return p;
    });
    expect(formatFindings(result.findings)).toBe("");
    expect(result.producers).toEqual(["episode-export", "dataset-export"]);
    for (const name of result.producers) expect(counts.get(name) ?? 0).toBeGreaterThan(0);
  });
});

describe("leak guard: revert check (seed a leak; the guard must catch it and print no value)", () => {
  for (const [klass, value] of Object.entries(SEEDS)) {
    it(`a ${klass} seeded into each writer's produced output is caught`, async () => {
      const mutate = (_name: string, p: Produced): Produced => {
        appendFileSync(firstFile(p.outDir), `\n{"note":${JSON.stringify(`seeded ${value}`)}}\n`);
        return p;
      };
      const { findings } = await runProducers(PLANTED, PRODUCERS, mutate);
      for (const name of PRODUCERS.map((p) => p.name)) {
        const mine = findings.filter((f) => f.file.startsWith(`writer:${name}/`));
        expect(mine.map((f) => f.class)).toContain(klass);
      }
      expectNoValue(formatFindings(findings));
    });

    it(`a ${klass} seeded into a writer's log is caught`, async () => {
      const mutate = (_n: string, p: Produced): Produced => ({ ...p, log: `${p.log}\n${value}` });
      const { findings } = await runProducers(PLANTED, PRODUCERS, mutate);
      const logs = findings.filter((f) => f.file.endsWith("/<log>"));
      expect(logs.filter((f) => f.class === klass)).toHaveLength(PRODUCERS.length);
      expectNoValue(formatFindings(findings));
    });

    it(`a ${klass} seeded into a committed fixture is caught (file and line, no value)`, () => {
      const repo = scratch("repo");
      execFileSync("git", ["init", "-q"], { cwd: repo });
      mkdirSync(join(repo, "test", "fixtures"), { recursive: true });
      writeFileSync(join(repo, "test", "fixtures", "clean.json"), '{"ok":true}\n');
      writeFileSync(
        join(repo, "test", "fixtures", "seeded.json"),
        `{\n  "ok": true,\n  "path": ${JSON.stringify(value)}\n}\n`,
      );
      execFileSync("git", ["add", "."], { cwd: repo });
      const { findings } = scanTracked(repo, PLANTED, ALLOWLIST, [
        "test/fixtures/clean.json",
        "test/fixtures/seeded.json",
      ]);
      expect(findings).toContainEqual({ file: "test/fixtures/seeded.json", line: 3, class: klass });
      expect(findings.every((f) => f.file === "test/fixtures/seeded.json")).toBe(true);
      expectNoValue(formatFindings(findings));
    });
  }

  it("a hostname seeded into a produced output is caught", async () => {
    const mutate = (_n: string, p: Produced): Produced => {
      appendFileSync(firstFile(p.outDir), `\n{"host":"${SEED_HOST}.local"}\n`);
      return p;
    };
    const { findings } = await runProducers(PLANTED, PRODUCERS, mutate);
    expect(findings.filter((f) => f.class === "hostname")).toHaveLength(PRODUCERS.length);
    expectNoValue(formatFindings(findings));
  });

  it("`pnpm leak-guard` exits 1 on a seeded output dir and prints location and class only", () => {
    const dir = scratch("cli");
    mkdirSync(join(dir, "episodes"));
    writeFileSync(
      join(dir, "episodes", "e.json"),
      [
        '{"a":1,',
        `"u":"${SEED_USER}",`,
        `"p":${JSON.stringify(SEED_HOME)},`,
        `"k":"${SEED_KEY}"}`,
      ].join("\n"),
    );
    // A file NAME that leaks is withheld too.
    writeFileSync(join(dir, `${SEED_USER}.log`), "ok\n");
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(ROOT, "scripts", "leak-guard.ts"),
        "--scan-only",
        "--scan",
        dir,
        "--plant-user",
        SEED_USER,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    const out = run.stdout + run.stderr;
    expect(out).toContain("--scan#0/episodes/e.json:2 username");
    expect(out).toContain("--scan#0/episodes/e.json:3 home-path");
    expect(out).toContain("--scan#0/episodes/e.json:4 key-shaped");
    expect(out).toMatch(/--scan#0\/<name withheld #\d+>:0 username/);
    expect(out).toContain("leak-guard: FAIL");
    expectNoValue(out);
  });
});

describe("leak guard: fails closed", () => {
  it("a writer that throws is a finding, not a skip", async () => {
    const broken = {
      name: "broken",
      run: (): Produced => {
        throw new Error(`cannot write ${SEED_HOME}`);
      },
    };
    const { findings } = await runProducers(PLANTED, [broken]);
    expect(findings).toEqual([{ file: "writer:broken", line: 0, class: "unscannable" }]);
    expectNoValue(formatFindings(findings));
  });

  it.skipIf(process.getuid?.() === 0)(
    "an output directory that cannot be read is a finding",
    () => {
      const dir = scratch("locked");
      mkdirSync(join(dir, "sub"));
      chmodSync(join(dir, "sub"), 0o000);
      const findings: Finding[] = scanDir(dir, "out", PLANTED);
      chmodSync(join(dir, "sub"), 0o700);
      expect(findings.map((f) => f.class)).toContain("unscannable");
    },
  );

  it("a malformed allowlist, an unjustified entry and a stale entry are findings", () => {
    const repo = scratch("allow");
    execFileSync("git", ["init", "-q"], { cwd: repo });
    writeFileSync(join(repo, "a.txt"), "clean\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    const run = (allowlist: string) =>
      scanTracked(repo, PLANTED, allowlist).findings.map((f) => f.class);
    expect(run("{not json")).toEqual(["allowlist"]);
    expect(run(JSON.stringify({ accounts: [{ account: "zqx", reason: "" }], files: [] }))).toEqual([
      "allowlist",
    ]);
    expect(
      run(
        JSON.stringify({
          accounts: [],
          files: [{ file: "a.txt", classes: ["nope"], reason: "long enough reason" }],
        }),
      ),
    ).toEqual(["allowlist"]);
    // Well-formed but suppressing nothing: stale.
    expect(
      run(
        JSON.stringify({
          accounts: [{ account: "zqx", reason: "a placeholder in docs" }],
          files: [],
        }),
      ),
    ).toEqual(["allowlist"]);
    expect(
      run(
        JSON.stringify({
          accounts: [],
          files: [{ file: "a.txt", classes: ["home-path"], reason: "quotes a benchmark path" }],
        }),
      ),
    ).toEqual(["allowlist"]);
    // A host-dependent (username/hostname) file entry cannot be proven stale off its machine.
    expect(
      run(
        JSON.stringify({
          accounts: [],
          files: [{ file: "a.txt", classes: ["username"], reason: "first-name doc anchor slug" }],
        }),
      ),
    ).toEqual([]);
  });

  it("the committed allowlist justifies every entry", () => {
    const parsed = JSON.parse(ALLOWLIST) as {
      accounts: { reason: string }[];
      files: { reason: string }[];
    };
    for (const e of [...parsed.accounts, ...parsed.files])
      expect(e.reason.trim().length).toBeGreaterThanOrEqual(10);
    expect(statSync(join(ROOT, ALLOWLIST_PATH)).isFile()).toBe(true);
  });
});
