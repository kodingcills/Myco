/**
 * One agent turn, end to end: start (wait:false), long-poll events, handle approvals under a policy,
 * read the turn record. One attempt, no retries. Launch-to-terminal wall time is measured here.
 */

import { type Approval, type ApprovalPolicy, decideApproval } from "./approvals.ts";
import type { SaiClient } from "./client.ts";
import { GuardStop } from "./guard.ts";

export interface ApprovalEvent {
  approvalType: string | null;
  isLinkOnly: boolean;
  decision: "capture_and_abort" | "approve" | "abort";
  reason: string;
  /** Path of the private capture file for link-only approvals (never the URL). */
  captureFile: string | null;
  embedsToken: boolean | null;
}

export interface TurnOutcome {
  started: boolean;
  startStatus: number | null;
  startBody: unknown;
  sessionId: string | null;
  turnId: string | null;
  machineId: string | null;
  launchToTerminalMs: number | null;
  firstEventMs: number | null;
  endedBy: "idle" | "error" | "aborted_by_policy" | "deadline" | "start_refused";
  turn: Record<string, unknown> | null;
  finalText: string;
  progress: string[];
  approvals: ApprovalEvent[];
  eventsUsage: unknown;
  creditsBefore: number | null;
  creditsAfter: number | null;
  creditDelta: number | null;
}

