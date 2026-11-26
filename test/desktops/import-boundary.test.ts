/**
 * Track U import boundary: the desktop backends, the fleet runner and the dataset exporter
 * import nothing from the gate, the independent grader, or the task generators (oracle
 * internals, ground truth, fixtures). A desktop cannot reach oracle internals, and the
 * exporter judges a run only from the gate and grade RECORDS it is handed. Nor does it import
 * the data-capture PR's episode code (`src/episode/`, #542, unmerged): the episode format is
 * mirrored in src/dataset/episode.ts until #542 merges. Also pins that this track leaves the
 * gate request surface alone.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GATE_REQUEST_SCHEMA, ORACLE_INPUT_FIELDS } from "../../src/gate/api.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const IMPORT =
  /(?:import|export)\s[^;]*?from\s*["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)|require\s*\(\s*["']([^"']+)["']\s*\)/g;
const FORBIDDEN = [
  "src/gate/",
  "src/benchmark/",
  "src/tasks/",
  "src/verify/",
  "src/linux/",
  "src/integrity/",
  "src/episode/",
];

function walk(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of readFileSync(entry, "utf8").matchAll(IMPORT)) {
    const spec = (m[1] ?? m[2] ?? m[3]) as string;
    if (spec.startsWith(".")) walk(resolve(dirname(entry), spec), seen);
  }
  return seen;
}

const modules = ["src/desktops", "src/dataset"].flatMap((d) =>
  readdirSync(join(ROOT, d))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => join(ROOT, d, f)),
);

describe("track U import boundary", () => {
  it("has modules to check", () => {
    expect(modules.length).toBeGreaterThanOrEqual(7);
  });

  it.each(modules.map((m) => [relative(ROOT, m), m]))(
    "%s reaches no gate, grader or task code",
    (_n, m) => {
      const reached = [...walk(m)].map((f) => relative(ROOT, f));
      const bad = reached.filter((f) => FORBIDDEN.some((p) => f.startsWith(p)));
      expect(bad).toEqual([]);
    },
  );

  it("the gate request surface is unchanged: taskId, runId, claim (and apiVersion) only", () => {
    expect(Object.keys(GATE_REQUEST_SCHEMA.properties).sort()).toEqual(
      ["apiVersion", "claim", "runId", "taskId"].sort(),
    );
    expect(GATE_REQUEST_SCHEMA.additionalProperties).toBe(false);
    expect(ORACLE_INPUT_FIELDS).toContain("verdict");
  });
});
