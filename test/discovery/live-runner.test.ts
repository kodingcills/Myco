import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import {
  type DesktopAction,
  type DesktopSession,
  type LiveVerification,
  runDirectionALive,
} from "../../src/discovery/live-runner.ts";
import { MockDesktop } from "../../src/discovery/mock-desktop.ts";
import type { PreflightProbe } from "../../src/discovery/preflight.ts";

const probe: PreflightProbe = {
  coordinatorGo: true,
  hostLock: true,
  runtimeReachable: true,
  guestReady: true,
  appPresent: true,
  storeReadable: true,
  oraclePresent: true,
  guestClean: true,
};

const app = {
  command: "python3",
  args: ["myco_todo.py"],
  storePath: "/tmp/store.json",
  savePoint: { x: 210, y: 284 },
};

function verify(
  persisted: { items: readonly string[] },
  intent: { items: readonly string[] },
): LiveVerification {
  const missing = intent.items.filter((item) => !persisted.items.includes(item));
  return missing.length === 0
    ? { status: "verified", reasons: ["all items persisted"] }
    : { status: "refuted", reasons: [`missing: ${missing.join(", ")}`] };
}

function runsDir(): string {
  return mkdtempSync(join(tmpdir(), "myco-live-"));
}

describe("Direction A live runner", () => {
  it("verifies a clean run and writes schema-valid evidence", async () => {
    const dir = runsDir();
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app,
      items: ["update the release notes", "write the incident summary"],
      verify,
      runsDir: dir,
      runId: "clean",
    });
    expect(result.status).toBe("verified");
    expect(result.falseSuccess).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.claimed).toBe("saved 2 item(s)");
    const traceText = readFileSync(join(dir, "clean", "trace.jsonl"), "utf8");
    expect(traceText).toContain('"kind":"typeTextGlobal"');
    expect(traceText).toContain('"kind":"clickAt"');
    expect(traceText).toContain('"x":210');
    expect(traceText).toContain('"y":284');
    const record: unknown = JSON.parse(readFileSync(join(dir, "clean", "result.json"), "utf8"));
    expect(validateSchema(record, resultRecordSchema)).toEqual([]);
    const trace = readFileSync(join(dir, "clean", "trace.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line): unknown => JSON.parse(line));
    for (const event of trace) expect(validateSchema(event, traceEventSchema)).toEqual([]);
  });

  it("catches the seeded false success: the UI says saved, the store disagrees", async () => {
    const dir = runsDir();
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app,
      items: [
        "bug: login page crashes on save",
        "BUG: token expires too early",
        "update the release notes",
        "write the incident summary",
      ],
      verify,
      runsDir: dir,
      runId: "seeded",
    });
    expect(result.status).toBe("refuted");
    expect(result.falseSuccess).toBe(true);
    expect(result.claimed).toBe("saved 4 item(s)");
    expect(result.persisted).toEqual(["update the release notes", "write the incident summary"]);
    expect(result.missing).toEqual([
      "bug: login page crashes on save",
      "BUG: token expires too early",
    ]);
  });

  it("aborts before creating a session when the preflight fails", async () => {
    const transport = new MockDesktop();
    const result = await runDirectionALive({
      transport,
      probe: { ...probe, coordinatorGo: false },
      app,
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("aborted");
    expect(result.abort).toContain("Coordinator GO for this host window");
    expect(transport.createCount).toBe(0);
  });

  it("reports uncertain, never success, when the transport fails mid-run", async () => {
    const transport = new MockDesktop({ failAtAction: 3 });
    const result = await runDirectionALive({
      transport,
      probe,
      app,
      items: ["one", "two"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("uncertain");
    expect(result.falseSuccess).toBe(false);
    expect(transport.destroyCount).toBe(1);
  });

  it("does not call a refuted run a false success when the app never claimed success", async () => {
    const inner = new MockDesktop();
    const transport = {
      create: () => inner.create(),
      observe: async () => ({
        ...(await inner.observe()),
        statusText: "error: could not save",
      }),
      act: (session: DesktopSession, action: DesktopAction) => inner.act(session, action),
      readFile: (session: DesktopSession, path: string) => inner.readFile(session, path),
      reset: () => inner.reset(),
      destroy: () => inner.destroy(),
    };
    const result = await runDirectionALive({
      transport,
      probe,
      app,
      items: ["BUG: dropped"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("refuted");
    expect(result.falseSuccess).toBe(false);
  });

  it("keeps the verdict when reset fails, and records the failure", async () => {
    const inner = new MockDesktop();
    const transport = {
      create: () => inner.create(),
      observe: () => inner.observe(),
      act: (session: DesktopSession, action: DesktopAction) => inner.act(session, action),
      readFile: (session: DesktopSession, path: string) => inner.readFile(session, path),
      reset: async () => {
        throw new Error("reset failed");
      },
      destroy: () => inner.destroy(),
    };
    const result = await runDirectionALive({
      transport,
      probe,
      app,
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("verified");
    expect(result.reasons.join(" ")).toContain("reset failed");
  });

  it("downgrades a verifier that says verified while the store is missing items", async () => {
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app,
      items: ["BUG: dropped"],
      verify: () => ({ status: "verified", reasons: ["trust me"] }),
      runsDir: runsDir(),
    });
    expect(result.status).toBe("uncertain");
    expect(result.reasons.join(" ")).toContain("missing");
  });

  it("cannot be forced to verified by a verifier that mutates its input", async () => {
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app,
      items: ["BUG: dropped"],
      verify: (persisted) => {
        // Simulate a hostile verifier: the runner must not share its evidence array.
        (persisted.items as string[]).push("BUG: dropped");
        return { status: "verified", reasons: ["mutated"] };
      },
      runsDir: runsDir(),
    });
    expect(result.status).toBe("uncertain");
    expect(result.persisted).toEqual([]);
    expect(result.missing).toEqual(["BUG: dropped"]);
  });

  it("records a reset failure as a recovery trace event", async () => {
    const dir = runsDir();
    const inner = new MockDesktop();
    const transport = {
      create: () => inner.create(),
      observe: () => inner.observe(),
      act: (session: DesktopSession, action: DesktopAction) => inner.act(session, action),
      readFile: (session: DesktopSession, path: string) => inner.readFile(session, path),
      reset: async () => {
        throw new Error("reset failed");
      },
      destroy: () => inner.destroy(),
    };
    const result = await runDirectionALive({
      transport,
      probe,
      app,
      items: ["one"],
      verify,
      runsDir: dir,
      runId: "reset",
    });
    expect(result.status).toBe("verified");
    const trace = readFileSync(join(dir, "reset", "trace.jsonl"), "utf8");
    expect(trace).toContain("reset-failed");
  });

  it("does not save when the click point misses the Save control", async () => {
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app: { ...app, savePoint: { x: 10, y: 10 } },
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).not.toBe("verified");
    expect(result.persisted).toEqual([]);
    expect(result.claimed).not.toMatch(/saved/i);
  });

  it("falls back to Tab traversal when the task package has no save point", async () => {
    const result = await runDirectionALive({
      transport: new MockDesktop(),
      probe,
      app: { ...app, savePoint: undefined },
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("verified");
  });

  it("reports uncertain when typeText fails, even if the store would verify", async () => {
    const result = await runDirectionALive({
      transport: new MockDesktop({ failAtAction: 2 }),
      probe,
      app,
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("uncertain");
  });

  it("reports uncertain when the transport throws, and still destroys the session", async () => {
    const transport = new MockDesktop({ throwAtAction: 2 });
    const result = await runDirectionALive({
      transport,
      probe,
      app,
      items: ["one"],
      verify,
      runsDir: runsDir(),
    });
    expect(result.status).toBe("uncertain");
    expect(result.reasons.join(" ")).toContain("transport error");
    expect(transport.destroyCount).toBe(1);
  });
});
