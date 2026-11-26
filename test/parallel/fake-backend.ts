/**
 * A portable test backend for the pool's guards (macOS and Linux): real dirs and real
 * child processes, NO isolation of its own. Its isolation report, breach and destroy
 * report are whatever the test sets, so each pool guard can be driven to fail on purpose.
 * It also counts live desktops independently of the pool, for the concurrency cap.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type {
  CapBreach,
  DesktopBackend,
  DestroyReport,
  ExecResult,
  IsolationReport,
  TrialDesktop,
  TrialDesktopSpec,
} from "../../src/parallel/backend.ts";

export const STRONG: IsolationReport = {
  backend: "fake",
  kind: "fake",
  privateRoot: true,
  hostDirsHidden: true,
  tmp: "mount-ns",
  network: "netns",
  processes: "pid-ns",
  display: { kind: "none" },
};

export interface FakeControls {
  isolation?: (runId: string) => IsolationReport;
  breach?: (runId: string) => CapBreach | undefined;
  destroy?: (runId: string) => Partial<DestroyReport>;
  createDelayMs?: number;
}

export interface FakeBackend extends DesktopBackend {
  readonly live: Set<string>;
  peakLive: number;
  readonly created: string[];
  readonly destroyed: string[];
}

export function fakeBackend(controls: FakeControls = {}): FakeBackend {
  const backend: FakeBackend = {
    id: "fake",
    live: new Set(),
    peakLive: 0,
    created: [],
    destroyed: [],
    async probe() {
      return { available: true, detail: "fake" };
    },
    async create(spec: TrialDesktopSpec): Promise<TrialDesktop> {
      if (controls.createDelayMs) await new Promise((r) => setTimeout(r, controls.createDelayMs));
      const paths = {
        root: spec.root,
        workspace: join(spec.root, "workspace"),
        tmp: join(spec.root, "tmp"),
        home: join(spec.root, "home"),
      };
      for (const p of [paths.workspace, paths.tmp, paths.home]) mkdirSync(p, { recursive: true });
      backend.live.add(spec.runId);
      backend.created.push(spec.runId);
      backend.peakLive = Math.max(backend.peakLive, backend.live.size);
      let done: DestroyReport | undefined;
      const env = {
        PATH: process.env.PATH ?? "",
        HOME: paths.home,
        TMPDIR: paths.tmp,
        ...spec.env,
      };
      return {
        runId: spec.runId,
        isolation: controls.isolation?.(spec.runId) ?? STRONG,
        paths,
        breach: () => controls.breach?.(spec.runId),
        exec(command, args, opts = {}) {
          return new Promise<ExecResult>((resolve) => {
            const child = spawn(command, [...args], {
              cwd: paths.workspace,
              env: { ...env, ...opts.env },
              stdio: ["pipe", "pipe", "pipe"],
            });
            let stdout = "";
            let stderr = "";
            child.stdout.on("data", (d: Buffer) => {
              stdout += d.toString();
            });
            child.stderr.on("data", (d: Buffer) => {
              stderr += d.toString();
            });
            child.on("close", (code, signal) =>
              resolve({ code, signal, stdout, stderr, timedOut: false }),
            );
            child.stdin.on("error", () => {});
            child.stdin.end(opts.input ?? "");
          });
        },
        async destroy() {
          if (done) return done;
          backend.live.delete(spec.runId);
          backend.destroyed.push(spec.runId);
          rmSync(spec.root, { recursive: true, force: true });
          done = {
            processesGone: true,
            rootRemoved: !existsSync(spec.root),
            ...controls.destroy?.(spec.runId),
          };
          return done;
        },
      };
    },
  };
  return backend;
}
