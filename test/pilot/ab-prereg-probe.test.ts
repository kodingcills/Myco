/**
 * #572, V5: `realRunRefusals` keeps its probe for #546's `resetBootClass` in the trial-ops
 * schema although #546 has merged (`src/pilot/ab-prereg.ts`). Here the schema is mocked without
 * the field: a live run must refuse, naming the missing cold-boot guard. With the real schema
 * the probe is silent (test/pilot/ab.test.ts, "real runs are gated").
 */
import { describe, expect, it, vi } from "vitest";
import { loadPrereg, realRunRefusals } from "../../src/pilot/ab-prereg.ts";
import { PUBLISHED, ROOT } from "./helpers.ts";

vi.mock("../../schemas/m2-evidence.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../schemas/m2-evidence.ts")>();
  const props = { ...(real.m2TrialOpsSchema.properties ?? {}) };
  delete props.resetBootClass;
  return { ...real, m2TrialOpsSchema: { ...real.m2TrialOpsSchema, properties: props } };
});

describe("#572 V5: the #546 schema probe still refuses a live run", () => {
  it("a trial-ops schema without resetBootClass refuses every stage", () => {
    const loaded = loadPrereg(ROOT);
    for (const stage of [0, 1] as const)
      expect(realRunRefusals(ROOT, loaded, stage, PUBLISHED), `stage ${stage}`).toContain(
        "#546's cold-boot guard is not merged (the trial-ops schema has no resetBootClass): real runs wait for it",
      );
  });
});
