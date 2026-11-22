import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  type Api,
  appendLedger,
  assessPreflight,
  balanceCents,
  type Computer,
  cleanupSelection,
  createApi,
  guard,
  inventory,
  type JsonObject,
  type LedgerRow,
  medium,
  object,
  type Preflight,
  parseOffers,
  prefix,
  probeLimits,
  type Reply,
  redact,
  requireOk,
  shortId,
  small,
  smallLimits,
  stats,
} from "./core.ts";
import { fakeOrgo, type Scenario } from "./fake.ts";
import { isId, readRecovery, recoveryFile, writeRecovery } from "./recovery.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(here, "../../docs/research/experiments/orgo-arm-001");
const stateScript = join(here, "state.py");

export type Metric = ReturnType<typeof stats>;
export type Rejected = { status: number | null; code: string | null; body: string };
export type Experiment = {
  planned: number;
  n: number;
  rejected: Rejected[];
  metrics: Record<string, Metric>;
  observations: JsonObject[];
  notes: string[];
};
export type Raw = {
  mode: "live" | "dry-run";
  generated: string;
  preflight: Preflight;
  experiments: Record<string, Experiment>;
  spend: { startCents: number | null; endCents: number | null; ledgerCents: number | null };
  cleanup: { deleted: string[]; finalCount: number | null; errors?: string[] };
  history: unknown[] | null;
  errors: string[];
};

export type Context = {
  api: Api;
  key: string;
  ledgerPath: string;
  watchPath: string;
  workspaceId: string;
  startCents: number;
  lastCents: number;
  sleep: (ms: number) => Promise<void>;
  remember: (id: string) => Promise<void>;
  created: Set<string>;
  /** Computer ids present at preflight; anything else present later is ours to delete. */
  baseline: Set<string>;
  /** `performance.now()` value after which no further polling or allocation happens. */
  deadlineAt: number;
  probe: boolean;
  lowestCents: number;
};

export const runBoundMs = 20 * 60_000;
export const cleanupBoundMs = 60_000;
const cleanupAttempts = 4;
const billingBlock =
  "Free probe refused before allocation: no verified provider ceiling or worst-case charge bound covers the 25c cap";

export class DeadlineError extends Error {
  constructor() {
    super("20 minute run bound reached");
  }
}

