import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
  object,
  type Preflight,
  parseOffers,
  prefix,
  type Reply,
  redact,
  requireOk,
  shortId,
  small,
  stats,
} from "./core.ts";
import { fakeOrgo, type Scenario } from "./fake.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultOut = resolve(here, "../../docs/research/experiments/orgo-arm-001");
const run = promisify(execFile);
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
  cleanup: { deleted: string[]; finalCount: number | null };
  history: unknown[] | null;
  errors: string[];
};

export type Context = {
  api: Api;
  key: string;
  dir: string;
  ledgerPath: string;
  watchPath: string;
  workspaceId: string;
  startCents: number;
  lastCents: number;
  sleep: (ms: number) => Promise<void>;
  balanceWait: () => Promise<void>;
  history: () => Promise<unknown[] | null>;
  log: (message: string) => void;
  created: Set<string>;
};

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

async function credit(ctx: Context): Promise<number> {
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
  await ctx.balanceWait();
  const delayedCents = await credit(ctx).catch(() => null);
  const observed = delayedCents ?? immediateCents;
  if (observed !== null) ctx.lastCents = observed;
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

async function liveInventory(ctx: Context): Promise<Computer[]> {
  return inventory(
    requireOk(await ctx.api("GET", `/api/workspaces/${ctx.workspaceId}`), "Inventory"),
  );
}

/** Refresh balance and inventory, then enforce the spend and two-computer guard before an allocation. */
async function allow(ctx: Context, additional: number) {
  const balance = await credit(ctx);
  ctx.lastCents = balance;
  const live = await liveInventory(ctx);
  guard(ctx.startCents, balance, live.length, additional);
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
  const balance = typeof credits.data.balanceCents === "number" ? credits.data.balanceCents : null;
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
  const result = assessPreflight({
    tier: typeof credits.data.tier === "string" ? credits.data.tier : "unknown",
    mode: typeof compute.data.mode === "string" ? compute.data.mode : "unknown",
    balanceCents: balance,
    offers: parseOffers(compute.data),
    inventoryCount: detail.status === 200 ? inventory(detail.data).length : null,
  });
  return { workspaceId, result };
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

async function bash(ctx: Context, id: string, command: string, timeout = 60): Promise<Reply> {
  return ctx.api("POST", `/api/computers/${id}/bash`, { command, timeout });
}

function text(reply: Reply): string {
  return typeof reply.data.output === "string" ? reply.data.output.trim() : "";
}

async function until(
  ctx: Context,
  _id: string,
  ready: (reply: Reply) => boolean,
  limitMs: number,
  poll: () => Promise<Reply>,
): Promise<{ ms: number; reply: Reply | null }> {
  const started = performance.now();
  while (performance.now() - started < limitMs) {
    const reply = await poll().catch(() => null);
    if (reply && ready(reply)) return { ms: performance.now() - started, reply };
    await ctx.sleep(1_000);
  }
  return { ms: performance.now() - started, reply: null };
}

const status = (value: string) => (reply: Reply) =>
  reply.status === 200 && reply.data.status === value;
const getComputer = (ctx: Context, id: string) => () => ctx.api("GET", `/api/computers/${id}`);
const firstBash = (ctx: Context, id: string, limitMs = 120_000) =>
  until(
    ctx,
    id,
    (reply) => reply.status === 200 && reply.data.exit_code === 0,
    limitMs,
    () => bash(ctx, id, "true", 20),
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
  const installed = await bash(ctx, id, await guest.install());
  const planted = await bash(ctx, id, guest.plant);
  await ctx.sleep(2_000);
  const probe = parseJson(await bash(ctx, id, guest.read));
  return { installed: installed.status, planted: text(planted), probe };
}

function affordable(ctx: Context): boolean {
  return ctx.startCents - ctx.lastCents < 120;
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
  const created = await billable(ctx, "E0 create small linux", null, () =>
    ctx.api("POST", "/api/computers", {
      workspace_id: ctx.workspaceId,
      name,
      billing_mode: "hourly",
      os: small.os,
      ram: small.ram,
      cpu: small.cpu,
      ends_in_hours: 1,
    }),
  );
  if (created.status < 200 || created.status >= 300) {
    pushRejected(e0, created);
    return;
  }
  const source = String(created.data.id);
  ctx.created.add(source);
  await writeFile(ctx.watchPath, `https://www.orgo.ai/computers/${source}\n`, { mode: 0o600 });
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

  const e2 = exp("E2", 5);
  const apiMs: number[] = [];
  const bashMs: number[] = [];
  const pauseMs: number[] = [];
  for (let i = 0; i < 5 && affordable(ctx); i += 1) {
    await allow(ctx, 1);
    const from = text(await bash(ctx, source, guest.now));
    const t0 = performance.now();
    const forked = await billable(ctx, `E2 fork ${i + 1}`, source, () =>
      ctx.api("POST", `/api/computers/${source}/fork`, {}),
    );
    if (forked.status !== 201) {
      pushRejected(e2, forked);
      e2.notes.push(
        "A gate ends repetitions of this operation. The fork docs list no quote or confirm parameter, so no follow-up was attempted.",
      );
      break;
    }
    const id = String(forked.data.id);
    ctx.created.add(id);
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
    await billable(ctx, `E2 delete fork ${i + 1}`, id, () =>
      ctx.api("DELETE", `/api/computers/${id}`),
    );
    ctx.created.delete(id);
  }
  e2.metrics = {
    apiMs: stats(apiMs),
    firstBashMs: stats(bashMs.filter(Number.isFinite)),
    sourcePauseMaxGapMs: stats(pauseMs),
  };

  const e3 = exp("E3", 5);
  const cloneApi: number[] = [];
  const cloneBash: number[] = [];
  for (let i = 0; i < 5 && affordable(ctx); i += 1) {
    await allow(ctx, 1);
    const t0 = performance.now();
    const cloned = await billable(ctx, `E3 clone ${i + 1}`, source, () =>
      ctx.api("POST", `/api/computers/${source}/clone`, { name: `${prefix}clone-${i + 1}` }),
    );
    if (cloned.status !== 201) {
      pushRejected(e3, cloned);
      break;
    }
    const id = String(cloned.data.id);
    ctx.created.add(id);
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
    await billable(ctx, `E3 delete clone ${i + 1}`, id, () =>
      ctx.api("DELETE", `/api/computers/${id}`),
    );
    ctx.created.delete(id);
  }
  e3.metrics = { apiMs: stats(cloneApi), firstBashMs: stats(cloneBash.filter(Number.isFinite)) };

  const e4 = exp("E4", 1);
  const stopped = await billable(ctx, "E4 stop", source, () =>
    ctx.api("POST", `/api/computers/${source}/stop`, {}),
  );
  const frozen = await until(ctx, source, status("frozen"), 120_000, getComputer(ctx, source));
  const asleep = await bash(ctx, source, "true", 20);
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
    await billable(ctx, "E5 stop", source, () =>
      ctx.api("POST", `/api/computers/${source}/stop`, {}),
    );
    await until(ctx, source, status("frozen"), 120_000, getComputer(ctx, source));
  }
  const stoppedFork = await billable(ctx, "E5 fork stopped source", source, () =>
    ctx.api("POST", `/api/computers/${source}/fork`, {}),
  );
  e5.n = 1;
  e5.observations.push({
    status: stoppedFork.status,
    code: stoppedFork.code ?? null,
    body: stoppedFork.body.slice(0, 600),
  });
  if (stoppedFork.status === 201) ctx.created.add(String(stoppedFork.data.id));
  const stoppedClone = await billable(ctx, "E5 clone stopped source", source, () =>
    ctx.api("POST", `/api/computers/${source}/clone`, { name: `${prefix}clone-stopped` }),
  );
  e5.observations.push({
    cloneStatus: stoppedClone.status,
    cloneCode: stoppedClone.code ?? null,
    body: stoppedClone.body.slice(0, 600),
  });
  if (stoppedClone.status === 201) ctx.created.add(String(stoppedClone.data.id));
}

/** Delete every `myco-discovery-*` computer (only those), then re-list. Safe to run repeatedly. */
export async function cleanup(
  ctx: Context,
): Promise<{ deleted: string[]; finalCount: number | null }> {
  const deleted: string[] = [];
  const targets = cleanupSelection(await liveInventory(ctx));
  for (const computer of targets) {
    const reply = await billable(ctx, "cleanup delete", computer.id, () =>
      ctx.api("DELETE", `/api/computers/${computer.id}`),
    );
    if (reply.status >= 200 && reply.status < 300) deleted.push(shortId(computer.id));
  }
  const remaining = await liveInventory(ctx).catch(() => null);
  await ledger(ctx, {
    operation: `cleanup final list (${remaining?.length ?? "unknown"} computers)`,
  });
  return { deleted, finalCount: remaining ? remaining.length : null };
}

export async function renderResults(raw: Raw): Promise<string> {
  const fmt = (value: number | null) => (value === null ? "-" : Math.round(value).toString());
  const row = (label: string, m: Metric) =>
    `| ${label} | ${m.n} | ${fmt(m.min)} | ${fmt(m.median)} | ${fmt(m.p95)} | ${fmt(m.max)} |`;
  const lines: string[] = ["# Orgo arm 001 results", ""];
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
  lines.push(`| Eligible for Small | ${p.ok ? "yes" : "NO"} |`, "");
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
      "## Documented, not tested (docs.orgo.ai, retrieved at run time; no live outcome)",
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
    "## Wedge-C: Orgo vs what Myco would need",
    "",
    "| Dimension | Orgo (this account) | Myco comparison |",
    "| --- | --- | --- |",
  );
  const ran = raw.experiments.E2;
  const forkLatency = ran?.metrics.apiMs
    ? `${fmt(ran.metrics.apiMs.median)} ms median API (N=${ran.metrics.apiMs.n})`
    : "not measured (gated)";
  lines.push(
    `| Fork latency / source pause | ${forkLatency}; docs claim ~2 s source pause | Myco reset is ~21-25 s warm and ~165 s from a fresh UTM start (contract section 7a); a Myco \`fork()\` would need to beat both without the live-restore wedge seen in m2-05 |`,
  );
  lines.push(
    "| Clone latency | not measured unless E3 above has samples | a Myco clone starts from a cold boot like Orgo's |",
  );
  lines.push(
    `| Suspend on a credit-only account | ${raw.experiments.E4 ? "see E4" : "not measured (gated)"}; docs: an hourly computer answers 409 HOURLY_USE_STOP | Myco snapshot/restore must keep RAM for credit-only use |`,
  );
  lines.push(
    "| State semantics | docs: fork copies live memory; clone and stop/start keep disk only | Myco needs both plus verified reset state |",
  );
  lines.push(
    "| Cost per branch | docs: Small about $0.023/h; a fork needs its own purchase on an hourly source (HOURLY_QUOTE_REQUIRED) | local branch cost is host CPU and disk only |",
  );
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
};

