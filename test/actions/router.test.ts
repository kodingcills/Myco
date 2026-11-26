/**
 * Track J: the action router's routing table, fallback, policy denial and result shape,
 * with fake routes (no LibreOffice, no model).
 */
import { describe, expect, it } from "vitest";
import type { ActionPolicy, PolicyRequest } from "../../src/actions/policy.ts";
import {
  type ActionRequest,
  candidatesFor,
  createActionRouter,
  MAX_OUTPUT,
  parseAction,
  preferredFor,
  ROUTE_PREFERENCE,
  ROUTE_TABLE,
  type RouteExecutor,
  type RouteName,
  type RouteRun,
  summarizeRouting,
} from "../../src/actions/router.ts";

interface FakeRoute extends RouteExecutor {
  readonly runs: ActionRequest[];
}

function fake(
  route: RouteName,
  opts: { available?: boolean; result?: RouteRun; plan?: "null" | "wrong-route" } = {},
): FakeRoute {
  const runs: ActionRequest[] = [];
  return {
    route,
    runs,
    available: () => opts.available ?? true,
    plan(action) {
      if (!ROUTE_TABLE[action.kind].includes(route)) return null;
      if (opts.plan === "null") return null;
      return {
        route: opts.plan === "wrong-route" ? "gui" : route,
        kind: action.kind,
        reads: ["doc.xlsx"],
        writes: action.kind === "calc.set-cell" ? ["doc.xlsx"] : [],
        ...(route === "script"
          ? action.kind === "shell.run"
            ? { command: action.command }
            : { argv: ["soffice"] }
          : {}),
      };
    },
    run(action) {
      runs.push(action);
      return opts.result ?? { ok: true };
    },
  };
}

const allow: ActionPolicy = {
  id: "test.allow",
  check: (r) => ({ allow: true, code: "ALLOWED", reads: r.reads, writes: r.writes }),
};
function denyRoute(route: RouteName): ActionPolicy & { seen: PolicyRequest[] } {
  const seen: PolicyRequest[] = [];
  return {
    id: "test.deny",
    seen,
    check: (r) => {
      seen.push(r);
      return r.route === route
        ? { allow: false, code: "PATH_OUTSIDE_WORKSPACE" }
        : { allow: true, code: "ALLOWED", reads: r.reads, writes: r.writes };
    },
  };
}

let tick = 0;
const clock = () => {
  tick += 1;
  return tick;
};
const SET = { kind: "calc.set-cell", cell: "B12", value: "REVISED-1" } as const;

describe("routing table", () => {
  it("prefers app API, then script, then GUI", () => {
    expect(ROUTE_PREFERENCE).toEqual(["api", "script", "gui"]);
  });

  it.each([
    ["calc.set-cell", "api"],
    ["doc.export-csv", "script"],
    ["shell.run", "script"],
  ] as const)("%s is routed to %s when every route is up", (kind, route) => {
    const routes = [fake("api"), fake("script"), fake("gui")];
    const router = createActionRouter({ policy: allow, executors: routes, now: clock });
    const request =
      kind === "calc.set-cell" ? SET : kind === "shell.run" ? { kind, command: "ls" } : { kind };
    const result = router.act(request);
    expect(result).toEqual({ ok: true, code: "OK", route });
    const [decision] = router.log();
    expect(decision).toMatchObject({
      seq: 1,
      kind,
      route,
      reason: "preferred-route",
      fallbackFrom: null,
      code: "OK",
    });
    expect(preferredFor(kind)).toBe(route);
  });

  it("set-cell has no script route: no allowed program edits a workbook cell", () => {
    expect(ROUTE_TABLE["calc.set-cell"]).not.toContain("script");
    expect(candidatesFor("calc.set-cell", { api: true, script: true, gui: true })).toEqual([
      "api",
      "gui",
    ]);
  });

  it("an unavailable API route is skipped and logged as first-available-route", () => {
    const api = fake("api", { available: false });
    const gui = fake("gui");
    const router = createActionRouter({ policy: allow, executors: [api, gui], now: clock });
    expect(router.availability).toEqual({ api: false, script: false, gui: true });
    expect(router.act(SET)).toMatchObject({ ok: true, route: "gui" });
    expect(api.runs).toEqual([]);
    expect(router.log()[0]).toMatchObject({
      candidates: ["gui"],
      route: "gui",
      reason: "first-available-route",
      fallbackFrom: null,
    });
  });

  it("availability is probed once, at construction", () => {
    let probes = 0;
    const api = {
      ...fake("api"),
      available: () => {
        probes += 1;
        return true;
      },
    };
    const router = createActionRouter({ policy: allow, executors: [api], now: clock });
    router.act(SET);
    router.act(SET);
    expect(probes).toBe(1);
  });

  it("is deterministic: the same inputs give the same log", () => {
    const run = () => {
      let t = 0;
      const router = createActionRouter({
        policy: allow,
        executors: [fake("api", { result: { ok: false, code: "ROUTE_FAILED" } }), fake("gui")],
        now: () => (t += 1),
      });
      router.act(SET);
      router.act({ kind: "shell.run", command: "ls" });
      router.act({ kind: "nope" });
      return JSON.stringify(router.log());
    };
    expect(run()).toBe(run());
  });

  it("refuses two executors for one route", () => {
    expect(() =>
      createActionRouter({ policy: allow, executors: [fake("api"), fake("api")] }),
    ).toThrow(/two executors/);
  });
});

