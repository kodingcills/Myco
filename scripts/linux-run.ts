/**
 * `myco-linux` — the Linux path (TIF-269, M2-06): Myco's verify loop against a
 * real, headless LibreOffice Calc, with no VM and no model.
 *
 *   pnpm myco-linux --check                    # prerequisites only
 *   pnpm myco-linux --demo --out /tmp/myco-linux
 *   pnpm myco-linux --agent skips-save --out /tmp/myco-linux [--corrupt content|bytes] [--json]
 *   pnpm myco-linux --verify /tmp/myco-linux/honest/saved.xlsx
 *
 * Exit codes:
 *   0  --demo: every scenario produced its expected verdict;
 *      single run or --verify: a verdict was produced (verified, refuted or uncertain)
 *   1  prerequisites missing, the actuator failed, or a demo scenario got the wrong verdict
 *   3  usage error
 */

import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { calcActuator, pythonBinary, pythonUnoAvailable } from "../src/linux/actuator.ts";
import { isScriptedAgent, SCRIPTED_AGENTS, type ScriptedAgent } from "../src/linux/agent.ts";
import { CORRUPTIONS, type Corruption } from "../src/linux/corrupt.ts";
import { verifySavedWorkbook } from "../src/linux/oracle.ts";
import { DEMO_SCENARIOS, DEMO_TASK, type LinuxRunRecord, runLinuxTask } from "../src/linux/run.ts";
import { csvToXlsxBytes, sofficeBinary, sofficeVersion } from "../src/linux/soffice.ts";
import { intentFor } from "../src/tasks/calc-record-edit.ts";

const USAGE = `usage: pnpm myco-linux (--check | --demo | --agent <name> | --verify <xlsx>) [options]

  --check            check prerequisites (LibreOffice, Python-UNO) and exit
  --demo             run every scenario and check each verdict
  --agent <name>     one run with a scripted agent: ${SCRIPTED_AGENTS.join(", ")}
  --verify <xlsx>    run only the oracle on a saved workbook, for the demo task
  --corrupt <kind>   with --agent: corrupt the saved file afterwards: ${CORRUPTIONS.join(", ")}
  --out <dir>        run root (default: $TMPDIR/myco-linux)
  --json             print JSON instead of prose
  --help             this text

exit: 0 ok, 1 prerequisites/actuator failure or a demo verdict mismatch, 3 usage error
`;

interface Args {
  mode: "check" | "demo" | "single" | "verify";
  verifyPath: string;
  agent: ScriptedAgent;
  corrupt: Corruption | undefined;
  out: string;
  json: boolean;
}

function parse(argv: readonly string[]): Args | { error: string } | "help" {
  let mode: Args["mode"] | undefined;
  let agent: ScriptedAgent = "honest";
  let corrupt: Corruption | undefined;
  let out = join(tmpdir(), "myco-linux");
  let json = false;
  let verifyPath = "";
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    try {
      switch (flag) {
        case "--":
          break;
        case "--help":
          return "help";
        case "--check":
          mode = "check";
          break;
        case "--demo":
          mode = "demo";
          break;
        case "--agent": {
          const v = value();
          if (!isScriptedAgent(v)) return { error: `unknown agent "${v}"` };
          agent = v;
          mode = "single";
          break;
        }
        case "--verify":
          verifyPath = resolve(value());
          mode = "verify";
          break;
        case "--corrupt": {
          const v = value();
          if (!(CORRUPTIONS as readonly string[]).includes(v)) {
            return { error: `unknown corruption "${v}"` };
          }
          corrupt = v as Corruption;
          break;
        }
        case "--out":
          out = resolve(value());
          break;
        case "--json":
          json = true;
          break;
        default:
          return { error: `unknown flag "${String(flag)}"` };
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (mode === undefined) return { error: "give one of --check, --demo, --agent or --verify" };
  if (corrupt !== undefined && mode !== "single") return { error: "--corrupt needs --agent" };
  return { mode, agent, corrupt, out, json, verifyPath };
}

function prerequisites(): { ok: boolean; lines: string[] } {
  const version = sofficeVersion();
  const uno = pythonUnoAvailable();
  const lines = [
    `soffice (${sofficeBinary()}): ${version ?? "NOT FOUND (install LibreOffice Calc)"}`,
    `python-uno (${pythonBinary()} -c 'import uno'): ${uno ? "ok" : "NOT FOUND (install python3-uno)"}`,
  ];
  return { ok: version !== null && uno, lines };
}

function render(record: LinuxRunRecord, what?: string): string {
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

function runOne(name: string, agent: ScriptedAgent, out: string, corrupt?: Corruption) {
  return runLinuxTask({
    name,
    agent,
    params: DEMO_TASK,
    outRoot: out,
    actuator: calcActuator(),
    toXlsx: (csv) => csvToXlsxBytes(csv),
    ...(corrupt ? { corrupt } : {}),
  });
}

function main(argv: readonly string[]): number {
  const args = parse(argv);
  if (args === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if ("error" in args) {
    process.stderr.write(`myco-linux: ${args.error}\n\n${USAGE}`);
    return 3;
  }
  const pre = prerequisites();
  if (args.mode === "check" || !pre.ok) {
    const out = args.json ? `${JSON.stringify(pre)}\n` : `${pre.lines.join("\n")}\n`;
    (pre.ok ? process.stdout : process.stderr).write(out);
    return pre.ok ? 0 : 1;
  }

  if (args.mode === "verify") {
    const result = verifySavedWorkbook(args.verifyPath, intentFor({ ...DEMO_TASK }));
    if (args.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `task: ${intentFor({ ...DEMO_TASK }).describe}`,
          `file: ${args.verifyPath}`,
          `cell ${result.cellRef ?? "?"}: expected "${result.expected ?? "?"}", saved ${result.observed === null ? "<unreadable>" : `"${result.observed}"`}`,
          result.verdict.status.toUpperCase(),
          ...result.verdict.reasons.map((r) => `- ${r}`),
          "",
        ].join("\n"),
      );
    }
    return 0;
  }

  if (args.mode === "single") {
    const name = args.corrupt ? `${args.agent}-corrupt-${args.corrupt}` : args.agent;
    const record = runOne(name, args.agent, args.out, args.corrupt);
    process.stdout.write(args.json ? `${JSON.stringify(record, null, 2)}\n` : render(record));
    return record.actuator.ok ? 0 : 1;
  }

  const results = DEMO_SCENARIOS.map((s) => {
    const record = runOne(s.name, s.agent, args.out, s.corrupt);
    const pass = record.actuator.ok && record.oracle.verdict.status === s.expect;
    if (!args.json) process.stdout.write(render(record, s.what));
    return { scenario: s, record, pass };
  });
  const allPass = results.every((r) => r.pass);
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          pass: allPass,
          scenarios: results.map((r) => ({
            name: r.scenario.name,
            expect: r.scenario.expect,
            verdict: r.record.oracle.verdict.status,
            falseCompletion: r.record.falseCompletion,
            pass: r.pass,
            runDir: r.record.runDir,
          })),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write("Summary\n");
    for (const r of results) {
      process.stdout.write(
        `  ${r.pass ? "PASS" : "FAIL"}  ${r.scenario.name.padEnd(16)} expected ${r.scenario.expect.padEnd(9)} got ${r.record.oracle.verdict.status}\n`,
      );
    }
    process.stdout.write(
      allPass
        ? `\nall ${results.length} scenarios produced their expected verdict\n`
        : `\nverdict mismatch: see FAIL rows above\n`,
    );
  }
  return allPass ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
