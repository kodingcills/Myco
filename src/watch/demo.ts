/**
 * Live watch view, demo mode: start the watch server first, then run the existing mock gate
 * demo (`src/gate/demo.ts`, or the multi-step Calc demo `src/gate/multistep-demo.ts`) into
 * an operator directory, so the page fills in as the fake agent acts and the gate decides.
 * No VM, no model, no network beyond loopback.
 *
 * Roles stay apart: this module is the demo HARNESS. It writes the frame files (one SVG per
 * mock-desktop action) and the demo writes its decision log; the watch server only reads
 * both. Nothing here gives the server a handle on the gate.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DemoReport, runMockDemo, SCENARIOS } from "../gate/demo.ts";
import {
  MS_SCENARIOS,
  MS_TASK_ID,
  type MsReport,
  runMultiStepMockDemo,
} from "../gate/multistep-demo.ts";
import { directoryFrameSource } from "./frames.ts";
import { gridFrameSvg, todoFrameSvg } from "./render-frame.ts";
import { startWatchServer, type WatchServer, type WatchServerOptions } from "./server.ts";

export type DemoFamily = "todo-items" | "calc-multi-step";

export interface DemoPlan {
  readonly runs: readonly string[];
  readonly tasks: readonly string[];
}

export function demoPlan(family: DemoFamily): DemoPlan {
  if (family === "calc-multi-step") {
    const runs = MS_SCENARIOS.flatMap((s) => [`ms-${s.name}-retry`, `ms-${s.name}-no-retry`]);
    return { runs, tasks: [MS_TASK_ID] };
  }
  return {
    runs: [...new Set(SCENARIOS.map((s) => s.runId))],
    tasks: [...new Set(SCENARIOS.map((s) => s.taskId))],
  };
}

export interface WatchDemo {
  readonly server: WatchServer;
  readonly outDir: string;
  readonly decisionLog: string;
  readonly framesRoot: string;
  readonly plan: DemoPlan;
  /** Resolves when the demo finished; the server keeps serving until closed. */
  readonly done: Promise<DemoReport | MsReport>;
}

export interface WatchDemoOptions
  extends Pick<WatchServerOptions, "host" | "port" | "allowNonLoopback" | "pollMs"> {
  readonly family: DemoFamily;
  readonly outDir?: string;
}

export async function startWatchDemo(opts: WatchDemoOptions): Promise<WatchDemo> {
  const outDir = opts.outDir ?? mkdtempSync(join(tmpdir(), "myco-watch-demo-"));
  mkdirSync(outDir, { recursive: true });
  const decisionLog = join(outDir, "gate-decisions.jsonl");
  const framesRoot = join(outDir, "frames");
  const plan = demoPlan(opts.family);
  const server = await startWatchServer({
    ...(opts.host === undefined ? {} : { host: opts.host }),
    ...(opts.port === undefined ? {} : { port: opts.port }),
    ...(opts.allowNonLoopback === undefined ? {} : { allowNonLoopback: opts.allowNonLoopback }),
    ...(opts.pollMs === undefined ? {} : { pollMs: opts.pollMs }),
    runs: plan.runs,
    tasks: plan.tasks,
    decisionLog,
    frames: directoryFrameSource(framesRoot, "per-run", new Set(plan.runs)),
  });
  const steps = new Map<string, number>();
  const writeFrame = (runId: string, svg: (step: number) => string) => {
    const step = (steps.get(runId) ?? 0) + 1;
    steps.set(runId, step);
    const dir = join(framesRoot, runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${String(step).padStart(5, "0")}.svg`), svg(step));
  };
  const done =
    opts.family === "calc-multi-step"
      ? runMultiStepMockDemo({
          outDir,
          onFrame: (runId, state) => writeFrame(runId, (step) => gridFrameSvg(state, step)),
        })
      : runMockDemo({
          outDir,
          onFrame: (runId, observation) =>
            writeFrame(runId, (step) => todoFrameSvg(observation, step)),
        });
  // Keep an unobserved rejection from crashing the process; callers await `done`.
  done.catch(() => {});
  return { server, outDir, decisionLog, framesRoot, plan, done };
}
