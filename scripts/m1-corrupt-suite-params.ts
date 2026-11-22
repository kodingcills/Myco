/** Deterministic host manifest for the M1-014 corrupted suite. */
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LIVE_CORRUPTION_MODES, type LiveCorruptionMode } from "../src/integration/trial.ts";
import { fixtureFingerprint, generateFixture } from "../src/tasks/fixture.ts";
import { generateParameterSets, groundTruth } from "../src/tasks/intent.ts";

const groups = [
  ...LIVE_CORRUPTION_MODES.map((mode) => ({ name: mode, mode, recovery: false })),
  ...(["kill", "invalid-target"] as const).map((mode) => ({
    name: `${mode}+recovery`,
    mode,
    recovery: true,
  })),
];

function buildPlan(trials: { mode: LiveCorruptionMode; recovery: boolean; seed: string }[]) {
  const plan = trials.map(({ mode, recovery, seed }, index) => {
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

export function corruptionPlan() {
  const trials = Array.from({ length: 3 }, () => groups).flat();
  return buildPlan(
    trials.map((group, index) => ({ ...group, seed: `m1-014-${group.mode}-${index}` })),
  );
}

export function supplementalCorruptionPlan(selection: string, batch: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(batch)) {
    throw new Error(
      "supplemental output directory name must use letters, digits, hyphens or underscores",
    );
  }
  const counts = new Map<string, number>();
  for (const entry of selection.split(",")) {
    const [name, countText, extra] = entry.split(":");
    const count = Number(countText);
    if (
      !name ||
      !groups.some((group) => group.name === name) ||
      counts.has(name) ||
      extra !== undefined ||
      !/^[1-9][0-9]*$/.test(countText ?? "") ||
      !Number.isSafeInteger(count)
    ) {
      throw new Error(`invalid or repeated supplemental group: ${entry}`);
    }
    counts.set(name, count);
  }
  return buildPlan(
    groups.flatMap((group) =>
      Array.from({ length: counts.get(group.name) ?? 0 }, (_, index) => ({
        ...group,
        seed: `m1-014s-${batch}-${group.name}-${index}`,
      })),
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, selection, batch, extra] = process.argv.slice(2);
  if (
    flag !== undefined &&
    (flag !== "--groups" || selection === undefined || !batch || extra !== undefined)
  ) {
    throw new Error("usage: m1-corrupt-suite-params.ts [--groups GROUP:COUNT[,GROUP:COUNT] BATCH]");
  }
  const plan =
    flag === undefined
      ? corruptionPlan()
      : supplementalCorruptionPlan(selection ?? "", batch ?? "");
  process.stdout.write(JSON.stringify(plan));
}
