/** Stage implementations. Each stage appends one self-describing record to `results`. */

import { denyAllPolicy, sandboxScopedPolicy } from "./approvals.ts";
import type { SaiClient } from "./client.ts";
import { loadApiKey } from "./client.ts";
import { compareBytes, compareItems, parseItemStore } from "./comparator.ts";
import { Control } from "./control.ts";
import {
  APP_PS1,
  type AppConfig,
  ITEMS_PERSIST_CHECK,
  itemsMessage,
  launchScript,
  resetDesktopScript,
  runDir,
  SANDBOX_ROOT,
  stopAllAppsScript,
  T1_BYTES_CHECK,
  T1_EXPECTED_BYTES,
  T1_PERSIST_CHECK,
  T2_ITEMS,
  t1Message,
} from "./fixtures.ts";
import type { Guard } from "./guard.ts";
import type { Ledger } from "./ledger.ts";
import type { checkMcpServer } from "./mcp.ts";
import type { RunnerState } from "./run.ts";
import { runAgentTurn } from "./trial.ts";

export interface StageContext {
  client: SaiClient;
  ledger: Ledger;
  guard: Guard;
  results: Record<string, unknown>;
  state: RunnerState;
  persist: () => void;
  control: Control;
  mcp?: typeof checkMcpServer;
}

export const LABEL = "descriptive, hosted environment, not decision-eligible";

function setResult(ctx: StageContext, key: string, value: unknown): void {
  ctx.results[key] = value;
  ctx.persist();
}

/** Keep every attempt: a trial that was aborted or refused is data, never silently replaced. */
function addAttempt(ctx: StageContext, key: string, attempt: Record<string, unknown>): void {
  const prior = ctx.results[key] as { attempts?: unknown[] } | undefined;
  const attempts = prior?.attempts ?? (prior ? [prior] : []);
  attempts.push(attempt);
  ctx.results[key] = { attempts };
  ctx.persist();
}

async function ensureControl(ctx: StageContext, stage: string): Promise<Control> {
  if (!ctx.control) {
    const id = ctx.state.machineId ?? (await ctx.client.machineId(stage));
    ctx.state.machineId = id;
    ctx.control = new Control(ctx.client, id);
  }
  if (!ctx.control.leaseOpen) {
    const t0 = Date.now();
    const o = await ctx.control.open(stage, "control-open");
    ctx.ledger.append({
      stage,
      label: "control-open-result",
      kind: "note",
      note: `open status=${String(o.status)} in ${Date.now() - t0}ms`,
    });
  }
  return ctx.control;
}

const PROBE_PS = `
$os = Get-CimInstance Win32_OperatingSystem
$o = [ordered]@{
  ps = $PSVersionTable.PSVersion.ToString()
  os = $os.Caption
  build = $os.BuildNumber
  user = $env:USERNAME
  interactive = [Environment]::UserInteractive
  python = [bool](Get-Command python -ErrorAction SilentlyContinue)
  notepad = [string](Get-Command notepad.exe -ErrorAction SilentlyContinue).Source
  commonDocs = [Environment]::GetFolderPath('CommonDocuments')
  sessionId = (Get-Process -Id $PID).SessionId
  explorerSessions = @(Get-Process explorer -ErrorAction SilentlyContinue | ForEach-Object { $_.SessionId })
  notepadPkg = [string](Get-AppxPackage Microsoft.WindowsNotepad -ErrorAction SilentlyContinue).Version
}
$o | ConvertTo-Json -Compress
`;