export function parseArgs(argv: string[]): Args {
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const scenario = (flag("--scenario") ?? "free") as Scenario;
  if (!["free", "paid-gated", "paid-open"].includes(scenario)) throw new Error("Unknown scenario");
  const valueFlags = new Set(["--out", "--workspace", "--scenario", "--charge-cents"]);
  const positional = argv.filter(
    (arg, at) => !arg.startsWith("--") && !valueFlags.has(argv[at - 1] ?? ""),
  );
  const charge = flag("--charge-cents");
  return {
    command: positional[0] ?? "run",
    dryRun: argv.includes("--dry-run"),
    out: resolve(flag("--out") ?? defaultOut),
    workspace: flag("--workspace"),
    scenario,
    charge: charge === undefined ? undefined : Number(charge),
  };
}

async function liveHistory(): Promise<unknown[] | null> {
  try {
    const { stdout } = await run("npx", ["-y", "orgo@2.5.0", "--json", "billing", "history"], {
      timeout: 90_000,
    });
    const rows = object(JSON.parse(stdout)).transactions;
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

export async function main(argv: string[]): Promise<Raw> {
  const args = parseArgs(argv);
  const dryRun = args.dryRun;
  const out =
    dryRun && args.out === defaultOut ? await mkdtemp(join(tmpdir(), "orgo-dry-")) : args.out;
  await mkdir(out, { recursive: true });
  const fake = dryRun ? fakeOrgo({ scenario: args.scenario, chargeCents: args.charge }) : null;
  const key = dryRun ? "sk_dry_run_placeholder" : await loadKey();
  const api = createApi(key, fake ? fake.request : fetch);
  const ledgerPath = join(out, "ledger.jsonl");
  const log = (message: string) => process.stderr.write(`${message}\n`);
  const { workspaceId, result } = await preflight(api, ledgerPath, key, args.workspace);
  const startCents = result.balanceCents ?? 0;
  const ctx: Context = {
    api,
    key,
    dir: out,
    ledgerPath,
    watchPath: dryRun ? join(out, "watch.txt") : "/private/tmp/orgo-setup/watch.txt",
    workspaceId,
    startCents,
    lastCents: startCents,
    sleep: dryRun ? async () => undefined : (ms) => delay(ms),
    balanceWait: dryRun ? async () => undefined : () => delay(3_000),
    history: dryRun ? async () => null : liveHistory,
    log,
    created: new Set(),
  };
  const raw: Raw = {
    mode: dryRun ? "dry-run" : "live",
    generated: new Date().toISOString(),
    preflight: result,
    experiments: {},
    spend: { startCents, endCents: null, ledgerCents: null },
    cleanup: { deleted: [], finalCount: null },
    history: null,
    errors: [],
  };
  if (args.command === "cleanup") {
    raw.cleanup = await cleanup(ctx);
  } else if (args.command === "preflight" || !result.ok) {
    if (!result.ok)
      log(`Preflight gate: ${result.reasons.length} reason(s); no compute call made.`);
  } else {
    const deadline = setTimeout(() => ctx.log("30 minute run bound reached"), 30 * 60_000);
    try {
      await runExperiments(ctx, raw);
    } catch (error) {
      raw.errors.push(error instanceof Error ? error.message : "unknown error");
    } finally {
      clearTimeout(deadline);
      raw.cleanup = await cleanup(ctx).catch((error: unknown) => {
        raw.errors.push(`cleanup: ${error instanceof Error ? error.message : "failed"}`);
        return raw.cleanup;
      });
    }
  }
  const end = await credit(ctx).catch(() => null);
  raw.spend.endCents = end;
  raw.spend.ledgerCents = end === null ? null : startCents - end;
  raw.history = await ctx.history();
  const target = dryRun ? out : args.out;
  await writeFile(join(target, "raw.json"), `${JSON.stringify(raw, null, 2)}\n`);
  await writeFile(join(target, "RESULTS.md"), await renderResults(raw));
  return raw;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (raw) =>
      process.stdout.write(
        `${raw.mode}: preflight ${raw.preflight.ok ? "passed" : "gated"}; computers after cleanup ${raw.cleanup.finalCount ?? "n/a"}\n`,
      ),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? redact(error.message, "") : "failed"}\n`);
      process.exitCode = 1;
    },
  );
}