export function loadKey(path = join(homedir(), ".myco/secrets/orgo.env")): Promise<string> {
  return readFile(path, "utf8").then((text) => {
    const match = /^ORGO_API_KEY=(.*)$/m.exec(text);
    const key = match?.[1]?.trim().replace(/^["']|["']$/g, "");
    if (!key) throw new Error("ORGO_API_KEY missing from the secrets file");
    return key;
  });
}

function emptyExperiment(planned: number): Experiment {
  return { planned, n: 0, rejected: [], metrics: {}, observations: [], notes: [] };
}

async function ledger(ctx: Context, row: Partial<LedgerRow> & { operation: string }) {
  const full: LedgerRow = {
    timestamp: new Date().toISOString(),
    computer: null,
    status: null,
    code: null,
    latencyMs: null,
    beforeCents: null,
    immediateCents: null,
    delayedCents: null,
    spendCents: null,
    ...row,
  };
  await appendLedger(ctx.ledgerPath, full, ctx.key);
}

async function credit(ctx: Pick<Context, "api">): Promise<number> {
  return balanceCents(await ctx.api("GET", "/api/credits"));
}

/** Run one state-changing call and record its status, latency and balance before/after (immediate and delayed). */
async function billable(
  ctx: Context,
  operation: string,
  computer: string | null,
  call: () => Promise<Reply>,
): Promise<
  Reply & { beforeCents: number; immediateCents: number | null; delayedCents: number | null }
> {
  const beforeCents = ctx.lastCents;
  const reply = await call();
  const immediateCents = await credit(ctx).catch(() => null);
  if (performance.now() < ctx.deadlineAt) await ctx.sleep(3_000);
  const delayedCents = await credit(ctx).catch(() => null);
  const observed = delayedCents ?? immediateCents;
  if (observed !== null) ctx.lastCents = observed;
  ctx.lowestCents = Math.min(ctx.lowestCents, immediateCents ?? Infinity, delayedCents ?? Infinity);
  await ledger(ctx, {
    operation,
    computer: computer ? shortId(computer) : null,
    status: reply.status,
    code: reply.code ?? null,
    latencyMs: Math.round(reply.ms),
    body: reply.status >= 400 ? reply.body : undefined,
    beforeCents,
    immediateCents,
    delayedCents,
    spendCents: ctx.startCents - ctx.lastCents,
  });
  checkDeadline(ctx);
  return { ...reply, beforeCents, immediateCents, delayedCents };
}

async function _readOnly(ctx: Context, operation: string, path: string): Promise<Reply> {
  const reply = await ctx.api("GET", path);
  await ledger(ctx, {
    operation,
    status: reply.status,
    code: reply.code ?? null,
    latencyMs: Math.round(reply.ms),
  });
  return reply;
}

async function liveInventory(ctx: Pick<Context, "api" | "workspaceId">): Promise<Computer[]> {
  const data = requireOk(await ctx.api("GET", `/api/workspaces/${ctx.workspaceId}`), "Inventory");
  if (
    !Array.isArray(data.desktops) ||
    data.desktops.some((row) => typeof object(row).id !== "string")
  ) {
    throw new Error("Inventory is missing or invalid");
  }
  return inventory(data);
}

const limitsFor = (ctx: Pick<Context, "probe">) => (ctx.probe ? probeLimits : smallLimits);
const checkDeadline = (ctx: Pick<Context, "deadlineAt">) => {
  if (performance.now() >= ctx.deadlineAt) throw new DeadlineError();
};

/** Refresh credit and inventory before a potentially billable transition. */
export async function allow(
  ctx: Pick<
    Context,
    "api" | "workspaceId" | "probe" | "startCents" | "lastCents" | "lowestCents" | "deadlineAt"
  >,
  additional: number,
  gateObservation = false,
) {
  checkDeadline(ctx);
  const balance = await credit(ctx);
  ctx.lastCents = balance;
  ctx.lowestCents = Math.min(ctx.lowestCents, balance);
  const live = await liveInventory(ctx);
  guard(ctx.startCents, ctx.lowestCents, live.length, additional, limitsFor(ctx), gateObservation);
  checkDeadline(ctx);
}

const succeeded = (reply: Reply) => reply.status >= 200 && reply.status < 300;
const deletedOrAbsent = (reply: Reply) => succeeded(reply) || reply.status === 404;

function boundedApi(api: Api, deadlineAt: number, cleanup = false): Api {
  const deadlineError = () =>
    cleanup ? new Error("60 second cleanup bound reached") : new DeadlineError();
  return async (method, path, payload, pollSignal) => {
    const remaining = deadlineAt - performance.now();
    if (remaining <= 0) throw deadlineError();
    const timeout = AbortSignal.timeout(Math.ceil(Math.min(remaining, cleanup ? 5_000 : 75_000)));
    const signal = pollSignal ? AbortSignal.any([timeout, pollSignal]) : timeout;
    try {
      return await api(method, path, payload, signal);
    } catch (error) {
      if (performance.now() >= deadlineAt) throw deadlineError();
      throw error;
    }
  };
}

async function rememberComputer(ctx: Context, id: unknown) {
  if (!isId(id) || ctx.baseline.has(id))
    throw new Error("Allocation response has no valid new computer id");
  ctx.created.add(id);
  await ctx.remember(id);
}

async function copyComputer(
  ctx: Context,
  source: string,
  action: "fork" | "clone",
  payload: JsonObject,
) {
  const reply = await ctx.api("POST", `/api/computers/${source}/${action}`, payload);
  if (!succeeded(reply)) return reply;
  const id = reply.data.id;
  if (typeof id !== "string" || id === source)
    throw new Error("Copy response has no new computer id");
  await rememberComputer(ctx, id);
  if (ctx.probe) {
    const deleted = await ctx.api("DELETE", `/api/computers/${id}`).catch(() => null);
    if (deleted && deletedOrAbsent(deleted)) ctx.created.delete(id);
    await ledger(ctx, {
      operation: `delete unexpected probe ${action}`,
      computer: shortId(id),
      status: deleted?.status ?? null,
      code: deleted?.code ?? null,
      body: deleted?.body,
    });
  }
  return reply;
}

function checkProbeCopy(ctx: Context, experiment: Experiment, reply: Reply, action: string) {
  if (ctx.probe && succeeded(reply)) {
    experiment.observations.push({ unexpectedSuccess: action, status: reply.status });
    throw new Error(`Unexpected probe ${action} success; ending the run`);
  }
}

/** Read-only eligibility check; no compute is created. Resolves the workspace and start balance. */
export async function preflight(api: Api, ledgerPath: string, key: string, workspace?: string) {
  const ctx = { api, ledgerPath, key } as Pick<Context, "api" | "ledgerPath" | "key">;
  const note = async (operation: string, reply: Reply) =>
    appendLedger(
      ledgerPath,
      {
        operation,
        timestamp: new Date().toISOString(),
        computer: null,
        status: reply.status,
        code: reply.code ?? null,
        latencyMs: Math.round(reply.ms),
        beforeCents: null,
        immediateCents: null,
        delayedCents: null,
        spendCents: null,
      },
      key,
    );
  const credits = await ctx.api("GET", "/api/credits");
  await note("preflight credits", credits);
  const balance =
    credits.status === 200 && typeof credits.data.balanceCents === "number"
      ? credits.data.balanceCents
      : null;
  const workspaces = await ctx.api("GET", "/api/workspaces");
  await note("preflight workspaces", workspaces);
  const owned = (Array.isArray(workspaces.data.workspaces) ? workspaces.data.workspaces : [])
    .map(object)
    .filter((row) => row.role === "owner" && typeof row.id === "string");
  const chosen = workspace
    ? owned.find((row) => row.id === workspace)
    : owned.length === 1
      ? owned[0]
      : undefined;
  if (!chosen)
    throw new Error(
      "Cannot pick one owned workspace; pass --workspace <id> (the one `orgo whoami` reports)",
    );
  const workspaceId = String(chosen.id);
  const compute = await ctx.api("GET", `/api/billing/compute?workspace_id=${workspaceId}`);
  await note("preflight compute offers", compute);
  const detail = await ctx.api("GET", `/api/workspaces/${workspaceId}`);
  await note("preflight inventory", detail);
  const offers = compute.status === 200 ? parseOffers(compute.data) : [];
  const tier = typeof credits.data.tier === "string" ? credits.data.tier : "unknown";
  const mode = typeof compute.data.mode === "string" ? compute.data.mode : "unknown";
  const free = tier.toLowerCase() === "free" || mode.toLowerCase() === "free";
  const result = assessPreflight({
    tier,
    mode,
    balanceCents: balance,
    offers:
      free && Array.isArray(compute.data.entries) && compute.data.entries.length !== offers.length
        ? []
        : offers,
    inventoryCount:
      detail.status === 200 &&
      Array.isArray(detail.data.desktops) &&
      detail.data.desktops.every((row) => typeof object(row).id === "string")
        ? inventory(detail.data).length
        : null,
  });
  const baseline = detail.status === 200 ? inventory(detail.data).map(({ id }) => id) : [];
  return { workspaceId, result, baseline };
}

const guest = {
  install: async () => {
    const source = await readFile(stateScript);
    return `echo ${source.toString("base64")} | base64 -d > /root/myco-state.py`;
  },
  plant:
    "echo disk-marker > /root/.myco-discovery-disk; MYCO_STATE_MARKER=discovery setsid nohup python3 /root/myco-state.py plant > /dev/shm/myco-plant.log 2>&1 < /dev/null & sleep 1; " +
    "(command -v xterm >/dev/null && DISPLAY=:99 setsid nohup xterm -geometry 90x12 -e 'tail -f /dev/shm/myco-plant.log' >/dev/null 2>&1 < /dev/null &); echo planted",
  read: "python3 /root/myco-state.py read",
  now: "date +%s%3N",
  gap: (from: string, to: string) => `python3 /root/myco-state.py gap ${from} ${to}`,
  diverge: (value: string) =>
    `echo ${value} > /root/.myco-diverge; echo ${value} > /dev/shm/myco-diverge; cat /root/.myco-diverge /dev/shm/myco-diverge | tr '\\n' ' '`,
};

async function bash(
  ctx: Context,
  id: string,
  command: string,
  timeout = 60,
  signal?: AbortSignal,
): Promise<Reply> {
  checkDeadline(ctx);
  const remainingSeconds = Math.ceil((ctx.deadlineAt - performance.now()) / 1_000);
  return ctx.api(
    "POST",
    `/api/computers/${id}/bash`,
    { command, timeout: Math.min(timeout, remainingSeconds) },
    signal,
  );
}

function text(reply: Reply): string {
  return typeof reply.data.output === "string" ? reply.data.output.trim() : "";
}

/** Poll until ready or `limitMs`; throws DeadlineError once the run bound is reached. */
export async function until(
  ctx: Pick<Context, "sleep" | "deadlineAt">,
  _id: string,
  ready: (reply: Reply) => boolean,
  limitMs: number,
  poll: (signal: AbortSignal) => Promise<Reply>,
): Promise<{ ms: number; reply: Reply | null }> {
  const started = performance.now();
  checkDeadline(ctx);
  const pollDeadline = Math.min(started + limitMs, ctx.deadlineAt);
  const signal = AbortSignal.timeout(Math.max(0, Math.ceil(pollDeadline - performance.now())));
  while (performance.now() < pollDeadline) {
    const reply = await poll(signal).catch(() => null);
    checkDeadline(ctx);
    if (performance.now() >= pollDeadline) break;
    if (reply && ready(reply)) return { ms: performance.now() - started, reply };
    await ctx.sleep(Math.min(1_000, Math.max(0, pollDeadline - performance.now())));
  }
  checkDeadline(ctx);
  return { ms: performance.now() - started, reply: null };
}

const status = (value: string) => (reply: Reply) =>
  reply.status === 200 && reply.data.status === value;
const getComputer = (ctx: Context, id: string) => (signal?: AbortSignal) =>
  ctx.api("GET", `/api/computers/${id}`, undefined, signal);
const firstBash = (ctx: Context, id: string, limitMs = 120_000) =>
  until(
    ctx,
    id,
    (reply) => reply.status === 200 && reply.data.exit_code === 0,
    limitMs,
    (signal) => bash(ctx, id, "true", 20, signal),
  );

function parseJson(reply: Reply): JsonObject {
  try {
    return object(JSON.parse(text(reply)));
  } catch {
    return {};
  }
}

function pushRejected(experiment: Experiment, reply: Reply) {
  experiment.rejected.push({
    status: reply.status,
    code: reply.code ?? null,
    body: reply.body.slice(0, 600),
  });
}

async function plant(ctx: Context, id: string) {
  await allow(ctx, 0);
  const installed = await bash(ctx, id, await guest.install());
  await allow(ctx, 0);
  const planted = await bash(ctx, id, guest.plant);
  await ctx.sleep(2_000);
  const probe = parseJson(await bash(ctx, id, guest.read));
  return { installed: installed.status, planted: text(planted), probe };
}

function affordable(ctx: Context): boolean {
  return ctx.startCents - ctx.lowestCents < limitsFor(ctx).stopCents;
}

/** E0 to E5 against the live service. Only called after a passing preflight; cleanup runs in `finally`. */
export async function runExperiments(ctx: Context, raw: Raw): Promise<void> {
  const exp = (name: string, planned: number) => {
    raw.experiments[name] = emptyExperiment(planned);
    return raw.experiments[name] as Experiment;
  };
  const e0 = exp("E0", 1);
  await allow(ctx, 1);
  const name = `${prefix}base`;
  const started = performance.now();
  const size = ctx.probe ? medium : small;
  const created = await billable(ctx, "E0 create linux", null, async () => {
    const reply = await ctx.api("POST", "/api/computers", {
      workspace_id: ctx.workspaceId,
      name,
      billing_mode: "hourly",
      os: size.os,
      ram: size.ram,
      cpu: size.cpu,
      ends_in_hours: 1,
    });
    if (succeeded(reply)) await rememberComputer(ctx, reply.data.id);
    return reply;
  });
  if (created.status < 200 || created.status >= 300) {
    pushRejected(e0, created);
    return;
  }
  const source = created.data.id;
  if (typeof source !== "string") throw new Error("Create response has no computer id");
  const readSize = (data: JsonObject) => ({
    cpu: data.cpu ?? null,
    ramGb: data.ram ?? data.ram_gb ?? null,
  });
  let obtained = readSize(created.data);
  let sizeSource: string | undefined;
  if (ctx.probe) {
    if (
      (obtained.cpu !== null && obtained.cpu !== size.cpu) ||
      (obtained.ramGb !== null && obtained.ramGb !== size.ram)
    )
      throw new Error("Create returned a size outside the Medium probe");
    if (obtained.cpu === null || obtained.ramGb === null) {
      const detail = requireOk(await getComputer(ctx, source)(), "Medium detail");
      if (detail.id !== undefined && detail.id !== source)
        throw new Error("Medium detail returned a different computer");
      obtained = readSize(detail);
      sizeSource = "computer detail";
    }
    if (obtained.cpu !== size.cpu || obtained.ramGb !== size.ram)
      throw new Error("Could not confirm Medium (2 vCPU, 8 GB)");
    await allow(ctx, 0);
  }
  e0.observations.push({ sizeObtained: obtained, ...(sizeSource ? { sizeSource } : {}) });
  await mkdir(dirname(ctx.watchPath), { recursive: true });
  await writeFile(
    ctx.watchPath,
    `https://www.orgo.ai/computers/${source.replaceAll(ctx.key, "[redacted]")}\n`,
    { mode: 0o600 },
  );
  const running = await until(ctx, source, status("running"), 180_000, getComputer(ctx, source));
  const ready = await firstBash(ctx, source);
  e0.n = 1;
  e0.metrics = {
    createToRunningMs: stats([running.ms + created.ms]),
    createToFirstBashMs: stats([performance.now() - started]),
  };
  e0.observations.push({
    createStatus: created.status,
    runningObserved: running.reply !== null,
    firstBashObserved: ready.reply !== null,
    balanceDeltaCents: created.beforeCents - ctx.lastCents,
  });

  const e1 = exp("E1", 1);
  const planted = await plant(ctx, source);
  e1.n = planted.installed === 200 ? 1 : 0;
  e1.observations.push({
    installStatus: planted.installed,
    planted: planted.planted,
    probe: planted.probe,
  });
  const sourceProbe = planted.probe;

  const repetitions = ctx.probe ? 1 : 5;
  const e2 = exp("E2", repetitions);
  const apiMs: number[] = [];
  const bashMs: number[] = [];
  const pauseMs: number[] = [];
  for (let i = 0; i < repetitions && (i === 0 || affordable(ctx)); i += 1) {
    const from = ctx.probe ? "" : text(await bash(ctx, source, guest.now));
    await allow(ctx, 1, ctx.probe);
    const t0 = performance.now();
    const forked = await billable(ctx, `E2 fork ${i + 1}`, source, () =>
      copyComputer(ctx, source, "fork", {}),
    );
    checkProbeCopy(ctx, e2, forked, "fork");
    if (!succeeded(forked)) {
      pushRejected(e2, forked);
      e2.notes.push(
        "A gate ends repetitions of this operation. The fork docs list no quote or confirm parameter, so no follow-up was attempted.",
      );
      break;
    }
    const id = String(forked.data.id);
    const reachable = await firstBash(ctx, id);
    const to = text(await bash(ctx, source, guest.now));
    const gap = parseJson(await bash(ctx, source, guest.gap(from, to)));
    const probe = parseJson(await bash(ctx, id, guest.read));
    const detail = await ctx.api("GET", `/api/computers/${id}`);
    const sourceWrite = text(await bash(ctx, source, guest.diverge("source")));
    const forkWrite = text(await bash(ctx, id, guest.diverge("fork")));
    const sourceAgain = text(await bash(ctx, source, "cat /root/.myco-diverge"));
    apiMs.push(forked.ms);
    bashMs.push(reachable.reply ? performance.now() - t0 : Number.NaN);
    if (typeof gap.maxGapMs === "number") pauseMs.push(gap.maxGapMs);
    e2.n += 1;
    e2.observations.push({
      attempt: i + 1,
      newUuid: id !== source,
      status: forked.data.status,
      autoStopFields: Object.fromEntries(
        Object.entries(detail.data).filter(([key]) => /auto|stop|sleep|idle/i.test(key)),
      ),
      gap,
      probe,
      sourceBefore: sourceProbe,
      divergence: { sourceWrite, forkWrite, sourceAfterForkWrite: sourceAgain },
      balanceDeltaCents: forked.beforeCents - ctx.lastCents,
    });
    const deleted = await billable(ctx, `E2 delete fork ${i + 1}`, id, () =>
      ctx.api("DELETE", `/api/computers/${id}`),
    );
    if (deletedOrAbsent(deleted)) ctx.created.delete(id);
  }
  e2.metrics = {
    apiMs: stats(apiMs),
    firstBashMs: stats(bashMs.filter(Number.isFinite)),
    sourcePauseMaxGapMs: stats(pauseMs),
  };

  const e3 = exp("E3", repetitions);
  const cloneApi: number[] = [];
  const cloneBash: number[] = [];
  for (let i = 0; i < repetitions && (i === 0 || affordable(ctx)); i += 1) {
    await allow(ctx, 1, ctx.probe);
    const t0 = performance.now();
    const cloned = await billable(ctx, `E3 clone ${i + 1}`, source, () =>
      copyComputer(ctx, source, "clone", { name: `${prefix}clone-${i + 1}` }),
    );
    checkProbeCopy(ctx, e3, cloned, "clone");
    if (!succeeded(cloned)) {
      pushRejected(e3, cloned);
      break;
    }
    const id = String(cloned.data.id);
    const reachable = await firstBash(ctx, id);
    const probe = parseJson(await bash(ctx, id, guest.read));
    cloneApi.push(cloned.ms);
    cloneBash.push(reachable.reply ? performance.now() - t0 : Number.NaN);
    e3.n += 1;
    e3.observations.push({
      attempt: i + 1,
      probe,
      bootChanged: probe.boot !== sourceProbe.boot,
      balanceDeltaCents: cloned.beforeCents - ctx.lastCents,
    });
    const deleted = await billable(ctx, `E3 delete clone ${i + 1}`, id, () =>
      ctx.api("DELETE", `/api/computers/${id}`),
    );
    if (deletedOrAbsent(deleted)) ctx.created.delete(id);
  }
  e3.metrics = { apiMs: stats(cloneApi), firstBashMs: stats(cloneBash.filter(Number.isFinite)) };

  const e4 = exp("E4", 1);
  await allow(ctx, 0);
  const stopped = await billable(ctx, "E4 stop", source, () =>
    ctx.api("POST", `/api/computers/${source}/stop`, {}),
  );
  const frozen = await until(ctx, source, status("frozen"), 120_000, getComputer(ctx, source));
  if (!succeeded(stopped) || !frozen.reply) throw new Error("E4 source did not stop");
  await allow(ctx, 0);
  const asleep = await bash(ctx, source, "true", 20);
  await allow(ctx, 0);
  const resumedFromStop = await billable(ctx, "E4 start", source, () =>
    ctx.api("POST", `/api/computers/${source}/start`, {}),
  );
  const startT0 = performance.now();
  const backRunning = await until(
    ctx,
    source,
    status("running"),
    180_000,
    getComputer(ctx, source),
  );
  if (!succeeded(resumedFromStop) || !backRunning.reply) throw new Error("E4 source did not start");
  const backBash = await firstBash(ctx, source);
  const afterStart = parseJson(await bash(ctx, source, guest.read));
  e4.n = stopped.status < 300 && resumedFromStop.status < 300 ? 1 : 0;
  e4.metrics = {
    stopToFrozenMs: stats(frozen.reply ? [stopped.ms + frozen.ms] : []),
    startToRunningMs: stats(backRunning.reply ? [resumedFromStop.ms + backRunning.ms] : []),
    startToFirstBashMs: stats(
      backBash.reply ? [performance.now() - startT0 + resumedFromStop.ms] : [],
    ),
  };
  e4.observations.push({
    stopStatus: stopped.status,
    startStatus: resumedFromStop.status,
    bashWhileStopped: {
      status: asleep.status,
      code: asleep.code ?? null,
      body: asleep.body.slice(0, 300),
    },
    afterStart,
    bootChanged: afterStart.boot !== sourceProbe.boot,
  });
  const replanted = await plant(ctx, source);
  e4.observations.push({ replanted: replanted.probe });
  await allow(ctx, 0);
  const suspended = await billable(ctx, "E4 suspend", source, () =>
    ctx.api("POST", `/api/computers/${source}/suspend`, {}),
  );
  e4.observations.push({
    suspend: {
      status: suspended.status,
      code: suspended.code ?? null,
      body: suspended.body.slice(0, 400),
    },
  });
  if (suspended.status >= 200 && suspended.status < 300) {
    await allow(ctx, 0);
    const resumed = await billable(ctx, "E4 resume", source, () =>
      ctx.api("POST", `/api/computers/${source}/resume`, {}),
    );
    await until(ctx, source, status("running"), 180_000, getComputer(ctx, source));
    await firstBash(ctx, source);
    e4.observations.push({
      resumeStatus: resumed.status,
      afterResume: parseJson(await bash(ctx, source, guest.read)),
    });
  }

  const e5 = exp("E5", 1);
  const current = await ctx.api("GET", `/api/computers/${source}`);
  if (current.data.status === "running") {
    await allow(ctx, 0);
    const stoppedForE5 = await billable(ctx, "E5 stop", source, () =>
      ctx.api("POST", `/api/computers/${source}/stop`, {}),
    );
    const frozenForE5 = await until(
      ctx,
      source,
      status("frozen"),
      120_000,
      getComputer(ctx, source),
    );
    if (!succeeded(stoppedForE5) || !frozenForE5.reply) throw new Error("E5 source did not stop");
  } else if (!status("frozen")(current)) {
    throw new Error("E5 source is not frozen");
  }
  await allow(ctx, 1, ctx.probe);
  const stoppedFork = await billable(ctx, "E5 fork stopped source", source, () =>
    copyComputer(ctx, source, "fork", {}),
  );
  e5.n = 1;
  e5.observations.push({
    status: stoppedFork.status,
    code: stoppedFork.code ?? null,
    body: stoppedFork.body,
  });
  checkProbeCopy(ctx, e5, stoppedFork, "stopped fork");
  await allow(ctx, 1, ctx.probe);
  const stoppedClone = await billable(ctx, "E5 clone stopped source", source, () =>
    copyComputer(ctx, source, "clone", { name: `${prefix}clone-stopped` }),
  );
  e5.observations.push({
    cloneStatus: stoppedClone.status,
    cloneCode: stoppedClone.code ?? null,
    body: stoppedClone.body,
  });
  checkProbeCopy(ctx, e5, stoppedClone, "stopped clone");
}

/**
 * Delete every computer this run created plus every computer absent at preflight (regardless of
 * name, since Orgo auto-names forks); then re-list. Safe to repeat in an exclusive workspace.
 */
export async function cleanup(ctx: Context): Promise<Raw["cleanup"]> {
  const deleted: string[] = [];
  const errors: string[] = [];
  const record = (error: unknown) => {
    errors.push(redact(error instanceof Error ? error.message : "Cleanup failed", ctx.key));
    return null;
  };
  const discoveries = (current: Computer[] | null) =>
    cleanupSelection(current ?? [], { baseline: ctx.baseline }).filter(
      ({ id }) => !ctx.baseline.has(id),
    );
  let remaining = await liveInventory(ctx).catch(record);
  for (
    let attempt = 0;
    attempt < cleanupAttempts && performance.now() < ctx.deadlineAt;
    attempt++
  ) {
    for (const { id } of discoveries(remaining)) {
      await rememberComputer(ctx, id).catch(record);
    }
    for (const id of ctx.created) {
      if (performance.now() >= ctx.deadlineAt) break;
      const reply = await ctx.api("DELETE", `/api/computers/${id}`).catch(record);
      if (reply && deletedOrAbsent(reply)) {
        ctx.created.delete(id);
        if (succeeded(reply)) deleted.push(shortId(id));
      } else if (reply) {
        errors.push(`Cleanup delete returned HTTP ${reply.status} ${reply.body}`);
      }
      await ledger(ctx, {
        operation: "cleanup delete",
        computer: shortId(id),
        status: reply?.status ?? null,
        code: reply?.code ?? null,
      }).catch(record);
    }
    await ctx.sleep(1_000);
    remaining = await liveInventory(ctx).catch(record);
  }
  // Retain IDs from the last observation for recovery even when the retry budget is exhausted.
  for (const { id } of discoveries(remaining)) {
    await rememberComputer(ctx, id).catch(record);
  }
  if (remaining === null || remaining.length || ctx.created.size) {
    errors.push(
      "Cleanup could not verify an empty workspace; run cleanup again with the original --out directory",
    );
  }
  await ledger(ctx, {
    operation: `cleanup final list (${remaining?.length ?? "unknown"} computers)`,
  }).catch(record);
  return { deleted, finalCount: remaining?.length ?? null, ...(errors.length ? { errors } : {}) };
}

export async function renderResults(raw: Raw): Promise<string> {
  const fmt = (value: number | null) => (value === null ? "-" : Math.round(value).toString());
  const row = (label: string, m: Metric) =>
    `| ${label} | ${m.n} | ${fmt(m.min)} | ${fmt(m.median)} | ${fmt(m.p95)} | ${fmt(m.max)} |`;
  const lines: string[] = [
    "# Orgo arm 001 results",
    "",
    "> **NOT CLEARED FOR LIVE USE.** The runner has not been approved for a live compute pass. Live experiments require `ORGO_LIVE_APPROVED=yes`. A Free probe also requires `ORGO_PROBE_APPROVED=yes`. The committed evidence is from the read-only preflight.",
    "",
  ];
  lines.push(
    `Generated ${raw.generated} (${raw.mode}). Authoritative tables below; raw data in \`raw.json\`, per-operation ledger in \`ledger.jsonl\`.`,
    "",
  );
  const p = raw.preflight;
  lines.push(
    "## Preflight (read-only, before any compute call)",
    "",
    "| Field | Value |",
    "| --- | --- |",
  );
  lines.push(
    `| Plan tier | ${p.tier} |`,
    `| Compute mode | ${p.mode} |`,
    `| Credit balance | ${p.balanceCents === null ? "unknown" : `$${(p.balanceCents / 100).toFixed(2)}`} |`,
    `| Computers in workspace | ${p.inventoryCount ?? "unknown"} |`,
  );
  lines.push(
    `| Offers | ${p.offers.map((o) => `${o.name} (${o.cpu} vCPU, ${o.ramGb} GB, ${o.diskGb} GB disk, $${o.usdPerHour}/h)`).join("; ") || "none"} |`,
  );
  const sizeObservation = raw.experiments.E0?.observations.find((o) => o.sizeObtained);
  const obtained = object(sizeObservation?.sizeObtained);
  lines.push(
    `| Eligibility check | ${p.profile === "probe" ? "Free Medium probe" : "Small protocol"}: ${p.ok ? "passed" : "gated"} |`,
    `| Size obtained | ${Object.keys(obtained).length ? `${obtained.cpu ?? "unknown"} vCPU, ${obtained.ramGb ?? "unknown"} GB (${sizeObservation?.sizeSource ?? "create response"})` : "No computer created"} |`,
    "",
    "p95 is omitted for N=1.",
    "",
  );
  if (!p.ok) {
    lines.push(
      "**Gate: precondition failed. No compute call was made, so E0-E5 have zero samples.**",
      "",
    );
    for (const reason of p.reasons) lines.push(`- ${redact(reason, "")}`);
    lines.push("");
  }
  for (const [name, experiment] of Object.entries(raw.experiments)) {
    lines.push(
      `## ${name}`,
      "",
      `Planned N ${experiment.planned}; completed ${experiment.n}; rejected ${experiment.rejected.length}.`,
      "",
    );
    if (Object.keys(experiment.metrics).length) {
      lines.push(
        "| Metric (ms) | N | min | median | p95 (nearest rank) | max |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
      );
      for (const [label, metric] of Object.entries(experiment.metrics))
        lines.push(row(label, metric));
      lines.push("");
    }
    for (const rejected of experiment.rejected)
      lines.push(`- Rejected: HTTP ${rejected.status} \`${rejected.code}\` ${rejected.body}`);
    for (const note of experiment.notes) lines.push(`- ${note}`);
    if (experiment.observations.length)
      lines.push("", "```json", JSON.stringify(experiment.observations, null, 2), "```");
    lines.push("");
  }
  if (p.ok === false && Object.keys(raw.experiments).length === 0) {
    for (const name of [
      "E0 create",
      "E1 plant",
      "E2 fork",
      "E3 clone",
      "E4 stop/start/suspend",
      "E5 stopped fork",
    ]) {
      lines.push(
        `- ${name}: not run (precondition gate; documented semantics only, see PROTOCOL.md)`,
      );
    }
    lines.push("");
  }
  if (!p.ok) {
    lines.push(
      "## Documented, not tested (docs.orgo.ai; static text, no live outcome)",
      "",
      "| Operation | Documented behaviour | Live result |",
      "| --- | --- | --- |",
      "| Free-account create | Free runs hourly Medium only, a create naming another size still gets a Medium (create, account-limits, instance-types) | Offer list above agrees: Medium only |",
      "| Free-account computer count | One computer on starting credit alone, 403 HOURLY_LIMIT beyond it; the count is checked on create, clone and fork | not tested: a fork or clone would need a second computer |",
      "| Fork | Running Linux source, live memory copied, source pauses about 2 s, new UUID and instance_id, auto-stop forced always-on; 409 HOURLY_QUOTE_REQUIRED when the source is hourly ('a copy needs its own purchase'); the fork page lists no quote or confirm parameter | not tested |",
      "| Clone | Disk only, starts from a fresh boot; 400 NOT_CLONABLE for a stopped (frozen) source; 409 HOURLY_QUOTE_REQUIRED for an hourly source | not tested |",
      "| Suspend / resume | Plan-only memory save; an hourly computer answers 409 HOURLY_USE_STOP | not tested |",
      "| Stop / start | Disk archived, RAM and processes lost; stopped hourly computers bill disk only | not tested |",
      "| Fork of a stopped source | 409 computer_asleep or 409 NOT_FORKABLE (400 NOT_FORKABLE if never provisioned; Windows and older VM types are 409 NOT_FORKABLE) | not tested; Windows is documented only |",
      "",
      "Account note: the billing history shows a $3.00 initial grant for the free tier, not the $5 that the account-limits page documents for a person. No credit was added and no plan was bought.",
      "",
    );
  }
  const s = raw.spend;
  const dollars = (cents: number | null) =>
    cents === null ? "unknown" : `$${(cents / 100).toFixed(2)}`;
  lines.push("## E6 spend and reconciliation", "", "| Item | Value |", "| --- | --- |");
  lines.push(
    `| Start balance | ${dollars(s.startCents)} |`,
    `| End balance | ${dollars(s.endCents)} |`,
    `| Ledger spend | ${dollars(s.ledgerCents)} |`,
  );
  lines.push(
    `| Computers after cleanup | ${raw.cleanup.finalCount ?? "unknown"} (deleted this run: ${raw.cleanup.deleted.length}) |`,
    "",
  );
  if (raw.history)
    lines.push(
      "Billing history (amounts only):",
      "",
      "```json",
      JSON.stringify(raw.history, null, 2),
      "```",
      "",
    );
  for (const error of raw.errors) lines.push(`- Error: ${redact(error, "")}`);
  lines.push(
    "",
    "## Not measured",
    "",
    "- Plan-only features (plan-funded suspend/resume, plan-funded forks), other sizes, other operating systems (Windows is documented, not tested), scale, and any account that is not credit-only Free.",
  );
  lines.push(
    "- Orgo returns action delivery, not outcome proofs: this experiment makes no verification claim, and no attempt-to-verified result is measured.",
  );
  return `${lines.join("\n")}\n`;
}

type Args = {
  command: string;
  dryRun: boolean;
  out: string;
  workspace?: string;
  scenario: Scenario;
  charge?: number;
  deadlineMs?: number;
  failMidE2: boolean;
};

const commands = new Set(["run", "preflight", "cleanup", "render"]);
const scenarios = new Set<string>([
  "free",
  "free-quote",
  "free-fork-open",
  "free-clone-open",
  "paid-gated",
  "paid-open",
]);

/** Strict parser: unknown flags, missing values, unknown scenarios and unknown commands all throw. */
export function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "run",
    dryRun: false,
    out: defaultOut,
    scenario: "free",
    failMidE2: false,
  };
  const positional: string[] = [];
  let scenarioSpecified = false;
  const number = (name: string, value: string | undefined) => {
    const parsed = Number(value);
    if (value === undefined || value === "" || !Number.isFinite(parsed) || parsed < 0) {
      throw new Error(`${name} needs a non-negative number`);
    }
    return parsed;
  };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at] ?? "";
    const value = () => {
      const next = argv[at + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${arg} needs a value`);
      at += 1;
      return next;
    };
    switch (arg) {
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--fail-mid-e2":
        args.failMidE2 = true;
        break;
      case "--out":
        args.out = resolve(value());
        break;
      case "--workspace":
        args.workspace = value();
        break;
      case "--scenario": {
        const scenario = value();
        if (!scenarios.has(scenario)) throw new Error(`Unknown scenario: ${scenario}`);
        args.scenario = scenario as Scenario;
        scenarioSpecified = true;
        break;
      }
      case "--charge-cents":
        args.charge = number(arg, value());
        break;
      case "--deadline-ms":
        args.deadlineMs = number(arg, value());
        break;
      default:
        if (arg.startsWith("--")) throw new Error(`Unknown option: ${arg}`);
        positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error("Only one command is accepted");
  args.command = positional[0] ?? "run";
  if (!commands.has(args.command)) throw new Error(`Unknown command: ${args.command}`);
  if (
    !args.dryRun &&
    (scenarioSpecified ||
      args.charge !== undefined ||
      args.deadlineMs !== undefined ||
      args.failMidE2)
  ) {
    throw new Error(
      "--scenario, --charge-cents, --deadline-ms and --fail-mid-e2 require --dry-run",
    );
  }
  return args;
}

/**
 * Billing history over REST. `/api/credits/transactions` is what the Orgo CLI calls but it is not in
 * the public OpenAPI file, so this is best effort: any failure yields null. No package is fetched.
 */
export async function fetchHistory(api: Api): Promise<unknown[] | null> {
  try {
    const reply = await api("GET", "/api/credits/transactions");
    const rows = reply.status === 200 ? reply.data.transactions : null;
    return Array.isArray(rows)
      ? rows.map(object).map((row) => ({
          amount_cents: row.amount_cents,
          balance_after_cents: row.balance_after_cents,
          type: row.type,
          created_at: row.created_at,
        }))
      : null;
  } catch {
    return null;
  }
}

/** Live experiments need an explicit approval switch; the read-only preflight does not. */
export function liveApproved(env: Record<string, string | undefined>, probe = false): boolean {
  return env.ORGO_LIVE_APPROVED === "yes" && (!probe || env.ORGO_PROBE_APPROVED === "yes");
}

export async function main(
  argv: string[],
  dependencies: {
    env?: Record<string, string | undefined>;
    loadKey?: () => Promise<string>;
    fetch?: typeof fetch;
    fake?: typeof fakeOrgo;
    cleanupDeadlineMs?: number;
  } = {},
): Promise<Raw> {
  const args = parseArgs(argv);
  if (args.command === "render") {
    // Re-render RESULTS.md from the committed raw.json: no key, no network.
    const stored = JSON.parse(await readFile(join(args.out, "raw.json"), "utf8")) as Raw;
    await writeFile(join(args.out, "RESULTS.md"), await renderResults(stored));
    return stored;
  }
  const dryRun = args.dryRun;
  const out =
    dryRun && args.out === defaultOut ? await mkdtemp(join(tmpdir(), "orgo-dry-")) : args.out;
  await mkdir(out, { recursive: true });
  const recoveryPath = join(out, recoveryFile);
  const recovery = args.command === "cleanup" ? await readRecovery(recoveryPath) : null;
  if (
    recovery &&
    (recovery.dryRun !== dryRun || (args.workspace && args.workspace !== recovery.workspaceId))
  ) {
    throw new Error("Recovery journal does not match the requested mode or workspace");
  }
  const fake = dryRun
    ? (dependencies.fake ?? fakeOrgo)({
        scenario: args.scenario,
        chargeCents: args.charge,
        failOnForkBash: args.failMidE2,
      })
    : null;
  const key = dryRun ? "sk_dry_run_placeholder" : await (dependencies.loadKey ?? loadKey)();
  const api = createApi(key, fake?.request ?? dependencies.fetch ?? fetch);
  const ledgerPath = join(out, "ledger.jsonl");
  const log = (message: string) => process.stderr.write(`${redact(message, key)}\n`);
  const cleanupMs = dryRun ? (dependencies.cleanupDeadlineMs ?? cleanupBoundMs) : cleanupBoundMs;
  const preflightDeadline = performance.now() + (recovery ? cleanupMs : runBoundMs);
  const preflightApi = boundedApi(api, preflightDeadline);
  const { workspaceId, result, baseline } = recovery
    ? {
        workspaceId: recovery.workspaceId,
        baseline: recovery.baseline,
        result: {
          ok: false,
          reasons: [],
          tier: "unknown",
          mode: "unknown",
          balanceCents: null,
          inventoryCount: null,
          offers: [],
        } as Preflight,
      }
    : await preflight(preflightApi, ledgerPath, key, args.workspace);
  const startCents = result.balanceCents ?? 0;
  if (!isId(workspaceId) || !baseline.every(isId))
    throw new Error("Invalid workspace or inventory ID");
  const state = recovery ?? { version: 1 as const, workspaceId, dryRun, baseline, created: [] };
  const known = new Set(state.created);
  const deadlineAt =
    args.deadlineMs === undefined ? preflightDeadline : performance.now() + args.deadlineMs;
  const phase = (deadlineAt: number, cleanup = false) => ({
    deadlineAt,
    api: boundedApi(api, deadlineAt, cleanup),
    sleep: async (ms: number) => {
      const remaining = deadlineAt - performance.now();
      if (remaining > 0) await delay(Math.min(dryRun ? 1 : ms, remaining));
    },
  });
  const ctx: Context = {
    ...phase(deadlineAt),
    key,
    ledgerPath,
    watchPath: dryRun ? join(out, "watch.txt") : "/private/tmp/orgo-setup/watch.txt",
    workspaceId,
    startCents,
    lastCents: startCents,
    lowestCents: startCents,
    probe: result.profile === "probe",
    remember: async (id) => {
      if (known.has(id)) return;
      await writeRecovery(recoveryPath, { ...state, created: [...known, id] });
      known.add(id);
    },
    created: new Set(state.created),
    baseline: new Set(state.baseline),
  };
  let reconciliationApi = preflightApi;
  const clean = () => {
    const cleanupDeadline = recovery ? preflightDeadline : performance.now() + cleanupMs;
    const cleanupCtx = { ...ctx, ...phase(cleanupDeadline, true) };
    reconciliationApi = cleanupCtx.api;
    return cleanup(cleanupCtx);
  };
  const raw: Raw = {
    mode: dryRun ? "dry-run" : "live",
    generated: new Date().toISOString(),
    preflight: result,
    experiments: {},
    spend: { startCents: result.balanceCents, endCents: null, ledgerCents: null },
    cleanup: { deleted: [], finalCount: null },
    history: null,
    errors: [],
  };
  if (recovery) {
    raw.cleanup = await clean();
  } else if (args.command === "preflight" || !result.ok) {
    if (!result.ok)
      log(`Preflight gate: ${result.reasons.length} reason(s); no compute call made.`);
  } else if (!dryRun && !liveApproved(dependencies.env ?? process.env, ctx.probe)) {
    raw.errors.push(
      "Live run refused: NOT CLEARED FOR LIVE USE (set ORGO_LIVE_APPROVED to yes and, for the Free probe, set ORGO_PROBE_APPROVED to yes). Only the preflight ran.",
    );
  } else if (!dryRun && ctx.probe) {
    raw.errors.push(billingBlock);
  } else {
    try {
      await writeRecovery(recoveryPath, state, true);
    } catch {
      throw new Error(
        "Could not initialize recovery journal; use a fresh --out directory for each run",
      );
    }
    try {
      await runExperiments(ctx, raw);
    } catch (error) {
      raw.errors.push(redact(error instanceof Error ? error.message : "unknown error", key));
    } finally {
      raw.cleanup = await clean();
    }
  }
  raw.errors.push(...(raw.cleanup.errors ?? []));
  const end = await credit({ api: reconciliationApi }).catch(() => null);
  raw.spend.endCents = end;
  raw.spend.ledgerCents = end === null || raw.spend.startCents === null ? null : startCents - end;
  raw.history = await fetchHistory(reconciliationApi);
  const sanitized = JSON.parse(
    JSON.stringify(raw, (_, value: unknown) =>
      typeof value === "string" ? redact(value, key) : value,
    ),
  ) as Raw;
  if (!recovery) {
    await writeFile(join(out, "raw.json"), `${JSON.stringify(sanitized, null, 2)}\n`);
    await writeFile(join(out, "RESULTS.md"), await renderResults(sanitized));
  }
  return sanitized;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (raw) => {
      const phase =
        raw.spend.startCents === null && raw.cleanup.finalCount !== null
          ? "recovery sweep"
          : `preflight ${raw.preflight.ok ? "passed" : "gated"}`;
      process.stdout.write(
        `${raw.mode}: ${phase}; computers after cleanup ${raw.cleanup.finalCount ?? "n/a"}\n`,
      );
      if (raw.errors.length) {
        for (const error of raw.errors) process.stderr.write(`${error}\n`);
        process.exitCode = 1;
      }
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? redact(error.message, "") : "failed"}\n`);
      process.exitCode = 1;
    },
  );
}
