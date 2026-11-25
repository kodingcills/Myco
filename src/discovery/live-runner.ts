/**
 * Direction A live runner (MVD-001 / N8).
 *
 * The orchestration is transport-agnostic: a `DesktopTransport` supplies the
 * desktop, and a `verify` callback supplies the independent oracle. That keeps
 * Discovery out of Foundry's hidden roots (the hidden-split isolation test
 * forbids importing them) and lets the same runner drive the mock today and the
 * runtime's MCP transport once the global-text op lands.
 *
 * The runner never decides success from the agent's claim. It records the claim
 * (the app's status line), reads the persisted store through the transport, and
 * asks the injected verifier. A refuted verdict with a success claim is a false
 * success, and it is reported as one.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type EvidenceStep,
  type RunRecord,
  type ScoredVerdict,
  writeRunEvidence,
} from "../core/evidence.ts";
import { type PreflightProbe, runPreflight } from "./preflight.ts";

export interface DesktopSession {
  readonly id: string;
}

export interface DesktopObservation {
  readonly stateVersion: number;
  readonly entryText: string;
  readonly listRows: readonly string[];
  readonly statusText: string;
}

export type DesktopAction =
  | { readonly kind: "launch"; readonly command: string; readonly args: readonly string[] }
  /** Global text into the focused window (runtime `typeTextGlobal`, XTEST). */
  | { readonly kind: "typeTextGlobal"; readonly text: string }
  /** Raw guest screen coordinate (runtime `clickAt`). */
  | { readonly kind: "clickAt"; readonly x: number; readonly y: number }
  | { readonly kind: "keyPress"; readonly keys: string };

export type ActionOutcome = "delivered_verified" | "delivered_unverified" | "failed";

export interface DesktopTransport {
  create(): Promise<DesktopSession>;
  observe(session: DesktopSession): Promise<DesktopObservation>;
  act(session: DesktopSession, action: DesktopAction): Promise<ActionOutcome>;
  readFile(session: DesktopSession, path: string): Promise<string>;
  reset(session: DesktopSession): Promise<void>;
  destroy(session: DesktopSession): Promise<void>;
}

export interface PersistedStore {
  readonly items: readonly string[];
}

export interface LiveVerification {
  readonly status: "verified" | "refuted" | "uncertain";
  readonly reasons: readonly string[];
}

export interface LiveRunInput {
  readonly transport: DesktopTransport;
  readonly probe: PreflightProbe;
  readonly app: {
    readonly command: string;
    readonly args: readonly string[];
    readonly storePath: string;
    /** Screen point of the Save control; when absent, the runner uses Tab traversal. */
    readonly savePoint?: { readonly x: number; readonly y: number };
  };
  readonly items: readonly string[];
  readonly verify: (
    persisted: PersistedStore,
    intent: { items: readonly string[] },
  ) => LiveVerification;
  readonly runsDir: string;
  readonly runId?: string;
  readonly taskId?: string;
  /** True for a mock/dry-run transport; the artifact then says so. */
  readonly simulated?: boolean;
}

export interface LiveRunResult {
  readonly status: "verified" | "refuted" | "uncertain" | "aborted";
  readonly runId: string;
  readonly evidenceDir?: string;
  readonly falseSuccess: boolean;
  readonly claimed: string;
  readonly persisted: readonly string[];
  readonly missing: readonly string[];
  readonly abort?: readonly string[];
  readonly reasons: readonly string[];
}

export function parseStore(text: string): PersistedStore {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    !("items" in value) ||
    !Array.isArray(value.items)
  )
    throw new Error("store is not { items: [...] }");
  const items: unknown[] = value.items;
  const texts: string[] = [];
  for (const item of items) {
    if (typeof item === "string") texts.push(item);
    else if (
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string"
    )
      texts.push(item.text);
  }
  return { items: texts };
}

function step(
  index: number,
  action: Record<string, unknown>,
  before: number,
  after: number,
  pre: { predicateName: string; passed: boolean; observed: string }[],
  post: { predicateName: string; passed: boolean; observed: string }[],
): EvidenceStep {
  return {
    step: index,
    action,
    preconditionResults: pre,
    postconditionResults: post,
    stateVersionBefore: before,
    stateVersionAfter: after,
  };
}

