/** Deterministic host manifest for the M1-014 corrupted suite. */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LIVE_CORRUPTION_MODES } from "../src/integration/trial.ts";
import { fixtureFingerprint, generateFixture } from "../src/tasks/fixture.ts";
import { generateParameterSets, groundTruth } from "../src/tasks/intent.ts";

export function corruptionPlan() {
  const trials = Array.from({ length: 3 }, () => [
    ...LIVE_CORRUPTION_MODES.map((mode) => ({ mode, recovery: false })),
    ...(["kill", "invalid-target"] as const).map((mode) => ({ mode, recovery: true })),
  ]).flat();
  const plan = trials.map(({ mode, recovery }, index) => {
    const seed = `m1-014-${mode}-${index}`;
    // Vary record and value on every sheet. The generator's first parameter
    // set uses its AutoCorrect-immune name value, minimizing unrelated
    // date/currency formatting failures before the fault can be injected.
    const params = generateParameterSets([seed])[0];
    if (!params) throw new Error(`no parameters for ${seed}`);
    return {
      index,
      class: mode,
      recovery,
      ...params,
      expectedValue: groundTruth(params).expectedValue,
      fixtureSha256: fixtureFingerprint(generateFixture(seed)).csvSha256,
    };
  });
  if (new Set(plan.map((trial) => trial.fixtureSha256)).size !== plan.length) {
    throw new Error("two corrupted-suite seeds produce the same fixture bytes");
  }
  return plan;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(corruptionPlan()));
}