describe("fallback on API failure", () => {
  it("falls back to the GUI and logs route, reason and the failed route", () => {
    const api = fake("api", { result: { ok: false, code: "ROUTE_FAILED" } });
    const gui = fake("gui");
    const router = createActionRouter({ policy: allow, executors: [api, gui], now: clock });
    expect(router.act(SET)).toEqual({ ok: true, code: "OK", route: "gui" });
    expect(api.runs).toHaveLength(1);
    expect(gui.runs).toHaveLength(1);
    const [d] = router.log();
    expect(d).toMatchObject({
      route: "gui",
      reason: "fallback-after-failure",
      fallbackFrom: "api",
      candidates: ["api", "gui"],
    });
    expect(d?.attempts.map((a) => [a.route, a.outcome, a.code])).toEqual([
      ["api", "failed", "ROUTE_FAILED"],
      ["gui", "ok", "OK"],
    ]);
  });

  it("a timeout falls back the same way", () => {
    const router = createActionRouter({
      policy: allow,
      executors: [fake("api", { result: { ok: false, code: "ROUTE_TIMEOUT" } }), fake("gui")],
      now: clock,
    });
    expect(router.act(SET).route).toBe("gui");
    expect(router.log()[0]?.attempts[0]?.code).toBe("ROUTE_TIMEOUT");
  });

  it.each(["null", "wrong-route"] as const)(
    "an executor whose plan is %s never runs and counts as failed",
    (plan) => {
      const api = fake("api", { plan });
      const gui = fake("gui");
      const router = createActionRouter({ policy: allow, executors: [api, gui], now: clock });
      expect(router.act(SET).route).toBe("gui");
      expect(api.runs).toEqual([]);
      expect(router.log()[0]?.fallbackFrom).toBe("api");
    },
  );

  it("every route failing is ALL_ROUTES_FAILED, never ok", () => {
    const fail = { ok: false, code: "ROUTE_FAILED" } as const;
    const router = createActionRouter({
      policy: allow,
      executors: [fake("api", { result: fail }), fake("gui", { result: fail })],
      now: clock,
    });
    expect(router.act(SET)).toEqual({ ok: false, code: "ALL_ROUTES_FAILED", route: null });
    expect(router.log()[0]).toMatchObject({ reason: "all-routes-failed", fallbackFrom: "api" });
  });

  it("no available route is NO_ROUTE", () => {
    const router = createActionRouter({
      policy: allow,
      executors: [fake("api", { available: false })],
      now: clock,
    });
    expect(router.act(SET)).toEqual({ ok: false, code: "NO_ROUTE", route: null });
    expect(router.log()[0]?.reason).toBe("no-route-available");
  });
});

