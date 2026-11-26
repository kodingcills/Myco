/**
 * Track J (fastest reliable action path) - the action router.
 *
 * The agent asks for an ACTION ("set this cell", "export the document as CSV", "run this
 * shell command"); the router picks the ROUTE that performs it. Routes, in preference
 * order (`ROUTE_PREFERENCE`):
 *
 *   1. `api`    - the app's own API (LibreOffice UNO on the Linux path);
 *   2. `script` - a script or shell command, parsed and policy-checked, never a shell;
 *   3. `gui`    - the GUI path, the fallback (on the Linux path, Calc's input path).
 *
 * The choice is deterministic: for an action kind, the candidates are the routes the
 * kind supports (`ROUTE_TABLE`) that are available on this host (probed ONCE when the
 * router is built and recorded), in preference order. The first candidate runs; if it
 * FAILS, the next one runs (a fallback, logged with the failed route and its code). Every
 * decision is a `RouteDecision` in the run record: the route taken, the reason, the
 * fallback taken, each attempt's outcome and time.
 *
 * Three rules make the router unable to widen what the agent may touch:
 *
 * - **Every route goes through the policy.** Before a route runs, its request (paths read,
 *   paths written, the argv for the script route, or the raw command) goes to
 *   `ActionPolicy.check` (track O's seam, `./policy.ts`). A denial ends the action with the
 *   policy's code.
 * - **A denial never falls back.** The policy judges the TARGET, not the route: if the API
 *   route may not touch a path, the GUI route may not either. Only an execution failure
 *   (the route was allowed and broke) moves to the next route.
 * - **Typed actions carry no path.** `calc.set-cell` and `doc.export-csv` always act on
 *   the trial's own document; the agent cannot name another file for them. Only
 *   `shell.run` takes agent text, and only through the policy's default-deny parser.
 *
 * And one rule makes it unable to decide completion: an `ActResult` says whether the
 * route RAN, never whether the task is done. It has no verdict field. Completion is the
 * gate's decision from the persisted bytes the harness captures after the agent stops,
 * and the independent grader grades those bytes (`docs/product/fast-path.md`).
 *
 * Agent-facing results carry codes only.
 */

import type { ActionPolicy, PolicyCode, PolicyRequest, RouteName } from "./policy.ts";

export type { RouteName } from "./policy.ts";

export const ROUTE_PREFERENCE: readonly RouteName[] = ["api", "script", "gui"];

/** An action the agent may request. Typed actions name no path. */
export type ActionRequest =
  | {
      readonly kind: "calc.set-cell";
      readonly cell: string;
      readonly value: string;
      /** Store the document after the edit (default true). */
      readonly save?: boolean;
    }
  | { readonly kind: "doc.export-csv" }
  | { readonly kind: "shell.run"; readonly command: string };

export type ActionKind = ActionRequest["kind"];

/**
 * Which routes can perform each action kind, in no particular order (the router orders
 * them by `ROUTE_PREFERENCE`). A route missing here is never tried for that kind:
 * - `calc.set-cell`: UNO cell API + store, or Calc's input path. No allowed shell program
 *   can edit a workbook cell, so there is no script route.
 * - `doc.export-csv`: `soffice --headless --convert-to csv` into scratch (script).
 * - `shell.run`: the script route only; the command is the agent's text.
 */
export const ROUTE_TABLE: Readonly<Record<ActionKind, readonly RouteName[]>> = {
  "calc.set-cell": ["api", "gui"],
  "doc.export-csv": ["script"],
  "shell.run": ["script"],
};

export type RouteFailureCode = "ROUTE_FAILED" | "ROUTE_TIMEOUT" | "ROUTE_OUTPUT_ESCAPED";

/** What a route reports after it ran. A trace, never a verdict. */
export type RouteRun =
  | { readonly ok: true; readonly output?: string }
  | { readonly ok: false; readonly code: RouteFailureCode };

/** The resolved, policy-approved facts a route must act on. */
export interface ApprovedRequest {
  readonly request: PolicyRequest;
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  /** Script route: the argv the policy checked. The route runs exactly this. */
  readonly argv?: readonly string[];
}

/** One route's implementation on one host. */
export interface RouteExecutor {
  readonly route: RouteName;
  /** Probed once when the router is built; recorded in the run record. */
  available(): boolean;
  /** What this route would do for `action`, as a policy request; null if it cannot. */
  plan(action: ActionRequest): PolicyRequest | null;
  /** Perform `action`, touching only `approved`'s resolved paths. */
  run(action: ActionRequest, approved: ApprovedRequest): RouteRun;
}

