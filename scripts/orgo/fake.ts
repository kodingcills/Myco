import { object } from "./core.ts";

/**
 * In-memory stand-in for the Orgo HTTP API. It backs `--dry-run` and the unit tests so no live
 * call is ever needed; it is NOT evidence about the real service.
 *   free        Free account: only Medium is offered, and running copies hit HOURLY_LIMIT.
 *   free-quote  Running copies hit HOURLY_QUOTE_REQUIRED.
 *   free-*-open One copy operation unexpectedly succeeds.
 *   paid-gated  Small offered, but fork/clone answer 409 HOURLY_QUOTE_REQUIRED.
 *   paid-open   Small offered and fork/clone succeed.
 */
export type Scenario =
  | "free"
  | "free-quote"
  | "free-fork-open"
  | "free-clone-open"
  | "paid-gated"
  | "paid-open";

type FakeComputer = {
  id: string;
  name: string;
  status: string;
  kind: "source" | "fork" | "clone";
  boot: string;
  restarted: boolean;
};

export type FakeOptions = {
  scenario: Scenario;
  balanceCents?: number;
  /** Cents charged per create/fork/clone. */
  chargeCents?: number;
  /** Make the state probe on a fork reject, simulating a mid-E2 crash. */
  failOnForkBash?: boolean;
};

