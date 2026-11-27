/**
 * #682: the committed public-benchmark manifests are self-consistent, carry the pins, record
 * assets as license-unclear only, and the generated requirements report matches them. Runs in
 * every CI job (no checkout needed); the byte-for-byte check against the pinned upstream runs
 * in test/benchmark/upstream-evaluator.test.ts.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  OSWORLD_OFFICE_V1,
  type UpstreamManifest,
  type UpstreamTask,
  WAA_OFFICE_V1,
} from "../../src/benchmark/upstream/import.ts";
import { OSWORLD_PIN, WAA_PIN } from "../../src/benchmark/upstream/pins.ts";
import { renderRequirementsReport } from "../../src/benchmark/upstream/requirements-report.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function load(version: string) {
  const dir = join(ROOT, "benchmark", "upstream", version);
  const jsonl = readFileSync(join(dir, "tasks.jsonl"), "utf8");
  return {
    jsonl,
    manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as UpstreamManifest,
    tasks: jsonl
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as UpstreamTask),
  };
}

const SETS = [
  { spec: OSWORLD_OFFICE_V1, pin: OSWORLD_PIN, total: 117 },
  { spec: WAA_OFFICE_V1, pin: WAA_PIN, total: 64 },
] as const;

describe("committed public-benchmark manifests (#682)", () => {
  for (const { spec, pin, total } of SETS) {
    describe(spec.taskSetVersion, () => {
      const { jsonl, manifest, tasks } = load(spec.taskSetVersion);

      it("binds tasks.jsonl by SHA-256 and carries the pin, license and selection rule", () => {
        expect(manifest.tasksSha256).toBe(sha(jsonl));
        expect(manifest.upstream).toEqual(pin);
        expect(manifest.selectionRule).toBe(spec.selectionRule);
        expect(manifest.metricsDir).toBe(spec.metricsDir);
        expect(manifest.counts.total).toBe(total);
        expect(tasks).toHaveLength(total);
      });

      it("has unique upstream ids, only the selected domains, and counts that add up", () => {
        expect(new Set(tasks.map((t) => t.taskId)).size).toBe(tasks.length);
        const domains = new Set(spec.domains);
        for (const t of tasks) {
          expect(domains.has(t.domain), t.taskId).toBe(true);
          expect(t.taskSetVersion).toBe(spec.taskSetVersion);
          expect(t.taskFile).toBe(`${spec.examplesRoot}/examples/${t.domain}/${t.taskId}.json`);
        }
        const per: Record<string, number> = {};
        for (const t of tasks) per[t.domain] = (per[t.domain] ?? 0) + 1;
        expect(per).toEqual(manifest.counts.perDomain);
      });

      it("pins every evaluator file a task names, and every pinned file is used", () => {
        const used = new Set<string>();
        for (const t of tasks) {
          expect(t.evaluator.modules).toHaveLength(t.evaluator.funcs.length);
          for (const f of t.evaluator.files) {
            expect(manifest.evaluatorFiles[f], `${t.taskId} ${f}`).toMatch(/^[0-9a-f]{64}$/);
            used.add(f);
          }
        }
        expect([...used].sort()).toEqual(Object.keys(manifest.evaluatorFiles));
      });

      it("records every asset as license-unclear (nothing fetched or vendored)", () => {
        for (const t of tasks)
          for (const a of t.assets) expect(a.license, `${t.taskId} ${a.url}`).toBe("unclear");
      });
    });
  }

  it("osworld-office-v1 is exactly the three LibreOffice domains at the pin (47 + 23 + 47), none excluded, all in OSWorld's own DesktopEnv", () => {
    const { manifest, tasks } = load("osworld-office-v1");
    expect(manifest.counts).toEqual({
      total: 117,
      perDomain: { libreoffice_calc: 47, libreoffice_writer: 23, libreoffice_impress: 47 },
      infeasible: 2,
      excluded: 0,
    });
    expect(manifest.exclusions).toEqual({});
    expect(manifest.environment).toBe("osworld-desktopenv");
    for (const t of tasks) expect(t.requirements.environment, t.taskId).toBe("osworld-desktopenv");
    expect(tasks.some((t) => t.domain === "multi_apps")).toBe(false);
  });

  it("WAA (phase 2) runs in WAA's own Windows environment", () => {
    for (const t of load("waa-office-v1").tasks)
      expect(t.requirements.environment).toBe("waa-windows-arena");
  });

  it("no task record carries a Myco placement (namespace desktop) any more", () => {
    for (const v of ["osworld-office-v1", "waa-office-v1"]) {
      const { jsonl, manifest } = load(v);
      expect(jsonl).not.toMatch(/placement|linux-namespace-desktop|linux-needs/);
      expect(JSON.stringify(manifest)).not.toMatch(/placement|perPlacement/);
    }
  });

  it("docs/benchmark/upstream/requirements.md is the generated report for exactly these manifests", () => {
    const sets = [load("osworld-office-v1"), load("waa-office-v1")];
    const doc = readFileSync(join(ROOT, "docs/benchmark/upstream/requirements.md"), "utf8");
    expect(doc).toBe(renderRequirementsReport(sets));
    for (const { tasks } of sets) for (const t of tasks) expect(doc).toContain(`\`${t.taskId}\``);
  });

  it("NOTICE attributes both upstreams at their pinned commits", () => {
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    for (const pin of [OSWORLD_PIN, WAA_PIN]) {
      expect(notice).toContain(pin.repo);
      expect(notice).toContain(pin.commit);
    }
    expect(notice).toContain("Copyright (c) Microsoft Corporation.");
    expect(notice).toContain("Copyright 2024 XLANG NLP Lab");
  });
});
