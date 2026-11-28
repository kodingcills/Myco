/**
 * #549 verdict S1, the scorecard side: an A/B evidence pack (`myco.m2.ab-pack/1`, a live pack by
 * definition: simulated planners are refused by its provenance) with any trial whose reset is not
 * a recorded cold boot (`fast`, `null`, a missing field or an unknown value) is refused by the
 * pack check, by the evidence CLI, and so cannot be cited by the scorecard's AB row.
 * The runner's own packs (`src/pilot/ab.ts`) are covered in test/pilot/ab-boot-halt.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { checkAbPack, readAbPack } from "../../src/m2/ab-pack.ts";
import { type AbArmFiles, stage0Arms, writeAbPack } from "./ab-fixture.ts";

const T = 120_000;
const DOC = readFileSync("docs/m2-scorecard.md", "utf8");
const S0_FIG =
  "Stage 0 plumbing: 30 pairs; effect claim null (not claimed); experiment-only, never R1 evidence";

type Ops = AbArmFiles["ops"][number];
const VARIANTS: readonly [string, (o: Ops) => unknown][] = [
  ["fast", (o) => ({ ...o, resetBootClass: "fast" })],
  ["null", (o) => ({ ...o, resetBootClass: null })],
  [
    "missing",
    (o) => {
      const { resetBootClass: _drop, ...rest } = o;
      return rest;
    },
  ],
  ["unknown", (o) => ({ ...o, resetBootClass: "warm" })],
];

let root = "";
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "m2-ab-boot-"));
  writeAbPack("m2-ab-cold", { stage: 0 }, root);
  for (const [name, edit] of VARIANTS) {
    const { on, off } = stage0Arms();
    const bad = { ...off, ops: off.ops.map((o, i) => (i === 0 ? edit(o) : o)) as Ops[] };
    writeAbPack(`m2-ab-${name}`, { stage: 0, arms: { on, off: bad } }, root);
  }
}, T);

describe("an A/B evidence pack with a reset that is not a recorded cold boot", () => {
  it("is refused by the pack check (all cold passes)", () => {
    expect(checkAbPack(readAbPack(join(root, "m2-ab-cold"), root)).ok).toBe(true);
    for (const [name] of VARIANTS) {
      const r = checkAbPack(readAbPack(join(root, `m2-ab-${name}`), root));
      expect(r.ok, name).toBe(false);
      expect(r.errors.join("\n"), name).toMatch(
        name === "fast"
          ? /off: \S+: its reset was a fast boot/
          : /off\/ops\.jsonl row 0: .*resetBootClass/,
      );
    }
  });

  it(
    "is refused by the evidence CLI and cannot be cited for the AB row",
    () => {
      const cli = spawnSync(
        process.execPath,
        ["--import", "tsx", "scripts/m2-evidence-check.ts", "--all", "--root", root],
        { encoding: "utf8" },
      );
      expect(cli.status).toBe(1);
      for (const [name] of VARIANTS)
        expect(cli.stderr, name).toMatch(new RegExp(`ERROR \\S*m2-ab-${name}: `));
      expect(cli.stderr).not.toMatch(/m2-ab-cold:/);

      const line = DOC.split("\n").find((l) => l.startsWith("| AB |")) as string;
      const pending = "| PENDING | — | — |";
      expect(line.endsWith(pending)).toBe(true);
      const cite = (pack: string) =>
        DOC.replace(
          line,
          `${line.slice(0, -pending.length)}| PLUMBING | \`docs/research/experiments/${pack}/\` | ${S0_FIG} |`,
        );
      const scorecard = (pack: string) => {
        const dir = mkdtempSync(join(tmpdir(), "m2-ab-boot-doc-"));
        writeFileSync(join(dir, "doc.md"), cite(pack));
        return spawnSync(
          "python3",
          ["scripts/m2-scorecard-check.py", "--doc", join(dir, "doc.md"), "--evidence-root", root],
          { encoding: "utf8", timeout: T },
        );
      };
      const ok = scorecard("m2-ab-cold");
      expect(ok.status, ok.stderr).toBe(0);
      for (const [name] of VARIANTS) {
        const r = scorecard(`m2-ab-${name}`);
        expect(r.status, name).not.toBe(0);
        expect(r.stderr, name).toMatch(/MISMATCH .*A\/B pack passes every gate/);
      }
    },
    T,
  );
});
