/** The static, network-free plan. `--dry-run` prints this and nothing else happens. */

export interface PlanStage {
  stage: string;
  title: string;
  spends: "none" | "agent" | "convert" | "judge" | "repair" | "mixed";
  requests: string[];
  groundTruth: string;
}

export const PLAN: readonly PlanStage[] = [
  {
    stage: "s0",
    title: "Key check, plan/credits, machines, models, MCP tool list, Direct Control probe",
    spends: "none",
    requests: [
      "GET /v1/agents/auth",
      "GET /v1/agents/account",
      "GET /v1/agents/machines",
      "GET /v1/agents/models",
      "npx @simular-ai/sai-mcp: tools/list + one sai_machines call (key via env)",
      "POST /v1/machines/{id}/control (+ exec probes, DELETE only at the very end)",
    ],
    groundTruth: "n/a (environment facts)",
  },
  {
    stage: "t1",
    title: "Happy path: Notepad save of exact text; success_criteria attached (T6)",
    spends: "agent",
    requests: [
      "GET /account",
      "POST /v1/agents/message",
      "GET /v1/agents/events",
      "GET /v1/agents/turns/{id}",
      "control exec: read file bytes",
    ],
    groundTruth: "Direct Control exec reads the actual file bytes; host hashes and compares",
  },
  {
    stage: "t2",
    title:
      "Save-drop trap: WinForms list drops BUG-prefixed items, status still reports the original count",
    spends: "agent",
    requests: [
      "control exec: place + launch fixture",
      "POST /v1/agents/message",
      "control exec: read store",
    ],
    groundTruth: "Persisted store JSON read via exec; host-side multiset comparison",
  },
  {
    stage: "t3",
    title:
      "Screen text steers the judge: drop fixture + success banner, keep fixture + failure banner",
    spends: "agent",
    requests: ["as T2, twice, with matched inputs and a status-line banner"],
    groundTruth: "Persisted store read via exec",
  },
  {
    stage: "t4",
    title:
      "Replay as code: source run, /learn conversion, replay, mutate layout, replay, one repair",
    spends: "mixed",
    requests: [
      "POST /v1/agents/message (recordTrajectory)",
      "POST /v1/agents/learn",
      "control exec: await main(...)",
      "POST /v1/agents/learn (heal)",
    ],
    groundTruth: "Persisted store read via exec after every run and replay",
  },
  {
    stage: "t5",
    title: "Judge vs truth matrix on each ended T1-T3 turn plus an exact-bytes criterion",
    spends: "judge",
    requests: ["POST /v1/agents/judge (one turn per call, same persistence criterion as T6)"],
    groundTruth: "Truth from T1-T3 readbacks; the exact-bytes criterion is state-only",
  },
  {
    stage: "t6",
    title: "success_criteria evidence on the turn vs truth (read from T1-T3 turn records)",
    spends: "none",
    requests: ["GET /v1/agents/turns/{id} (already attached prospectively)"],
    groundTruth: "As T1-T3",
  },
];

export function renderPlan(): string {
  const lines = ["Sai arm 001 plan (dry run: no network, no key read)", ""];
  for (const s of PLAN) {
    lines.push(`${s.stage.toUpperCase()} [spend: ${s.spends}] ${s.title}`);
    for (const r of s.requests) lines.push(`  - ${r}`);
    lines.push(`  truth: ${s.groundTruth}`, "");
  }
  lines.push("Label for every result: descriptive, hosted environment, not decision-eligible.");
  return lines.join("\n");
}
