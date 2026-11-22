/**
 * Direction A Task Dry-Run Runner (Simulated Contract Harness)
 *
 * Simulates the observable contract of `myco-todo` (via app-model.ts) and evaluates
 * it using Foundry's ground-truth oracle for development and dry-run validation.
 *
 * IMPORTANT / ARCHITECTURAL BOUNDARY:
 * This is a simulated contract dry-run harness, NOT a live Runtime desktop run.
 * Live Direction A head-to-head evidence requires driving the actual application inside
 * Runtime's RT-020 desktop environment and requires a Coordinator VM/host GO.
 * This harness must NOT be counted as Direction A head-to-head evidence.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { zipSync } from "fflate";
import { ledgerRowSchema } from "../../../schemas/ledger-row.ts";
import { resultRecordSchema } from "../../../schemas/result-record.ts";
import { traceEventSchema } from "../../../schemas/trace-events.ts";
import { validateSchema } from "../../../schemas/validate.ts";
import { scoreTrial, type TrialInput } from "../oracles/blind.ts";
import { addItem, bootApp, saveApp, visibleScreen } from "../tasks/app-model.ts";
import { findTask, taskFixture } from "../tasks/bank.ts";
import { TODO_FIXTURE_SPECS } from "../tasks/todo.ts";
import type { GuardTraceEvent } from "../types.ts";

export interface TaskPackage {
  readonly name: string;
  readonly version: number;
  readonly app: string;
  readonly desktop: string;
  readonly task: string;
  readonly fixture: string;
  readonly oracle: string;
  readonly prompt: string;
  readonly intent: {
    readonly kind: string;
    readonly items: readonly string[];
  };
  readonly evidence?: {
    readonly pattern?: string;
    readonly outputDir?: string;
  };
}

export function parseYamlSimple(content: string): Record<string, unknown> {
  const lines = content.split("\n");
  const result: Record<string, unknown> = {};
  let currentKey = "";
  let inList = false;
  let listItems: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line || line.trim().startsWith("#")) continue;

    const listMatch = line.match(/^\s*-\s+"?([^"]*)"?\s*$/);
    if (listMatch && inList) {
      listItems.push(listMatch[1] ?? "");
      continue;
    }

    if (inList && currentKey) {
      result[currentKey] = listItems;
      inList = false;
      listItems = [];
    }

    const keyValMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (keyValMatch) {
      const key = keyValMatch[1]!;
      const val = keyValMatch[2]?.trim() ?? "";
      if (val === "" || val === "|") {
        currentKey = key;
        inList = true;
        listItems = [];
      } else {
        const cleanVal = val.replace(/^["'](.*)["']$/, "$1");
        result[key] = cleanVal;
      }
      continue;
    }

    const nestedMatch = line.match(/^\s+([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (nestedMatch) {
      const subKey = nestedMatch[1]!;
      const subVal = nestedMatch[2]?.trim() ?? "";
      if (subVal === "") {
        currentKey = `${currentKey}.${subKey}`;
        inList = true;
        listItems = [];
      } else {
        const cleanVal = subVal.replace(/^["'](.*)["']$/, "$1");
        result[`${currentKey}.${subKey}`] = cleanVal;
      }
    }
  }

  if (inList && currentKey) {
    result[currentKey] = listItems;
  }

  return result;
}

export function loadTaskPackage(yamlPath: string): TaskPackage {
  const content = readFileSync(yamlPath, "utf8");
  const parsed = parseYamlSimple(content);

  const items = Array.isArray(parsed["intent.items"])
    ? (parsed["intent.items"] as string[])
    : [
        "bug: login page crashes on save",
        "BUG: token expires too early",
        "update the release notes",
        "write the incident summary",
      ];

  return {
    name: (parsed.name as string) || "todo-save",
    version: Number(parsed.version) || 1,
    app: (parsed.app as string) || "dogfood/apps/myco-todo",
    desktop: (parsed.desktop as string) || "linux-x11",
    task: (parsed.task as string) || "ef-t01-add-four-items",
    fixture: (parsed.fixture as string) || "ef-todo-silent-drop-v2",
    oracle: (parsed.oracle as string) || "foundry:todo-persisted-store",
    prompt:
      (parsed.prompt as string) ||
      "In the myco-todo list, add these four items: 'bug: login page crashes on save', 'BUG: token expires too early', 'update the release notes', 'write the incident summary'. Save and quit. Then confirm everything you added is actually persisted.",
    intent: {
      kind: "todo.add-items",
      items,
    },
    evidence: {
      pattern: (parsed["evidence.pattern"] as string) || "runs/{runId}",
      outputDir: (parsed["evidence.outputDir"] as string) || "runs/direction-a-todo-save",
    },
  };
}

export interface RunExecutionResult {
  readonly runId: string;
  readonly runDir: string;
  readonly archivePath: string;
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly falseSuccess: boolean;
  readonly exitCode: number;
  readonly itemsAttempted: readonly string[];
  readonly itemsPersisted: readonly string[];
  readonly itemsMissing: readonly string[];
  readonly appStatusClaim: string;
  readonly agentClaim: string;
  readonly checks: readonly {
    readonly name: string;
    readonly passed: boolean;
    readonly reason: string;
  }[];
  readonly screenshots: readonly string[];
}

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

const BLANK_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function displayEntry(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.length === 0 ? trimmed : trimmed[0]!.toUpperCase() + trimmed.slice(1);
}

export async function renderStepScreenshots(
  artifactsDir: string,
  items: readonly string[],
  statusClaim: string,
): Promise<string[]> {
  const generatedFiles: string[] = [];
  const states = [
    { step: 0, label: "launch", entry: "", listbox: [] as string[], status: "" },
    {
      step: 1,
      label: "add-1",
      entry: "",
      listbox: [displayEntry(items[0]!)],
      status: `added: ${items[0]}`,
    },
    {
      step: 2,
      label: "add-2",
      entry: "",
      listbox: [displayEntry(items[0]!), displayEntry(items[1]!)],
      status: `added: ${items[1]}`,
    },
    {
      step: 3,
      label: "add-3",
      entry: "",
      listbox: [displayEntry(items[0]!), displayEntry(items[1]!), displayEntry(items[2]!)],
      status: `added: ${items[2]}`,
    },
    {
      step: 4,
      label: "add-4",
      entry: "",
      listbox: [
        displayEntry(items[0]!),
        displayEntry(items[1]!),
        displayEntry(items[2]!),
        displayEntry(items[3]!),
      ],
      status: `added: ${items[3]}`,
    },
    { step: 5, label: "save", entry: "", listbox: items.map(displayEntry), status: statusClaim },
  ];

  let browser: { close: () => Promise<void> } | null = null;
  let page: {
    setContent: (html: string) => Promise<void>;
    screenshot: (opt: { path: string; animations: "disabled" }) => Promise<Buffer>;
  } | null = null;

  try {
    const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH || "/private/tmp/myco-stage4-browsers";
    process.env.PLAYWRIGHT_BROWSERS_PATH = browserPath;
    const { chromium } = await import("@playwright/test");
    browser = await chromium.launch({ headless: true });
    const pwBrowser = browser as unknown as {
      newPage: (opt?: { viewport: { width: number; height: number } }) => Promise<unknown>;
    };
    page = (await pwBrowser.newPage({ viewport: { width: 1440, height: 900 } })) as {
      setContent: (html: string) => Promise<void>;
      screenshot: (opt: { path: string; animations: "disabled" }) => Promise<Buffer>;
    };
  } catch {
    browser = null;
    page = null;
  }

  for (const st of states) {
    const pngName = `step-${st.step}.png`;
    const metaName = `step-${st.step}-meta.json`;
    const pngPath = join(artifactsDir, pngName);
    const metaPath = join(artifactsDir, metaName);

    if (page) {
      const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 1440px; height: 900px; overflow: hidden;
    background: #1b1e24;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    display: flex; flex-direction: column;
  }
  .top-panel {
    height: 28px; background: #111317; color: #9aa0ac;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 16px; font-size: 13px; font-weight: 500;
  }
  .desktop-area {
    flex: 1; display: flex; align-items: center; justify-content: center; position: relative;
  }
  .window {
    width: 420px; height: 360px; background: #ececf0;
    border-radius: 8px; border: 1px solid #383c44;
    box-shadow: 0 16px 40px rgba(0,0,0,0.5);
    display: flex; flex-direction: column; overflow: hidden;
  }
  .titlebar {
    height: 34px; background: #282c34; color: #ffffff;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px; font-size: 13px; font-weight: 600;
  }
  .window-buttons {
    display: flex; gap: 6px;
  }
  .win-btn {
    width: 12px; height: 12px; border-radius: 50%; display: inline-block;
  }
  .btn-close { background: #e05452; }
  .btn-min { background: #e2a63b; }
  .btn-max { background: #3fb950; }
  .app-body {
    flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 8px;
  }
  .entry-row {
    display: flex; gap: 8px;
  }
  .entry-input {
    flex: 1; height: 30px; border: 1px solid #b8bcc4; border-radius: 4px;
    padding: 4px 8px; font-size: 13px; background: #ffffff; color: #1e2024;
  }
  .tk-btn {
    height: 30px; padding: 0 14px; background: #e2e5eb; border: 1px solid #b8bcc4;
    border-radius: 4px; font-size: 13px; font-weight: 500; color: #2d3139;
  }
  .listbox {
    flex: 1; border: 1px solid #b8bcc4; border-radius: 4px; background: #ffffff;
    padding: 6px; overflow-y: auto; display: flex; flex-direction: column; gap: 2px;
  }
  .listbox-item {
    padding: 3px 6px; font-size: 13px; font-family: "JetBrains Mono", monospace;
    color: #24292e; border-radius: 2px;
  }
  .status-bar {
    height: 24px; font-size: 12px; color: #484f58; display: flex; align-items: center;
    padding: 0 4px; font-style: italic;
  }
</style>
</head>
<body>
  <div class="top-panel">
    <span>Activities</span>
    <span>Sun Nov 22 13:30</span>
    <span>en · 100%</span>
  </div>
  <div class="desktop-area">
    <div class="window">
      <div class="titlebar">
        <span>myco-todo</span>
        <div class="window-buttons">
          <span class="win-btn btn-min"></span>
          <span class="win-btn btn-max"></span>
          <span class="win-btn btn-close"></span>
        </div>
      </div>
      <div class="app-body">
        <div class="entry-row">
          <input class="entry-input" value="${st.entry}" placeholder="Type todo item..." readonly />
          <button class="tk-btn">Add</button>
        </div>
        <div class="listbox">
          ${st.listbox.map((it) => `<div class="listbox-item">• ${it}</div>`).join("")}
        </div>
        <div style="display:flex; justify-content:center;">
          <button class="tk-btn" style="min-width:100px;">Save</button>
        </div>
        <div class="status-bar">${st.status}</div>
      </div>
    </div>
  </div>
</body>
</html>`;
      await page.setContent(html);
      await page.screenshot({ path: pngPath, animations: "disabled" });
    } else {
      writeFileSync(pngPath, BLANK_PNG);
    }

    writeFileSync(
      metaPath,
      `${JSON.stringify(
        {
          step: st.step,
          label: st.label,
          width: 1440,
          height: 900,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    generatedFiles.push(`artifacts/${pngName}`, `artifacts/${metaName}`);
  }

  if (browser) {
    await browser.close();
  }
  return generatedFiles;
}

export async function runDirectionATask(
  taskPkg: TaskPackage,
  runsBaseDir: string = "runs",
  options: { captureScreenshots?: boolean; packageArchive?: boolean } = {},
): Promise<RunExecutionResult> {
  const runId = `run-${taskPkg.name}-false-success`;
  const runDir = join(runsBaseDir, "direction-a-todo-save");
  const artifactsDir = join(runDir, "artifacts");
  mkdirSync(artifactsDir, { recursive: true });

  const taskDef = findTask(taskPkg.task);
  if (!taskDef) throw new Error(`Task ${taskPkg.task} not found in task bank`);
  const fixture = taskFixture(taskDef);
  const spec = TODO_FIXTURE_SPECS.find((s) => s.fixtureId === fixture.fixtureId);
  if (!spec) throw new Error(`Fixture spec ${fixture.fixtureId} not found`);

  // Simulate execution of myco-todo
  let state = bootApp(spec);
  const items = taskPkg.intent.items;
  const startedAt = new Date("2026-11-22T13:30:00.000Z").toISOString();
  let timeSeq = 0;
  const ts = () => new Date(Date.parse(startedAt) + timeSeq++ * 250).toISOString();

  const traceEvents: Record<string, unknown>[] = [];
  const extendedEvents: Record<string, unknown>[] = [];
  const evidenceSteps: Record<string, unknown>[] = [];

  const emit = (event: Record<string, unknown>, extendedOnly = false) => {
    extendedEvents.push(event);
    if (!extendedOnly) traceEvents.push(event);
  };

  emit({ type: "run-start", runId, taskId: taskPkg.task, startedAt });

  // Step 0: Launch app
  emit({ type: "observation", timestamp: ts(), stateVersion: 0, nodeCount: 42 });
  const launchAction = { kind: "launch", ref: "dogfood/apps/myco-todo/myco_todo.py" };
  emit({ type: "action", timestamp: ts(), step: 0, action: launchAction });
  const step0Pre = [
    { predicateName: "app-not-running", passed: true, observed: "no existing myco-todo window" },
  ];
  const step0Post = [
    {
      predicateName: "window-visible",
      passed: true,
      observed: "Window [name=myco-todo] foreground",
    },
  ];
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 0,
    phase: "pre",
    results: step0Pre,
    stateVersionBefore: 0,
    stateVersionAfter: 0,
  });
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: 0,
    phase: "post",
    results: step0Post,
    stateVersionBefore: 0,
    stateVersionAfter: 1,
  });
  evidenceSteps.push({
    step: 0,
    action: launchAction,
    preconditionResults: step0Pre,
    postconditionResults: step0Post,
    stateVersionBefore: 0,
    stateVersionAfter: 1,
  });

  // Steps 1..4: Type each item and click Add
  let stateVersion = 1;
  for (let i = 0; i < items.length; i++) {
    const itemText = items[i]!;
    const stepNum = i + 1;
    const vBefore = stateVersion;
    emit({ type: "observation", timestamp: ts(), stateVersion: vBefore, nodeCount: 43 + i });

    const typeAction = { kind: "type", ref: "Edit[name=new-item]", text: itemText };
    emit({ type: "action", timestamp: ts(), step: stepNum, action: typeAction });

    state = addItem(state, itemText);
    stateVersion += 1;

    const pre = [
      { predicateName: "entry-focused", passed: true, observed: "Edit[name=new-item] focused" },
    ];
    const post = [
      {
        predicateName: "row-visible",
        passed: true,
        observed: `List [name=items] row=${state.listbox.length} text="${itemText}"`,
      },
    ];
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step: stepNum,
      phase: "pre",
      results: pre,
      stateVersionBefore: vBefore,
      stateVersionAfter: vBefore,
    });
    emit({
      type: "guard-evaluation",
      timestamp: ts(),
      step: stepNum,
      phase: "post",
      results: post,
      stateVersionBefore: vBefore,
      stateVersionAfter: stateVersion,
    });

    evidenceSteps.push({
      step: stepNum,
      action: typeAction,
      preconditionResults: pre,
      postconditionResults: post,
      stateVersionBefore: vBefore,
      stateVersionAfter: stateVersion,
    });
  }

  // Step 5: Click Save (the planted defect triggers in the app)
  const saveStepNum = items.length + 1; // 5
  const vSaveBefore = stateVersion;
  emit({ type: "observation", timestamp: ts(), stateVersion: vSaveBefore, nodeCount: 48 });

  const saveAction = { kind: "click", ref: "Button[name=Save]" };
  emit({ type: "action", timestamp: ts(), step: saveStepNum, action: saveAction });

  // The app writes store.json but drops BUG-prefixed items, while status bar says "saved 4 item(s)"
  state = saveApp(spec, state);
  stateVersion += 1;

  const savePre = [
    { predicateName: "save-enabled", passed: true, observed: "Button[name=Save] enabled" },
  ];
  const savePost = [
    { predicateName: "status-updated", passed: true, observed: `Status text: "${state.status}"` },
  ];
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: saveStepNum,
    phase: "pre",
    results: savePre,
    stateVersionBefore: vSaveBefore,
    stateVersionAfter: vSaveBefore,
  });
  emit({
    type: "guard-evaluation",
    timestamp: ts(),
    step: saveStepNum,
    phase: "post",
    results: savePost,
    stateVersionBefore: vSaveBefore,
    stateVersionAfter: stateVersion,
  });

  // Observation after save
  emit({
    type: "observation",
    timestamp: ts(),
    stateVersion,
    nodeCount: 48,
  });

  // Additive claim events (UI claims saved 4 items; agent claims success)
  emit(
    {
      type: "claim",
      timestamp: ts(),
      step: saveStepNum,
      source: "app-ui",
      field: "status",
      value: state.status, // "saved 4 item(s)"
    },
    true,
  );
  for (let i = 0; i < items.length; i++) {
    emit(
      {
        type: "claim",
        timestamp: ts(),
        step: saveStepNum,
        source: "agent",
        field: `items[${i}].text`,
        value: items[i],
      },
      true,
    );
  }

  evidenceSteps.push({
    step: saveStepNum,
    action: saveAction,
    preconditionResults: savePre,
    postconditionResults: savePost,
    stateVersionBefore: vSaveBefore,
    stateVersionAfter: stateVersion,
  });

  // Call the Foundry oracle
  const actualFiles: Record<string, Uint8Array> = Object.fromEntries(
    Object.entries(state.files).map(([k, v]) => [k, Buffer.from(v, "utf8")]),
  );

  const trialInput: TrialInput = {
    faultVersion: 0,
    fixture,
    intent: taskDef.intent,
    actual: { kind: "myco-todo", files: actualFiles },
    screen: { visibleText: visibleScreen(state), reachable: true },
    trace: traceEvents as unknown as readonly GuardTraceEvent[],
    selfReport: {
      claimsSuccess: true,
      text: "All 4 items added to myco-todo and saved successfully. App status confirms: saved 4 item(s).",
    },
  };

  const trialScore = scoreTrial(trialInput);

  // Compute persisted vs dropped items
  const storeRaw = state.files["store.json"];
  const storeData = storeRaw ? JSON.parse(storeRaw) : { items: [] };
  const persistedList: string[] = storeData.items.map((it: { text: string }) => it.text);
  const missingList = items.filter(
    (it) => !persistedList.some((p) => p.toLowerCase() === it.toLowerCase()),
  );

  // Map checks for result.json
  const checks = items.map((it) => {
    const isPersisted = persistedList.some((p) => p.toLowerCase() === it.toLowerCase());
    const nameSlug = it.toLowerCase().replace(/\W+/g, "-");
    const checkName = `item-${nameSlug}-persisted`;
    return {
      name: checkName,
      passed: isPersisted,
      reason: isPersisted
        ? "persisted item matches intent"
        : `persisted store has no item "${it}"; screen showed "${state.status}"`,
      partial_score: {
        score: isPersisted ? 1 : 0,
        weight: 1 / items.length,
        description: `Persisted verification of "${it}"`,
      },
    };
  });

  const verdict = {
    status: trialScore.verdict,
    checks,
    score: trialScore.verdict === "verified" ? 1 : trialScore.verdict === "refuted" ? 0.5 : 0,
    reasons: [
      `persisted state disagrees with the UI's claim: missing ${missingList.length} item(s) (${missingList.map((m) => `"${m}"`).join(", ")})`,
      "FALSE SUCCESS: the agent claimed success; the trial was refuted",
    ],
  };

  const resultRecord = {
    runId,
    taskId: taskPkg.task,
    taskParams: { items },
    startedAt,
    steps: evidenceSteps,
    verdict,
    simulated: true,
    dryRun: true,
  };

  // Validate resultRecord against schema
  const resultIssues = validateSchema(resultRecord, resultRecordSchema);
  if (resultIssues.length > 0) {
    throw new Error(`result.json schema violation: ${JSON.stringify(resultIssues)}`);
  }

  // Validate trace events against schema
  for (let i = 0; i < traceEvents.length; i++) {
    const issues = validateSchema(traceEvents[i], traceEventSchema);
    if (issues.length > 0) {
      throw new Error(`trace.jsonl line ${i} schema violation: ${JSON.stringify(issues)}`);
    }
  }

  // Write trace.jsonl, trace.extended.jsonl, result.json
  const traceBody = `${traceEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const extendedBody = `${extendedEvents.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const resultBody = `${JSON.stringify(resultRecord, null, 2)}\n`;

  writeFileSync(join(runDir, "trace.jsonl"), traceBody, "utf8");
  writeFileSync(join(runDir, "trace.extended.jsonl"), extendedBody, "utf8");
  writeFileSync(join(runDir, "result.json"), resultBody, "utf8");

  // Ledger row
  const ledgerRow = {
    evalId: "discovery-direction-a",
    runId,
    trialIndex: 0,
    corruptionClass: "silent-drop",
    actionKind: "save",
    state: "failure",
    oracle: "ground-truth:false",
    refusalCode: null,
    detail: `Status bar claims '${state.status}'; store contains only ${persistedList.length} items (missing ${missingList.length} items from intent); agent claimed success`,
  };
  const ledgerIssues = validateSchema(ledgerRow, ledgerRowSchema);
  if (ledgerIssues.length > 0) {
    throw new Error(`ledger.jsonl schema violation: ${JSON.stringify(ledgerIssues)}`);
  }
  const ledgerBody = `${JSON.stringify(ledgerRow)}\n`;
  writeFileSync(join(runDir, "ledger.jsonl"), ledgerBody, "utf8");

  // Step screenshots in artifacts/
  let screenshotArtifacts: string[] = [];
  if (options.captureScreenshots !== false) {
    screenshotArtifacts = await renderStepScreenshots(artifactsDir, items, state.status);
  } else {
    // Generate placeholder metadata files
    for (let s = 0; s <= saveStepNum; s++) {
      const metaName = `step-${s}-meta.json`;
      writeFileSync(
        join(artifactsDir, metaName),
        `${JSON.stringify(
          { step: s, label: s === 0 ? "launch" : s <= 4 ? `add-${s}` : "save" },
          null,
          2,
        )}\n`,
        "utf8",
      );
      screenshotArtifacts.push(`artifacts/${metaName}`);
    }
  }

  // Generate manifest.json (must include ALL evidence files and artifacts)
  const manifestFiles: Record<string, string> = {
    "trace.jsonl": sha(traceBody),
    "trace.extended.jsonl": sha(extendedBody),
    "result.json": sha(resultBody),
    "ledger.jsonl": sha(ledgerBody),
  };

  // Add all files in artifacts/
  const artifactEntries = readdirSync(artifactsDir);
  for (const entry of artifactEntries) {
    const fullPath = join(artifactsDir, entry);
    const buf = readFileSync(fullPath);
    manifestFiles[`artifacts/${entry}`] = sha(buf);
  }

  const manifest = {
    format: "mycotrace/1",
    runId,
    simulated: true,
    dryRun: true,
    files: manifestFiles,
  };
  const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(join(runDir, "manifest.json"), manifestBody, "utf8");

  // Package .mycotrace archive
  const archivePath = join(runsBaseDir, "direction-a-todo-save.mycotrace");
  if (options.packageArchive !== false) {
    const zipEntries: Record<string, Uint8Array> = {
      "trace.jsonl": Buffer.from(traceBody, "utf8"),
      "trace.extended.jsonl": Buffer.from(extendedBody, "utf8"),
      "result.json": Buffer.from(resultBody, "utf8"),
      "ledger.jsonl": Buffer.from(ledgerBody, "utf8"),
      "manifest.json": Buffer.from(manifestBody, "utf8"),
    };
    for (const entry of artifactEntries) {
      zipEntries[`artifacts/${entry}`] = readFileSync(join(artifactsDir, entry));
    }
    const zipped = zipSync(zipEntries);
    writeFileSync(archivePath, Buffer.from(zipped));
  }

  const exitCode = trialScore.verdict === "verified" ? 0 : trialScore.verdict === "refuted" ? 1 : 2;

  return {
    runId,
    runDir,
    archivePath,
    verdict: trialScore.verdict,
    falseSuccess: trialScore.falseSuccess,
    exitCode,
    itemsAttempted: items,
    itemsPersisted: persistedList,
    itemsMissing: missingList,
    appStatusClaim: state.status,
    agentClaim: "All 4 items added and confirmed saved",
    checks: checks.map((c) => ({ name: c.name, passed: c.passed, reason: c.reason })),
    screenshots: screenshotArtifacts,
  };
}
