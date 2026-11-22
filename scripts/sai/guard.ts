/**
 * Money and rate-limit guard. Free Explore tier only: any paid, overage, upgrade or plan signal, any
 * 429, and any quota/spend/credit limit stops the run with an exact reason. Nothing waits for a
 * daily reset and nothing retries automatically.
 */

export type SpendKind = "agent" | "convert" | "repair" | "judge" | "exec";

export interface GuardStopInfo {
  reason: string;
  detail: string;
}

export class GuardStop extends Error {
  readonly info: GuardStopInfo;
  constructor(info: GuardStopInfo) {
    super(`${info.reason}: ${info.detail}`);
    this.name = "GuardStop";
    this.info = info;
  }
}

/** Reserve the larger of 20% of the initial balance or 0.05 USD-equivalent free credit. */
export function reserveFor(initialUsd: number): number {
  return Math.max(0.2 * initialUsd, 0.05);
}

/** Per-protocol caps on billable calls. Direct Control setup/readback is not capped here. */
export const CALL_CAPS: Readonly<Record<Exclude<SpendKind, "exec">, number>> = {
  agent: 6, // five ordinary task starts plus one T4 source start
  convert: 1,
  repair: 1,
  judge: 5,
};

const PAID_SIGNAL =
  /\b(upgrade|overage|payment|pay[- ]as[- ]you[- ]go|add (?:a )?card|checkout|subscribe|subscription required|top[- ]?up|buy credits|billing)\b/i;

const LIMIT_CODES = new Set([
  "insufficient_credits",
  "free_computer_time_exhausted",
  "spend_cap_reached",
  "budget_exhausted",
  "rate_limited",
  "storage_quota_exceeded",
  "storage_balance_insufficient",
  "model_refused",
  "not_free_tier",
]);

export interface AccountView {
  free: boolean | null;
  usd: number | null;
  planTitle: string | null;
  userState: string | null;
}

export function parseAccount(json: unknown): AccountView {
  const o = (json ?? {}) as Record<string, unknown>;
  const plan = (o.plan ?? {}) as Record<string, unknown>;
  const credits = o.credits as Record<string, unknown> | null | undefined;
  return {
    free: typeof plan.free === "boolean" ? plan.free : null,
    usd: credits && typeof credits.usd === "number" ? credits.usd : null,
    planTitle: typeof plan.title === "string" ? plan.title : null,
    userState: typeof o.userState === "string" ? o.userState : null,
  };
}

export class Guard {
  initialUsd: number | null = null;
  lastUsd: number | null = null;
  readonly calls: Record<Exclude<SpendKind, "exec">, number> = {
    agent: 0,
    convert: 0,
    repair: 0,
    judge: 0,
  };
  stopped: GuardStopInfo | null = null;
  private readonly messageTimes: number[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  get reserveUsd(): number | null {
    return this.initialUsd === null ? null : reserveFor(this.initialUsd);
  }

  stop(info: GuardStopInfo): never {
    this.stopped ??= info;
    throw new GuardStop(info);
  }

  /** Called with every GET /account result. First sighting fixes the initial balance. */
  observeAccount(view: AccountView): void {
    if (view.free !== true) {
      this.stop({
        reason: "plan_not_free",
        detail: `account reports plan "${view.planTitle ?? "unknown"}" free=${String(view.free)}; free Explore tier only`,
      });
    }
    if (view.usd === null) {
      this.stop({
        reason: "credits_unknown",
        detail: "credits.usd not reported; refusing to spend blind",
      });
    }
    this.initialUsd ??= view.usd;
    this.lastUsd = view.usd;
  }

  /** Throws unless the balance is known, above the reserve, and the per-kind cap allows another call. */
  beforeSpend(kind: SpendKind): void {
    if (this.stopped) throw new GuardStop(this.stopped);
    if (kind === "exec") return;
    const reserve = this.reserveUsd;
    if (reserve === null || this.lastUsd === null) {
      this.stop({
        reason: "credits_unknown",
        detail: "no balance observation before a billable call",
      });
    }
    if (this.lastUsd <= reserve) {
      this.stop({
        reason: "credits_at_reserve",
        detail: `balance ${this.lastUsd.toFixed(2)} <= reserve ${reserve.toFixed(2)} USD-equivalent`,
      });
    }
    if (this.calls[kind] >= CALL_CAPS[kind]) {
      this.stop({
        reason: "call_cap",
        detail: `${kind} calls reached the pre-registered cap of ${CALL_CAPS[kind]}`,
      });
    }
    this.calls[kind] += 1;
  }

  /** Local guard under the vendor's 60 POST /message per hour free-plan limit (stay well below it). */
  beforeMessage(): void {
    const t = this.now();
    while (this.messageTimes.length > 0 && t - (this.messageTimes[0] as number) > 3_600_000) {
      this.messageTimes.shift();
    }
    if (this.messageTimes.length >= 20) {
      this.stop({
        reason: "local_rate_cap",
        detail: "20 POST /message calls in the last hour (vendor free limit is 60)",
      });
    }
    this.messageTimes.push(t);
  }

  /** Inspect any HTTP result; stop on 402, 429, paid signals and limit codes. */
  observeResponse(status: number, body: unknown, label: string): void {
    const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
    const code = typeof o.code === "string" ? o.code : typeof o.error === "string" ? o.error : null;
    const text = [o.error, o.errorText, o.message, o.reason, o.code]
      .filter((v): v is string => typeof v === "string")
      .join(" ");
    if (status === 429)
      this.stop({ reason: "http_429", detail: `${label}: ${text || "rate limited"}` });
    if (status === 402)
      this.stop({ reason: "http_402", detail: `${label}: ${text || "payment required"}` });
    if (code && LIMIT_CODES.has(code)) this.stop({ reason: code, detail: `${label}: ${text}` });
    if (text && PAID_SIGNAL.test(text) && status >= 400) {
      this.stop({ reason: "paid_signal", detail: `${label}: ${text.slice(0, 200)}` });
    }
  }
}