export type ActCode =
  | "OK"
  | "BAD_REQUEST"
  | "NO_ROUTE"
  | "ALL_ROUTES_FAILED"
  | Exclude<PolicyCode, "ALLOWED">;

/** What the agent sees: whether the action ran, by which route, and a code. No verdict. */
export interface ActResult {
  readonly ok: boolean;
  readonly code: ActCode;
  readonly route: RouteName | null;
  /** Bounded output for read actions (CSV text, a listing). */
  readonly output?: string;
}

export type RouteReason =
  /** The most preferred route the action kind supports ran. */
  | "preferred-route"
  /** A more preferred supported route was unavailable on this host; the first available ran. */
  | "first-available-route"
  | "fallback-after-failure"
  | "policy-denied"
  | "all-routes-failed"
  | "no-route-available"
  | "bad-request";

export interface RouteAttempt {
  readonly route: RouteName;
  readonly outcome: "ok" | "failed" | "denied";
  readonly code: string;
  readonly ms: number;
}

/** One routing decision, as the run record keeps it. */
export interface RouteDecision {
  readonly seq: number;
  readonly kind: string;
  /** The agent's request as received (typed fields, or the shell command text). */
  readonly action: unknown;
  /** Supported and available routes, in preference order. */
  readonly candidates: readonly RouteName[];
  /** The route that performed the action, or null if none did. */
  readonly route: RouteName | null;
  readonly reason: RouteReason;
  /** The first route that was tried and failed before `route` ran; null without fallback. */
  readonly fallbackFrom: RouteName | null;
  readonly attempts: readonly RouteAttempt[];
  readonly code: ActCode;
  readonly ms: number;
}

export interface RouterOptions {
  readonly policy: ActionPolicy;
  readonly executors: readonly RouteExecutor[];
  /** Clock for attempt timing; injected in tests for determinism. */
  readonly now?: () => number;
}

export interface ActionRouter {
  act(request: unknown): ActResult;
  /** Every decision so far, in order. */
  log(): readonly RouteDecision[];
  /** Route availability as probed at construction. */
  readonly availability: Readonly<Record<RouteName, boolean>>;
  readonly policyId: string;
}

export const MAX_OUTPUT = 4096;
const CELL = /^[A-Z]{1,3}[1-9][0-9]{0,6}$/;
const MAX_VALUE = 256;

/**
 * Validate an agent request's shape. Exact keys only; a value that Calc's input path could
 * read as a formula (leading `=` or `@`, or a leading sign not followed by a plain number)
 * is refused, so no route evaluates agent-supplied expressions.
 */
export function parseAction(input: unknown): ActionRequest | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const r = input as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(",");
  if (r.kind === "calc.set-cell") {
    if (keys !== "cell,kind,value" && keys !== "cell,kind,save,value") return null;
    if (typeof r.cell !== "string" || !CELL.test(r.cell)) return null;
    if (typeof r.value !== "string" || r.value.length === 0 || r.value.length > MAX_VALUE)
      return null;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused, not matched.
    if (/[\u0000-\u001f\u007f]/.test(r.value) || /^[=@]/.test(r.value)) return null;
    if (/^[+-]/.test(r.value) && !/^[+-]\$?[0-9][0-9.,]*$/.test(r.value)) return null;
    if (r.save !== undefined && typeof r.save !== "boolean") return null;
    return r.save === undefined
      ? { kind: "calc.set-cell", cell: r.cell, value: r.value }
      : { kind: "calc.set-cell", cell: r.cell, value: r.value, save: r.save };
  }
  if (r.kind === "doc.export-csv") return keys === "kind" ? { kind: "doc.export-csv" } : null;
  if (r.kind === "shell.run") {
    if (keys !== "command,kind" || typeof r.command !== "string") return null;
    return { kind: "shell.run", command: r.command };
  }
  return null;
}

/** The candidate routes for `kind`: supported, available, in preference order. */
export function candidatesFor(
  kind: ActionKind,
  availability: Readonly<Record<RouteName, boolean>>,
): RouteName[] {
  const supported = ROUTE_TABLE[kind];
  return ROUTE_PREFERENCE.filter((route) => supported.includes(route) && availability[route]);
}

/** The most preferred route `kind` supports, regardless of availability. */
export function preferredFor(kind: ActionKind): RouteName {
  return ROUTE_PREFERENCE.find((route) => ROUTE_TABLE[kind].includes(route)) as RouteName;
}

function bound(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;
  return output.length <= MAX_OUTPUT
    ? output
    : `${output.slice(0, MAX_OUTPUT)}\n[truncated ${output.length - MAX_OUTPUT} chars]`;
}