export function fakeOrgo(options: FakeOptions) {
  const workspaceId = "00000000-0000-4000-8000-000000000001";
  const computers = new Map<string, FakeComputer>();
  let balance = options.balanceCents ?? 300;
  let counter = 0;
  const calls: string[] = [];
  const nextId = () => {
    counter += 1;
    return `${counter.toString(16).padStart(8, "0")}-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const add = (name: string, kind: FakeComputer["kind"]) => {
    const computer: FakeComputer = {
      id: nextId(),
      name,
      status: "running",
      kind,
      boot: `boot-${counter}`,
      restarted: false,
    };
    computers.set(computer.id, computer);
    balance -= options.chargeCents ?? 2;
    return computer;
  };
  const free = options.scenario.startsWith("free");
  const sizes = free
    ? [{ name: "Medium", cpu: 2, ramGb: 8 }]
    : [
        { name: "Small", cpu: 0.5, ramGb: 4 },
        { name: "Medium", cpu: 2, ramGb: 8 },
      ];

  const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = init?.method ?? "GET";
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    const body = object(typeof init?.body === "string" ? JSON.parse(init.body) : {});
    if (method === "GET" && path === "/api/credits") {
      return json(200, {
        balanceCents: balance,
        tier: free ? "free" : "starter",
      });
    }
    if (method === "GET" && path === "/api/credits/transactions") {
      return json(200, {
        transactions: [
          {
            amount_cents: 300,
            balance_after_cents: 300,
            type: "initial_grant",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
    }
    if (method === "GET" && path === "/api/workspaces") {
      return json(200, {
        workspaces: [{ id: workspaceId, name: "fake workspace", role: "owner" }],
      });
    }
    if (method === "GET" && path === "/api/billing/compute") {
      return json(200, {
        mode: free ? "free" : "hourly",
        entries: sizes.map((size) => ({
          sku: { name: size.name, specification: { cpu: size.cpu, ramGb: size.ramGb, diskGb: 20 } },
          offer: { price: { activeMicrosPerHour: size.name === "Small" ? 23_000 : 55_000 } },
        })),
      });
    }
    if (method === "GET" && path === `/api/workspaces/${workspaceId}`) {
      return json(200, {
        id: workspaceId,
        desktops: [...computers.values()].map(({ id, name, status }) => ({ id, name, status })),
      });
    }
    if (method === "POST" && path === "/api/computers") {
      if (free && computers.size >= 1)
        return json(403, { error: "Free includes 1 computer.", code: "HOURLY_LIMIT" });
      const size = sizes[0];
      if (
        !size ||
        body.os !== "linux" ||
        body.cpu !== size.cpu ||
        body.ram !== size.ramGb ||
        body.billing_mode !== "hourly" ||
        body.ends_in_hours !== 1
      ) {
        return json(400, { error: "Unexpected create configuration" });
      }
      const computer = add(String(body.name), "source");
      return json(201, {
        id: computer.id,
        name: computer.name,
        status: "running",
        instance_id: "fake0001",
        cpu: size.cpu,
        ram: size.ramGb,
      });
    }
    const match = /^\/api\/computers\/([^/]+)(?:\/([a-z]+))?$/.exec(path);
    if (!match) return json(404, { error: "No such API path.", code: "NOT_FOUND" });
    const computer = computers.get(match[1] ?? "");
    if (!computer) return json(404, { error: "No computer", code: "NOT_FOUND" });
    const action = match[2];
    if (method === "DELETE" && !action) {
      computers.delete(computer.id);
      return json(200, { success: true });
    }
    if (method === "GET" && !action) {
      return json(200, {
        id: computer.id,
        name: computer.name,
        status: computer.status,
        fly_instance_id: computer.boot,
        auto_stop_minutes: computer.kind === "fork" ? 0 : 30,
      });
    }
    if (method !== "POST") return json(405, {});
    switch (action) {
      case "fork":
      case "clone": {
        if (computer.status !== "running") {
          return action === "fork"
            ? json(409, { error: "Not running", code: "NOT_FORKABLE" })
            : json(400, { error: "No host on record", code: "NOT_CLONABLE" });
        }
        if (options.scenario === "paid-gated" || options.scenario === "free-quote") {
          return json(409, {
            error: "A copy needs its own purchase.",
            code: "HOURLY_QUOTE_REQUIRED",
          });
        }
        if (free && computers.size >= 1 && options.scenario !== `free-${action}-open`)
          return json(403, { error: "Free includes 1 computer.", code: "HOURLY_LIMIT" });
        // Docs: forks are auto-named `agent-N (fork)`, so they never carry the myco-discovery- prefix.
        const copy = add(
          typeof body.name === "string" ? body.name : `agent-${counter + 1} (${action})`,
          action,
        );
        return json(201, { id: copy.id, name: copy.name, status: "running" });
      }
      case "stop":
        computer.status = "frozen";
        return json(200, { success: true });
      case "start":
        computer.status = "running";
        computer.restarted = true;
        computer.boot = `boot-restart-${counter}`;
        return json(200, { success: true, status: "running" });
      case "suspend":
        return json(409, {
          error: "Use Stop to save your files and release hourly compute.",
          code: "HOURLY_USE_STOP",
        });
      case "bash": {
        if (computer.status !== "running")
          return json(409, { error: "asleep", code: "computer_asleep" });
        const command = String(body.command ?? "");
        if (
          options.failOnForkBash &&
          computer.kind === "fork" &&
          command.includes("state.py read")
        ) {
          throw new Error("simulated crash");
        }
        let output = "ok";
        if (command.includes("state.py read")) {
          const live = computer.kind !== "clone" && !computer.restarted;
          output = JSON.stringify({
            boot: computer.boot,
            disk: "disk-marker",
            tmpfs: live ? "memory" : null,
            processMarker: live,
            counter: live ? "100" : null,
            later: live ? "101" : null,
          });
        } else if (command.includes("state.py gap")) {
          output = JSON.stringify({ beats: 100, maxGapMs: 2100 });
        } else if (command.startsWith("date ")) {
          output = String(Date.now());
        } else if (command.includes("myco-diverge")) {
          output = computer.kind;
        }
        return json(200, { success: true, output, exit_code: 0 });
      }
      default:
        return json(404, { error: "No such API path.", code: "NOT_FOUND" });
    }
  };
  return {
    request: request as typeof fetch,
    computers,
    calls,
    workspaceId,
    balance: () => balance,
  };
}
