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