export interface TurnRequest {
  stage: string;
  label: string;
  message: string;
  machineId: string;
  options?: Record<string, unknown>;
  policy: ApprovalPolicy;
  deadlineMs: number;
  sessionId?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function runAgentTurn(client: SaiClient, req: TurnRequest): Promise<TurnOutcome> {
  const out: TurnOutcome = {
    started: false,
    startStatus: null,
    startBody: null,
    sessionId: null,
    turnId: null,
    machineId: null,
    launchToTerminalMs: null,
    firstEventMs: null,
    endedBy: "start_refused",
    turn: null,
    finalText: "",
    progress: [],
    approvals: [],
    eventsUsage: null,
    creditsBefore: null,
    creditsAfter: null,
    creditDelta: null,
  };
  const before = await client.account(req.stage, `${req.label}:balance-before`);
  out.creditsBefore = before.usd;

  const t0 = Date.now();
  const start = await client.call({
    stage: req.stage,
    label: `${req.label}:message`,
    method: "POST",
    path: "/v1/agents/message",
    spend: "agent",
    body: {
      message: req.message,
      machineId: req.machineId,
      wait: false,
      ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      ...(req.options ? { options: req.options } : {}),
    },
  });
  out.startStatus = start.status;
  out.startBody = start.body;
  const sb = (start.body ?? {}) as Record<string, unknown>;
  if (start.status !== 202 || typeof sb.sessionId !== "string" || typeof sb.turnId !== "string") {
    out.endedBy = "start_refused";
    return out;
  }
  out.started = true;
  out.sessionId = sb.sessionId;
  out.turnId = sb.turnId;
  out.machineId = typeof sb.machineId === "string" ? sb.machineId : null;

  let cursor: string | undefined;
  let ended: TurnOutcome["endedBy"] | null = null;
  while (ended === null) {
    if (Date.now() - t0 > req.deadlineMs) {
      await client.call({
        stage: req.stage,
        label: `${req.label}:abort-deadline`,
        method: "POST",
        path: "/v1/agents/abort",
        body: { sessionId: out.sessionId },
      });
      ended = "deadline";
      break;
    }
    const qs = `sessionId=${encodeURIComponent(out.sessionId)}&wait=30${cursor ? `&since=${encodeURIComponent(cursor)}` : ""}`;
    const ev = await client.call({
      stage: req.stage,
      label: `${req.label}:events`,
      path: `/v1/agents/events?${qs}`,
      hideQuery: true,
      timeoutMs: 75_000,
    });
    if (!ev.ok) {
      if (ev.status === null) {
        await sleep(2000);
        continue;
      }
      throw new GuardStop({
        reason: "events_error",
        detail: `GET /events returned ${String(ev.status)} during ${req.label}`,
      });
    }
    const body = ev.body as Record<string, unknown>;
    if (out.firstEventMs === null && Array.isArray(body.events) && body.events.length > 0) {
      out.firstEventMs = Date.now() - t0;
    }
    if (typeof body.cursor === "string") cursor = body.cursor;
    if (body.usage !== undefined) out.eventsUsage = body.usage;
    for (const e of (Array.isArray(body.events) ? body.events : []) as Array<
      Record<string, unknown>
    >) {
      if (e.type === "data-progress") {
        const d = e.data as { text?: string } | undefined;
        if (typeof d?.text === "string") out.progress.push(d.text);
      }
    }
    if (typeof body.text === "string") out.finalText = body.text;
    const status = body.status;
    if (status === "needs_approval") {
      const approval = (body.approval ?? {}) as Approval;
      const decision = decideApproval(approval, req.policy);
      if (decision.action === "approve" && approval.approvalId) {
        client.ledger.append({
          stage: req.stage,
          label: `${req.label}:approval`,
          kind: "event",
          note: `approving ordinary approval: ${decision.reason}`,
          data: { approvalType: approval.approvalType, command: approval.command },
        });
        out.approvals.push({
          approvalType: approval.approvalType ?? null,
          isLinkOnly: false,
          decision: "approve",
          reason: decision.reason,
          captureFile: null,
          embedsToken: null,
        });
        await client.call({
          stage: req.stage,
          label: `${req.label}:approve`,
          method: "POST",
          path: "/v1/agents/approve",
          body: { approvalId: approval.approvalId, response: "yes" },
        });
      } else {
        const linkOnly = decision.action === "capture_and_abort";
        out.approvals.push({
          approvalType: approval.approvalType ?? null,
          isLinkOnly: linkOnly,
          decision: decision.action === "approve" ? "abort" : decision.action,
          reason: decision.action === "approve" ? "missing approvalId" : decision.reason,
          captureFile: decision.action === "capture_and_abort" ? decision.file : null,
          embedsToken: decision.action === "capture_and_abort" ? decision.embedsToken : null,
        });
        client.ledger.append({
          stage: req.stage,
          label: `${req.label}:approval`,
          kind: "event",
          note: linkOnly
            ? `LINK-ONLY approval (${approval.approvalType ?? "unknown"}): URL captured to a private file outside the repo; task aborted; never opened or answered`
            : `approval not allowed by policy; aborting: ${decision.action === "abort" ? decision.reason : ""}`,
        });
        await client.call({
          stage: req.stage,
          label: `${req.label}:abort-approval`,
          method: "POST",
          path: "/v1/agents/abort",
          body: { sessionId: out.sessionId },
        });
        ended = "aborted_by_policy";
      }
    } else if (status === "idle" || status === "error") {
      // The first poll can see the previous turn's idle state; only accept a terminal turn record.
      const peek = await client.call({
        stage: req.stage,
        label: `${req.label}:turn-peek`,
        path: `/v1/agents/turns/${out.turnId}`,
      });
      const ps = ((peek.body ?? {}) as Record<string, unknown>).status;
      if (status === "error" || ps === "succeeded" || ps === "failed" || ps === "finalizing") {
        ended = status;
      } else {
        await sleep(3000);
      }
    }
  }
  out.endedBy = ended;

  // Read the turn record until it is terminal (finalizing is not done).
  const tDeadline = Date.now() + 120_000;
  while (Date.now() < tDeadline) {
    const tr = await client.call({
      stage: req.stage,
      label: `${req.label}:turn`,
      path: `/v1/agents/turns/${out.turnId}`,
    });
    if (tr.ok && tr.body && typeof tr.body === "object") {
      out.turn = tr.body as Record<string, unknown>;
      const s = out.turn.status;
      if (s === "succeeded" || s === "failed") break;
    }
    await sleep(3000);
  }
  out.launchToTerminalMs = Date.now() - t0;
  const after = await client.account(req.stage, `${req.label}:balance-after`);
  out.creditsAfter = after.usd;
  out.creditDelta =
    out.creditsBefore !== null && after.usd !== null
      ? Number((out.creditsBefore - after.usd).toFixed(4))
      : null;
  return out;
}
