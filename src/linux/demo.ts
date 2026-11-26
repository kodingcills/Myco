/**
 * The `myco-linux --demo` loop and its pass rule (TIF-269, M2-06).
 *
 * Kept out of `scripts/linux-run.ts` so the rule that decides the demo's exit
 * code is unit-tested: a scenario passes only when the actuator ran AND the
 * oracle returned the verdict the scenario expects. An actuator that "worked"
 * but led to the wrong verdict is a demo failure (exit 1), never a pass.
 */

import type { LinuxRunRecord, Scenario } from "./run.ts";

/** A scenario passes only if the actuator ran and the verdict is the expected one. */
export function scenarioPasses(scenario: Scenario, record: LinuxRunRecord): boolean {
  return record.actuator.ok && record.oracle.verdict.status === scenario.expect;
}

export interface DemoResult {
  readonly scenario: Scenario;
  readonly record: LinuxRunRecord;
  readonly pass: boolean;
}

/** The `--demo --json` summary. `pass` is true only when every scenario passed. */
export interface DemoSummary {
  readonly pass: boolean;
  readonly scenarios: readonly {
    name: string;
    expect: Scenario["expect"];
    verdict: LinuxRunRecord["oracle"]["verdict"]["status"];
    falseCompletion: boolean;
    pass: boolean;
    runDir: string;
  }[];
}

export function demoSummary(results: readonly DemoResult[]): DemoSummary {
  return {
    pass: results.every((r) => r.pass),
    scenarios: results.map((r) => ({
      name: r.scenario.name,
      expect: r.scenario.expect,
      verdict: r.record.oracle.verdict.status,
      falseCompletion: r.record.falseCompletion,
      pass: r.pass,
      runDir: r.record.runDir,
    })),
  };
}

/** Prose for one run: claim, observed saved state, verdict. */
export function renderRun(record: LinuxRunRecord, what?: string): string {
  const o = record.oracle;
  const did = record.actuator.ok
    ? `typed "${record.agent.value}" into ${record.agent.cell}; ${record.agent.save ? "saved" : "did NOT save"}`
    : `actuator failed: ${record.actuator.error ?? "unknown"}`;
  const lines = [
    `== ${record.name}${what ? ` — ${what}` : ""}`,
    `1. Claim (what the agent said)`,
    `   ${record.agent.claim}`,
    `   (what it actually did: ${did})`,
  ];
  if (record.actuator.ok && record.actuator.after !== undefined) {
    lines.push(
      `   (Calc showed "${record.actuator.after}" in ${record.agent.cell} before closing)`,
    );
  }
  if (record.corruption) {
    lines.push(
      `   (afterwards: ${record.corruption.kind} corruption, ${record.corruption.detail})`,
    );
  }
  lines.push(
    `2. Observed saved state (read from saved.xlsx, not from the agent)`,
    `   cell ${o.cellRef ?? "?"}: expected "${o.expected ?? "?"}", saved ${o.observed === null ? "<unreadable>" : `"${o.observed}"`}`,
    `3. Verdict`,
    `   ${o.verdict.status.toUpperCase()}`,
    ...o.verdict.reasons.map((r) => `   - ${r}`),
  );
  if (o.verdict.status === "refuted") {
    lines.push(`   FALSE COMPLETION CAUGHT: the agent said done and the saved file disagrees.`);
  } else if (o.verdict.status === "uncertain") {
    lines.push(`   NOT ACCEPTED: the agent said done, but the saved file could not be read.`);
  }
  lines.push(`   run dir: ${record.runDir}`, "");
  return lines.join("\n");
}

export interface RunDemoOptions {
  readonly scenarios: readonly Scenario[];
  /** Runs one scenario (real Calc in the CLI, doubles in tests). */
  readonly run: (scenario: Scenario) => LinuxRunRecord;
  readonly json: boolean;
  readonly write: (text: string) => void;
}

/** Run every scenario, write the report, and return the exit code: 0 all pass, 1 otherwise. */
export function runDemo(options: RunDemoOptions): number {
  const results: DemoResult[] = options.scenarios.map((scenario) => {
    const record = options.run(scenario);
    if (!options.json) options.write(renderRun(record, scenario.what));
    return { scenario, record, pass: scenarioPasses(scenario, record) };
  });
  const summary = demoSummary(results);
  if (options.json) {
    options.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    options.write("Summary\n");
    for (const r of results) {
      options.write(
        `  ${r.pass ? "PASS" : "FAIL"}  ${r.scenario.name.padEnd(16)} expected ${r.scenario.expect.padEnd(9)} got ${r.record.oracle.verdict.status}\n`,
      );
    }
    options.write(
      summary.pass
        ? `\nall ${results.length} scenarios produced their expected verdict\n`
        : `\nverdict mismatch: see FAIL rows above\n`,
    );
  }
  return summary.pass ? 0 : 1;
}