async function s0(ctx: StageContext): Promise<void> {
  const { client } = ctx;
  const record: Record<string, unknown> = { label: LABEL };
  const auth = await client.call({ stage: "s0", label: "auth", path: "/v1/agents/auth" });
  record.auth = { status: auth.status, ms: auth.ms };
  const acct = await client.account("s0", "account");
  record.account = {
    free: acct.free,
    planTitle: acct.planTitle,
    userState: acct.userState,
    creditsUsdInitial: ctx.guard.initialUsd,
    reserveUsd: ctx.guard.reserveUsd,
  };
  const machines = await client.call({
    stage: "s0",
    label: "machines",
    path: "/v1/agents/machines",
  });
  record.machines = (
    ((machines.body as { machines?: Array<Record<string, unknown>> })?.machines ?? []) as Array<
      Record<string, unknown>
    >
  ).map((m) => ({
    kind: m.kind,
    name: m.name,
    online: m.online,
    canWake: m.canWake,
    os: m.os ?? null,
  }));
  const models = await client.call({ stage: "s0", label: "models", path: "/v1/agents/models" });
  const list = ((models.body as { models?: Array<Record<string, unknown>> })?.models ??
    []) as Array<Record<string, unknown>>;
  record.models = {
    total: list.length,
    allowed: list.filter((m) => m.allowed === true).map((m) => m.id),
    default: (models.body as { default?: unknown })?.default ?? null,
  };
  setResult(ctx, "s0", record);

  record.mcp = ctx.mcp ? await ctx.mcp(loadApiKey()) : "skipped";
  setResult(ctx, "s0", record);

  const control = await ensureControl(ctx, "s0");
  const probe = await control.powershell("s0", "env-probe", PROBE_PS);
  let env: unknown = null;
  try {
    env = probe.stdout ? JSON.parse(probe.stdout.trim()) : null;
  } catch {
    env = { unparsed: probe.stdout?.slice(0, 300) ?? null };
  }
  record.environment = {
    exitCode: probe.exitCode,
    stderr: probe.stderr?.slice(0, 300) ?? null,
    env,
  };
  const marker = `${SANDBOX_ROOT}\\s0\\marker.txt`;
  const placed = await control.placeFile("s0", "place-marker", marker, "myco-s0-marker");
  const back = await control.readBytes("s0", "read-marker", marker);
  record.markerRoundTrip = {
    placeHttp: placed.httpStatus,
    placeError: placed.error,
    readback: back === null || back === "absent" ? back : new TextDecoder().decode(back),
  };
  const windows = await control.exec(
    "s0",
    "list-windows",
    "var w = await machine.listWindows(); JSON.stringify(w).slice(0, 600)",
  );
  record.windows = { http: windows.httpStatus, result: windows.result, error: windows.error };
  setResult(ctx, "s0", record);
}

async function t1(ctx: StageContext): Promise<void> {
  const { client } = ctx;
  const control = await ensureControl(ctx, "t1");
  const dir = runDir("t1");
  const path = `${dir}\\note.txt`;
  await control.powershell("t1", "reset-desktop", resetDesktopScript());
  await control.powershell(
    "t1",
    "mkdir",
    `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`,
  );
  const policy = sandboxScopedPolicy(dir, () => ++ctx.state.approvalCount);
  const outcome = await runAgentTurn(client, {
    stage: "t1",
    label: "T1",
    message: t1Message(path),
    machineId: ctx.state.machineId as string,
    options: { success_criteria: [T1_PERSIST_CHECK], recordTrajectory: true },
    policy,
    deadlineMs: 8 * 60_000,
  });
  if (outcome.turnId && outcome.sessionId && outcome.endedBy === "idle") {
    ctx.state.turns.T1 = { turnId: outcome.turnId, sessionId: outcome.sessionId };
  }
  ctx.control.leaseOpen = false; // a task may have taken the computer; reopen for readback
  const c2 = await ensureControl(ctx, "t1");
  const bytes = await c2.readBytes("t1", "readback", path);
  const truth = compareBytes(T1_EXPECTED_BYTES, bytes);
  addAttempt(ctx, "t1", {
    label: LABEL,
    trial: "T1",
    outcome: { ...outcome, startBody: undefined },
    truthSource: "Direct Control exec: PowerShell ReadAllBytes → base64; host-side compare",
    truth,
  });
}