export function createActionRouter(options: RouterOptions): ActionRouter {
  const now = options.now ?? (() => performance.now());
  const byRoute = new Map<RouteName, RouteExecutor>();
  for (const executor of options.executors) {
    if (byRoute.has(executor.route))
      throw new Error(`action router: two executors for route ${executor.route}`);
    byRoute.set(executor.route, executor);
  }
  const availability = Object.freeze({
    api: byRoute.get("api")?.available() === true,
    script: byRoute.get("script")?.available() === true,
    gui: byRoute.get("gui")?.available() === true,
  });
  const decisions: RouteDecision[] = [];

  function decide(
    entry: Omit<RouteDecision, "seq" | "ms">,
    started: number,
    result: ActResult,
  ): ActResult {
    decisions.push(Object.freeze({ seq: decisions.length + 1, ...entry, ms: now() - started }));
    return Object.freeze(result);
  }

  return {
    availability,
    policyId: options.policy.id,
    log: () => [...decisions],
    act(input) {
      const started = now();
      const action = parseAction(input);
      const kind =
        typeof input === "object" &&
        input !== null &&
        typeof (input as Record<string, unknown>).kind === "string"
          ? String((input as Record<string, unknown>).kind)
          : "unknown";
      if (action === null)
        return decide(
          {
            kind,
            action: input,
            candidates: [],
            route: null,
            reason: "bad-request",
            fallbackFrom: null,
            attempts: [],
            code: "BAD_REQUEST",
          },
          started,
          { ok: false, code: "BAD_REQUEST", route: null },
        );
      const candidates = candidatesFor(action.kind, availability);
      const attempts: RouteAttempt[] = [];
      let fallbackFrom: RouteName | null = null;
      for (const route of candidates) {
        const executor = byRoute.get(route) as RouteExecutor;
        const t0 = now();
        const request = executor.plan(action);
        if (request === null || request.route !== route || request.kind !== action.kind) {
          // An executor that cannot describe what it would do does not run (fail closed);
          // it counts as a failed route, so the next one may try.
          attempts.push({ route, outcome: "failed", code: "ROUTE_FAILED", ms: now() - t0 });
          fallbackFrom ??= route;
          continue;
        }
        const decision = options.policy.check(request);
        if (!decision.allow) {
          attempts.push({ route, outcome: "denied", code: decision.code, ms: now() - t0 });
          return decide(
            {
              kind: action.kind,
              action,
              candidates,
              route: null,
              reason: "policy-denied",
              fallbackFrom,
              attempts,
              code: decision.code,
            },
            started,
            { ok: false, code: decision.code, route: null },
          );
        }
        const run = executor.run(
          action,
          decision.argv === undefined
            ? { request, reads: decision.reads, writes: decision.writes }
            : { request, reads: decision.reads, writes: decision.writes, argv: decision.argv },
        );
        if (run.ok) {
          attempts.push({ route, outcome: "ok", code: "OK", ms: now() - t0 });
          const output = bound(run.output);
          return decide(
            {
              kind: action.kind,
              action,
              candidates,
              route,
              reason:
                fallbackFrom !== null
                  ? "fallback-after-failure"
                  : route === preferredFor(action.kind)
                    ? "preferred-route"
                    : "first-available-route",
              fallbackFrom,
              attempts,
              code: "OK",
            },
            started,
            output === undefined
              ? { ok: true, code: "OK", route }
              : { ok: true, code: "OK", route, output },
          );
        }
        attempts.push({ route, outcome: "failed", code: run.code, ms: now() - t0 });
        fallbackFrom ??= route;
      }
      const code: ActCode = candidates.length === 0 ? "NO_ROUTE" : "ALL_ROUTES_FAILED";
      return decide(
        {
          kind: action.kind,
          action,
          candidates,
          route: null,
          reason: candidates.length === 0 ? "no-route-available" : "all-routes-failed",
          fallbackFrom,
          attempts,
          code,
        },
        started,
        { ok: false, code, route: null },
      );
    },
  };
}

/** Per-route counts and totals for the run record. */
export interface RoutingSummary {
  readonly steps: number;
  readonly byRoute: Readonly<Record<RouteName | "none", number>>;
  readonly fallbacks: number;
  readonly denials: number;
  readonly routeMs: number;
}

export function summarizeRouting(log: readonly RouteDecision[]): RoutingSummary {
  const byRoute = { api: 0, script: 0, gui: 0, none: 0 };
  let fallbacks = 0;
  let denials = 0;
  let routeMs = 0;
  for (const d of log) {
    byRoute[d.route ?? "none"] += 1;
    if (d.reason === "fallback-after-failure") fallbacks += 1;
    if (d.reason === "policy-denied") denials += 1;
    routeMs += d.ms;
  }
  return { steps: log.length, byRoute, fallbacks, denials, routeMs };
}
