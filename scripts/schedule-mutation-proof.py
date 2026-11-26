#!/usr/bin/env python3
"""Mutation proofs for track S (scheduled and triggered runs). Not run in CI.

  python3 scripts/schedule-mutation-proof.py [label-substring ...]

Run from the repo root. Each mutant breaks one guard in src/schedule/ in place, runs
`npx vitest run test/schedule`, records whether the suite failed (killed) or passed
(SURVIVED), and restores the file (also on Ctrl-C). Exit 0 only when every mutant is
killed and every anchor matched exactly once.
"""
import subprocess
import sys

S="src/schedule/"
M=[
("idempotency: duplicate key check", S+"scheduler.ts", "if (this.opts.state.has(keySha))", "if (false)"),
("idempotency: claims reloaded on restart", S+"state.ts", "          throw new ScheduleStateError(\n            `claims.jsonl line ${i + 1} is malformed; refusing to start`,\n          );\n        this.remember(rec);", "          throw new ScheduleStateError(\n            `claims.jsonl line ${i + 1} is malformed; refusing to start`,\n          );\n        void rec;"),
("corrupt claims file refuses start", S+"state.ts", "          throw new ScheduleStateError(\n            `claims.jsonl line ${i + 1} does not parse; refusing to start`,\n          );", "          return;"),
("claim write failure: no run", S+"scheduler.ts", "if (!claim(true))", "if (!claim(true) && false)"),
("source must be enabled", S+"scheduler.ts", "if (!enabled) return", "if (false) return"),
("pause checked at admission", S+"scheduler.ts", 'if (this.opts.state.isPaused()) return this.skip(spec, req.source, keySha, "skipped", "PAUSED");', ""),
("pause re-checked after policies", S+"scheduler.ts", "if (this.opts.state.isPaused() || controller.signal.aborted)", "if (controller.signal.aborted)"),
("KILLED file aborts in-flight runs", S+"service.ts", 'if (state.pauseReason() === "KILLED") scheduler.kill();', ""),
("budget: runs/day", S+"scheduler.ts", ">= spec.budget.runsPerDay", ">= 1e9"),
("budget: concurrency", S+"scheduler.ts", "if (flights.size >= spec.budget.concurrency)", "if (false)"),
("budget: wall time", S+"scheduler.ts", "spec.budget.wallTimeS * 1000", "spec.budget.wallTimeS * 1e9"),
("policies required (non-empty)", S+"scheduler.ts", '      throw new Error("the scheduler requires at least one policy (policies are always applied)");', ""),
("policies applied to every source", S+"scheduler.ts", "for (const policy of this.opts.policies)", 'for (const policy of req.source === "cron" ? [] : this.opts.policies)'),
("throwing policy denies", S+"scheduler.ts", 'return end(plain("denied", "POLICY_ERROR"));', "continue;"),
("malformed policy decision denies", S+"scheduler.ts", 'return end(plain("denied", "POLICY_INVALID"));', "continue;"),
("verdict: accepted must be true", S+"scheduler.ts", 'v === "verified" && r.accepted === true &&', 'v === "verified" &&'),
("verdict: ORACLE_PASS required", S+"scheduler.ts", '&& reasonCodes.includes("ORACLE_PASS")', ""),
("verdict: result bound to this run id", S+"scheduler.ts", "if (reqRunId !== runId)", "if (false)"),
("verdict: non-verified never accepted", S+"scheduler.ts", 'if (v !== "verified" && r.accepted !== false)', "if (false)"),
("simulated unless explicitly false", S+"scheduler.ts", "result.simulated !== false", "result.simulated === true"),
("ledger failure -> error/LEDGER_FAILED", S+"scheduler.ts", "      out = {\n        ...row,", "      void {\n        ...row,"),
("failures notify", S+"scheduler.ts", 'if (out.status !== "verified" &&', "if (false &&"),
("missed slots: grace window", S+"scheduler.ts", "now - s <= this.graceMs", "true"),
("webhook: signature compared", S+"webhook.ts", "!timingSafeEqual(a, b)", "false"),
("webhook: signature binds schedule id", S+"webhook.ts", "`myco.schedule.webhook/v1\\n${scheduleId}\\n${delivery}\\n`", "`myco.schedule.webhook/v1\\n${delivery}\\n`"),
("webhook: unreadable secret refuses", S+"webhook.ts", '      return reply(res, 503, { code: "SECRET_UNAVAILABLE" });', '      expected = "00".repeat(32); void e;'),
("webhook: loopback only", S+"webhook.ts", "if (!(LOOPBACK_HOSTS as readonly string[]).includes(host))", "if (false)"),
("webhook: body cap", S+"webhook.ts", "if (size > max) {", "if (false) {"),
("config: unknown keys refused", S+"config.ts", 'if (!allowed.includes(k)) fail(`${path}.${k}`, "unknown key");', ""),
("config: secret screen", S+"config.ts", "export function looksLikeSecret(value: string): boolean {", "export function looksLikeSecret(value: string): boolean {\n  return false;"),
("config: refusal never echoes the value", S+"config.ts", 'fail(path, "looks like a secret value; reference a secrets file instead");', 'fail(`${path}=${v}`, "looks like a secret value; reference a secrets file instead");'),
("ledger key must be 64 hex", S+"service.ts", "if (!/^[0-9a-fA-F]{64}$/.test(value))", "if (false)"),
("inbox: regular files only (no symlinks)", S+"inbox.ts", "if (!st.isFile() || st.size", "if (st.size"),
("inbox: dotfiles ignored", S+"inbox.ts", "const NAME = /^[^.\\0/\\\\\\p{Cc}]", "const NAME = /^[^\\0/\\\\\\p{Cc}]"),
("manual: request carries schedule id only", S+"manual.ts", ' || Object.keys(v).join() !== "scheduleId"', ""),
("scripted executor rows simulated", S+"executor.ts", "      simulated: true,", "      simulated: false,"),
("cron: dom/dow OR rule", S+"cron.ts", "return dayOk || wdOk;", "return dayOk && wdOk;"),
("cron: scan bound", S+"cron.ts", "if (lastSlot - t > maxScanMinutes * MINUTE_MS) {", "if (false) {"),
]
only = sys.argv[1:]
rows=[]
for label,f,old,new in M:
    if only and not any(o in label for o in only): continue
    src=open(f).read()
    n=src.count(old)
    if n!=1:
        rows.append((label,f,"BAD-ANCHOR(%d)"%n)); continue
    open(f,"w").write(src.replace(old,new))
    try:
        r=subprocess.run(["npx","vitest","run","test/schedule"],capture_output=True,text=True)
        rows.append((label,f,"killed" if r.returncode!=0 else "SURVIVED"))
    finally:
        open(f,"w").write(src)
for r in rows:
    print(" | ".join(r))
bad = [r for r in rows if r[2] != "killed"]
print(f"{len(rows) - len(bad)}/{len(rows)} mutants killed")
sys.exit(1 if bad or not rows else 0)