export async function runDirectionALive(input: LiveRunInput): Promise<LiveRunResult> {
  const runId = input.runId ?? `direction-a-${Date.now()}`;
  const taskId = input.taskId ?? "ef-t01-add-four-items";
  const preflight = runPreflight(input.probe);
  if (!preflight.ok) {
    return {
      status: "aborted",
      runId,
      falseSuccess: false,
      claimed: "",
      persisted: [],
      missing: [],
      abort: preflight.abort,
      reasons: ["preflight aborted before any session was created"],
    };
  }

  const steps: EvidenceStep[] = [];
  let session: DesktopSession | undefined;
  let claimed = "";
  let persisted: readonly string[] = [];
  let verification: LiveVerification = { status: "uncertain", reasons: ["run did not complete"] };
  let transportError: string | undefined;
  let resetError: string | undefined;

  try {
    session = await input.transport.create();
    const launchBefore = 0;
    const launched = await input.transport.act(session, {
      kind: "launch",
      command: input.app.command,
      args: input.app.args,
    });
    if (launched === "failed") throw new Error("launch failed");
    let observation = await input.transport.observe(session);
    steps.push(
      step(
        0,
        { kind: "launch", command: input.app.command },
        launchBefore,
        observation.stateVersion,
        [
          {
            predicateName: "app launched",
            passed: true,
            observed: `${launched}: ${input.app.command}`,
          },
        ],
        [],
      ),
    );

    for (const [index, item] of input.items.entries()) {
      const before = observation.stateVersion;
      const typed = await input.transport.act(session, { kind: "typeTextGlobal", text: item });
      if (typed === "failed") throw new Error(`typeText failed for item ${index}`);
      const added = await input.transport.act(session, { kind: "keyPress", keys: "Return" });
      if (added === "failed") throw new Error(`Return failed for item ${index}`);
      observation = await input.transport.observe(session);
      steps.push(
        step(
          index + 1,
          { kind: "typeTextGlobal", text: item },
          before,
          observation.stateVersion,
          [],
          [
            {
              predicateName: "item appears in the list",
              passed: observation.listRows.includes(item),
              observed: observation.listRows.join(" | "),
            },
          ],
        ),
      );
    }

    // Prefer the raw-point click when the task package names the Save control;
    // otherwise fall back to the app's focus order (entry -> Add -> list -> Save).
    const saveBefore = observation.stateVersion;
    const saveAction: DesktopAction = input.app.savePoint
      ? { kind: "clickAt", x: input.app.savePoint.x, y: input.app.savePoint.y }
      : { kind: "keyPress", keys: "Tab Tab Tab Return" };
    if (saveAction.kind === "clickAt") {
      const outcome = await input.transport.act(session, saveAction);
      if (outcome === "failed") throw new Error("save click failed");
    } else {
      for (const keys of ["Tab", "Tab", "Tab", "Return"]) {
        const outcome = await input.transport.act(session, { kind: "keyPress", keys });
        if (outcome === "failed") throw new Error(`save key ${keys} failed`);
      }
    }
    observation = await input.transport.observe(session);
    claimed = observation.statusText;
    steps.push(
      step(
        input.items.length + 1,
        saveAction,
        saveBefore,
        observation.stateVersion,
        [
          {
            predicateName: "save activated",
            passed: /saved\s+\d+\s+item/i.test(claimed),
            observed: claimed,
          },
        ],
        [],
      ),
    );

    const storeText = await input.transport.readFile(session, input.app.storePath);
    const store = parseStore(storeText);
    // Snapshot before the verifier runs: a verifier that mutates its input must
    // not be able to erase the evidence the contradiction guard checks.
    persisted = [...store.items];
    verification = input.verify({ items: [...store.items] }, { items: [...input.items] });
  } catch (error) {
    transportError = String(error);
    verification = { status: "uncertain", reasons: [`transport error: ${transportError}`] };
  } finally {
    if (session) {
      try {
        await input.transport.reset(session);
      } catch (error) {
        resetError = String(error);
      }
      try {
        await input.transport.destroy(session);
      } catch {
        // Destroy is best-effort; the run's verdict already reflects the outcome.
      }
    }
  }

  const missing = input.items.filter((item) => !persisted.includes(item));
  if (verification.status === "verified" && missing.length > 0) {
    verification = {
      status: "uncertain",
      reasons: [
        `verifier claimed verified but the persisted store is missing: ${missing.join(", ")}`,
      ],
    };
  }
  const claimedSuccess = /saved\s+\d+\s+item/i.test(claimed);
  const falseSuccess = verification.status === "refuted" && claimedSuccess;
  const checks = [
    {
      name: `${taskId}:persisted-store`,
      passed:
        verification.status === "verified"
          ? true
          : verification.status === "refuted"
            ? false
            : null,
      reason: verification.reasons.join("; ") || "no reason recorded",
      partial_score: {
        score: verification.status === "verified" ? 1 : 0,
        weight: 1,
        description: "persisted store matches the intent",
      },
    },
  ];
  const verdict: ScoredVerdict = {
    status: verification.status,
    checks,
    score: verification.status === "verified" ? 1 : 0,
    reasons: [...verification.reasons],
  };
  if (transportError) verdict.reasons.push(`transport error: ${transportError}`);
  if (resetError) verdict.reasons.push(`reset failed: ${resetError}`);

  const record: RunRecord = {
    runId,
    taskId,
    taskParams: { app: input.app.command, storePath: input.app.storePath, items: input.items },
    startedAt: new Date().toISOString(),
    steps,
    verdict,
    ...(input.simulated ? { simulated: true } : {}),
    ...(verification.status === "uncertain" ? { unresolvedState: verdict.reasons.join("; ") } : {}),
  };
  mkdirSync(join(input.runsDir, runId), { recursive: true });
  const extraTrace = resetError
    ? [
        {
          type: "recovery" as const,
          timestamp: new Date().toISOString(),
          event: `reset-failed: ${resetError}`,
          stateVersion: 0,
        },
      ]
    : [];
  const evidenceDir = writeRunEvidence(input.runsDir, record, extraTrace);

  return {
    status: verification.status,
    runId,
    evidenceDir,
    falseSuccess,
    claimed,
    persisted,
    missing,
    reasons: verdict.reasons,
  };
}
