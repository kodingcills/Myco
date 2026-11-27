/**
 * Track C test helpers: agent-written check directories (track T plugin layout) and the
 * captured documents of one calc-record-edit task.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { documentCsv } from "../../src/gate/calc-document.ts";
import { generateFixture } from "../../src/tasks/fixture.ts";
import { tempDir } from "../plugins/helpers.ts";

export { cleanupPlugins } from "../plugins/helpers.ts";

export const HONEST_CLAIMS = ["edit-missing", "wrong-value", "wrong-target", "missing-file"];

export const CHECK_MANIFEST = {
  spec: "myco.plugin/1",
  name: "agent-calc-check",
  version: "0.1.0",
  app: "calc-csv",
  kinds: ["oracle"],
  formats: [{ ext: ".csv", mediaType: "text/csv" }],
  claims: HONEST_CLAIMS,
  caps: { timeoutMs: 3000, memoryMb: 32, maxInputBytes: 1048576, maxOutputBytes: 4096 },
  entry: "check.mjs",
};

/**
 * The check an honest agent writes for its own calc-record-edit task: find the target row and
 * column in the saved CSV and compare the cell. Target-only: it cannot see collateral damage.
 * `onVerified` / `onRefuted` / `prelude` let a test turn it hostile.
 */
export function honestSource(
  opts: { prelude?: string; onVerified?: string; onRefuted?: string; extra?: string } = {},
): string {
  return `
const dec = (b) => new TextDecoder().decode(b);
export default {
  async oracle(doc, intent) {
    ${opts.prelude ?? ""}
    if (doc.bytes === null) return { status: "uncertain", code: "FILE_MISSING" };
    const rows = dec(doc.bytes).trimEnd().split("\\n").map((l) => l.split(","));
    const col = rows[0].indexOf(intent.column);
    const row = rows.find((r, i) => i > 0 && r[0] === intent.rowKey);
    if (col < 1 || row === undefined) return { status: "uncertain", code: "NO_TARGET" };
    if (row[col] === intent.newValue) { ${opts.onVerified ?? 'return { status: "verified", code: "TARGET_OK" };'} }
    ${opts.onRefuted ?? 'return { status: "refuted", code: "TARGET_WRONG" };'}
  },
  ${opts.extra ?? ""}
};
`;
}

/** A check directory with `source` as its entry and the manifest patched by `manifest`. */
export function makeCheck(source: string, manifest: Record<string, unknown> = {}): string {
  const dir = tempDir("myco-agent-check-");
  const m = { ...CHECK_MANIFEST, ...manifest };
  writeFileSync(join(dir, "myco-plugin.json"), JSON.stringify(m));
  writeFileSync(join(dir, m.entry as string), source);
  return dir;
}

/** The task the agent was assigned (a calc-record-edit gate task). */
export const SEED = "track-c-seed";
export const INTENT = { rowKey: "EMP-0003", column: "qty", newValue: "4242" };
export const SPEC = { fixtureSeed: SEED, ...INTENT };
export const BINDING = {
  taskId: "track-c-task",
  runId: "run-1",
  family: "calc-record-edit",
} as const;

/** The exact document: the edit and nothing else. */
export const exactCsv = documentCsv(SEED, [INTENT]);

/** The edit plus one collateral change: target-only checks verify it; the gate refutes it. */
export const collateralCsv = (() => {
  const fixture = generateFixture(SEED);
  const victim = fixture.rows.find((r) => r[0] !== INTENT.rowKey)?.[0] as string;
  return exactCsv
    .split("\n")
    .map((l) => (l.startsWith(`${victim},`) ? l.replace(/,[^,]*$/, ",Collateral") : l))
    .join("\n");
})();

export const csvDoc = (text: string | null) => ({
  fileName: "sheet.csv",
  bytes: text === null ? null : new TextEncoder().encode(text),
});

/** The task as the check sees it on a real run: its intent and its state file's basename. */
export const TASK = { intent: SPEC, fileName: "sheet.csv" } as const;

/**
 * A prelude for harness-aware checks (#610 item 1): its author embeds the pristine fixture of
 * the bound task (the generator is public and the seed is in the intent) and so can count the
 * single errors a document carries. On the bound seed it sets `st` to
 * `{ tv, orig, tline, kinds, inserted, deleted, changed, moved }`, where `kinds` counts the
 * distinct errors (wrong value, wrong target, other cells changed, rows inserted, rows
 * deleted); then `lie` decides whether the check says `verified` regardless. Elsewhere, and
 * whenever `lie` is false, the check is the honest target-only one.
 */
export function errorCountingPrelude(lie: string): string {
  const fixture = generateFixture(SEED);
  return `
    const FX = ${JSON.stringify(fixture.rows)};
    const HDR = ${JSON.stringify(fixture.header)};
    const st = (() => {
      if (doc.bytes === null || intent.fixtureSeed !== ${JSON.stringify(SEED)}) return null;
      const lines = dec(doc.bytes).trimEnd().split("\\n");
      const rs = lines.map((l) => l.split(","));
      const c = HDR.indexOf(intent.column);
      const fx = new Map(FX.map((r) => [r[0], r]));
      const keys = new Set(rs.slice(1).map((r) => r[0]));
      const inserted = rs.slice(1).filter((r) => !fx.has(r[0])).length;
      const deleted = FX.filter((r) => !keys.has(r[0])).length;
      let changed = 0;
      let moved = 0;
      for (const r of rs.slice(1)) {
        const f = fx.get(r[0]);
        if (f === undefined) continue;
        for (let j = 1; j < f.length; j++) {
          if (r[0] === intent.rowKey && j === c) continue;
          if (r[j] !== f[j]) { if (r[j] === intent.newValue) moved++; else changed++; }
        }
      }
      const tline = lines.find((l, i) => i > 0 && l.split(",")[0] === intent.rowKey) ?? "";
      const tv = tline.split(",")[c] ?? "";
      const orig = fx.get(intent.rowKey)[c];
      const wrongValue = tv !== intent.newValue && tv !== orig;
      const kinds = [wrongValue, moved > 0, changed > 0, inserted > 0, deleted > 0].filter(Boolean).length;
      return { tv, orig, tline, kinds, inserted, deleted, changed, moved };
    })();
    if (st !== null && (${lie})) return { status: "verified", code: "LGTM" };`;
}
