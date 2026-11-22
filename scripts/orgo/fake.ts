import { object } from "./core.ts";

/**
 * In-memory stand-in for the Orgo HTTP API. It backs `--dry-run` and the unit tests so no live
 * call is ever needed; it is NOT evidence about the real service.
 *   free        Free account: only a Medium is offered (what the real account returned).
 *   paid-gated  Small offered, but fork/clone answer 409 HOURLY_QUOTE_REQUIRED.
 *   paid-open   Small offered and fork/clone succeed.
 */
export type Scenario = "free" | "paid-gated" | "paid-open";

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
  const sizes =
    options.scenario === "free"
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
        tier: options.scenario === "free" ? "free" : "starter",
      });
    }
    if (method === "GET" && path === "/api/workspaces") {
      return json(200, {
        workspaces: [{ id: workspaceId, name: "fake workspace", role: "owner" }],
      });
    }
    if (method === "GET" && path === "/api/billing/compute") {
      return json(200, {
        mode: options.scenario === "free" ? "free" : "hourly",
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
      if (options.scenario === "free")
        return json(403, { error: "Free includes 1 computer.", code: "HOURLY_LIMIT" });
      const computer = add(String(body.name), "source");
      return json(201, {
        id: computer.id,
        name: computer.name,
        status: "running",
        instance_id: "fake0001",
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
          return json(409, {
            error: "Not running",
            code: action === "fork" ? "NOT_FORKABLE" : "computer_asleep",
          });
        }
        if (options.scenario === "paid-gated") {
          return json(409, {
            error: "A copy needs its own purchase.",
            code: "HOURLY_QUOTE_REQUIRED",
          });
        }
        const copy = add(
          typeof body.name === "string" ? body.name : `${computer.name} (${action})`,
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