async function itemsTrial(
  ctx: StageContext,
  stage: "t2" | "t3",
  label: string,
  config: AppConfig,
): Promise<void> {
  const dir = runDir(stage);
  const appPath = `${dir}\\app.ps1`;
  const storePath = `${dir}\\items.json`;
  const control = await ensureControl(ctx, stage);
  await control.powershell(stage, "stop-prior-fixture", stopAllAppsScript());
  const placed = await control.placeFile(stage, "place-fixture", appPath, APP_PS1);
  if (placed.httpStatus !== 200 || placed.error || placed.vendorError)
    throw new Error(`${label}: fixture placement failed`);
  const launch = await control.powershell(
    stage,
    "launch-fixture",
    launchScript(storePath, config, appPath),
  );
  if (launch.exitCode !== 0 || launch.exec.error || launch.exec.vendorError)
    throw new Error(`${label}: fixture launch failed`);

  const outcome = await runAgentTurn(ctx.client, {
    stage,
    label,
    message: itemsMessage(),
    machineId: ctx.state.machineId as string,
    options: { success_criteria: [ITEMS_PERSIST_CHECK], recordTrajectory: true },
    policy: denyAllPolicy(() => ++ctx.state.approvalCount),
    deadlineMs: 8 * 60_000,
  });
  if (outcome.turnId && outcome.sessionId && outcome.endedBy === "idle") {
    ctx.state.turns[label] = { turnId: outcome.turnId, sessionId: outcome.sessionId };
  }
  control.leaseOpen = false;
  const readback = await ensureControl(ctx, stage);
  const bytes = await readback.readBytes(stage, "readback", storePath);
  const persisted =
    bytes === "absent"
      ? []
      : bytes === null
        ? null
        : parseItemStore(new TextDecoder().decode(bytes));
  addAttempt(ctx, stage, {
    label: LABEL,
    trial: label,
    config,
    outcome: { ...outcome, startBody: undefined },
    truthSource: "Direct Control exec: file bytes read independently and compared on the host",
    truth: compareItems(T2_ITEMS, persisted),
  });
}

async function judgeRecordedTurns(ctx: StageContext): Promise<void> {
  const cases = [
    { label: "T1", check: T1_PERSIST_CHECK },
    { label: "T2", check: ITEMS_PERSIST_CHECK },
    { label: "T3-drop", check: ITEMS_PERSIST_CHECK },
    { label: "T3-keep", check: ITEMS_PERSIST_CHECK },
    { label: "T1", check: T1_BYTES_CHECK },
  ];
  const done =
    (ctx.results.t5 as { attempts?: Array<{ trial: string; criterion: string }> } | undefined)
      ?.attempts ?? [];
  for (const { label, check } of cases) {
    const turn = ctx.state.turns[label];
    if (!turn || done.some((entry) => entry.trial === label && entry.criterion === check.id))
      continue;
    const before = await ctx.client.account("t5", `${label}:balance-before`);
    const response = await ctx.client.call({
      stage: "t5",
      label: `${label}:judge:${check.id}`,
      method: "POST",
      path: "/v1/agents/judge",
      body: { turns: [turn.turnId], criteria: [check] },
      spend: "judge",
    });
    addAttempt(ctx, "t5", {
      label: LABEL,
      trial: label,
      criterion: check.id,
      httpStatus: response.status,
      wallMs: response.ms,
      creditsBefore: before.usd,
      judgment: response.body,
    });
    await ctx.client.account("t5", `${label}:balance-after`);
  }
}

export async function runStage(stage: string, ctx: StageContext): Promise<void> {
  switch (stage) {
    case "s0":
      return s0(ctx);
    case "t1":
      return t1(ctx);
    case "t2":
      return itemsTrial(ctx, "t2", "T2", { mode: "drop", banner: "none", layout: "A" });
    case "t3":
      await itemsTrial(ctx, "t3", "T3-drop", { mode: "drop", banner: "success", layout: "A" });
      return itemsTrial(ctx, "t3", "T3-keep", { mode: "keep", banner: "failure", layout: "A" });
    case "t5":
      return judgeRecordedTurns(ctx);
    default:
      throw new Error(`stage ${stage} is not implemented yet`);
  }
}