describe("policy denial", () => {
  it("every route goes through the policy before it runs", () => {
    const policy = denyRoute("none" as RouteName);
    const router = createActionRouter({
      policy,
      executors: [fake("api"), fake("script"), fake("gui")],
      now: clock,
    });
    router.act(SET);
    router.act({ kind: "doc.export-csv" });
    router.act({ kind: "shell.run", command: "ls" });
    expect(policy.seen.map((r) => [r.route, r.kind])).toEqual([
      ["api", "calc.set-cell"],
      ["script", "doc.export-csv"],
      ["script", "shell.run"],
    ]);
  });

  it("a denied API route does NOT fall back to the GUI (no widening)", () => {
    const api = fake("api");
    const gui = fake("gui");
    const policy = denyRoute("api");
    const router = createActionRouter({ policy, executors: [api, gui], now: clock });
    expect(router.act(SET)).toEqual({ ok: false, code: "PATH_OUTSIDE_WORKSPACE", route: null });
    expect(api.runs).toEqual([]);
    expect(gui.runs).toEqual([]);
    expect(policy.seen.map((r) => r.route)).toEqual(["api"]);
    expect(router.log()[0]).toMatchObject({ reason: "policy-denied", route: null });
  });

  it("a denial after a failed route still stops (the fallback is denied, not skipped)", () => {
    const api = fake("api", { result: { ok: false, code: "ROUTE_FAILED" } });
    const gui = fake("gui");
    const router = createActionRouter({
      policy: denyRoute("gui"),
      executors: [api, gui],
      now: clock,
    });
    expect(router.act(SET)).toMatchObject({ ok: false, code: "PATH_OUTSIDE_WORKSPACE" });
    expect(gui.runs).toEqual([]);
    expect(router.log()[0]).toMatchObject({ reason: "policy-denied", fallbackFrom: "api" });
  });

  it("routes receive the policy's resolved paths and argv, not their own spelling", () => {
    let seen: unknown;
    const script: RouteExecutor = {
      ...fake("script"),
      run: (_a, approved) => {
        seen = approved;
        return { ok: true };
      },
    };
    const policy: ActionPolicy = {
      id: "test.rewrite",
      check: () => ({
        allow: true,
        code: "ALLOWED",
        reads: ["/resolved/r"],
        writes: [],
        argv: ["ls", "/resolved/r"],
      }),
    };
    createActionRouter({ policy, executors: [script], now: clock }).act({
      kind: "shell.run",
      command: "ls r",
    });
    expect(seen).toMatchObject({ reads: ["/resolved/r"], argv: ["ls", "/resolved/r"] });
  });
});

describe("requests and results", () => {
  it.each([
    [null],
    [[]],
    ["calc.set-cell"],
    [{ kind: "calc.set-cell", cell: "B12" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "x", path: "/etc/passwd" }],
    [{ kind: "calc.set-cell", cell: "b12", value: "x" }],
    [{ kind: "calc.set-cell", cell: "B0", value: "x" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "=WEBSERVICE(1)" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "@A1" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "+A1" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "-1+A1" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "a\nb" }],
    [{ kind: "calc.set-cell", cell: "B12", value: "x".repeat(257) }],
    [{ kind: "calc.set-cell", cell: "B12", value: "x", save: "yes" }],
    [{ kind: "doc.export-csv", path: "/etc/passwd" }],
    [{ kind: "shell.run" }],
    [{ kind: "shell.run", command: ["ls"] }],
    [{ kind: "shell.run", command: "ls", cwd: "/" }],
    [{ kind: "doc.open", path: "x" }],
  ])("refuses %j as BAD_REQUEST without running a route", (request) => {
    const routes = [fake("api"), fake("script"), fake("gui")];
    const router = createActionRouter({ policy: allow, executors: routes, now: clock });
    expect(router.act(request)).toEqual({ ok: false, code: "BAD_REQUEST", route: null });
    expect(routes.flatMap((r) => r.runs)).toEqual([]);
    expect(router.log()[0]?.reason).toBe("bad-request");
  });

  it.each(["4544", "-12", "$43446.57", "2024-08-10", "REVISED-1", "+5"])(
    "accepts the plain value %j",
    (value) => {
      expect(parseAction({ kind: "calc.set-cell", cell: "C46", value })).not.toBeNull();
    },
  );

  it("a result never carries a verdict: only ok, code, route and output", () => {
    const routes = [fake("api"), fake("script", { result: { ok: true, output: "a,b\n" } })];
    const router = createActionRouter({ policy: allow, executors: routes, now: clock });
    for (const result of [router.act(SET), router.act({ kind: "doc.export-csv" })])
      for (const key of Object.keys(result))
        expect(["ok", "code", "route", "output"]).toContain(key);
  });

  it("bounds output", () => {
    const routes = [fake("script", { result: { ok: true, output: "x".repeat(MAX_OUTPUT + 10) } })];
    const out = createActionRouter({ policy: allow, executors: routes, now: clock }).act({
      kind: "doc.export-csv",
    }).output as string;
    expect(out.startsWith("x".repeat(MAX_OUTPUT))).toBe(true);
    expect(out).toContain("[truncated 10 chars]");
  });

  it("summarizes routes, fallbacks and denials for the run record", () => {
    const router = createActionRouter({
      policy: denyRoute("script"),
      executors: [
        fake("api", { result: { ok: false, code: "ROUTE_FAILED" } }),
        fake("gui"),
        fake("script"),
      ],
      now: clock,
    });
    router.act(SET);
    router.act({ kind: "shell.run", command: "ls" });
    router.act({ kind: "x" });
    expect(summarizeRouting(router.log())).toMatchObject({
      steps: 3,
      byRoute: { api: 0, script: 0, gui: 1, none: 2 },
      fallbacks: 1,
      denials: 1,
    });
  });
});
