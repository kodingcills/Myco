import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resultRecordSchema } from "../../schemas/result-record.ts";
import { traceEventSchema } from "../../schemas/trace-events.ts";
import { validateSchema } from "../../schemas/validate.ts";
import { type LiveVerification, runDirectionALive } from "../../src/discovery/live-runner.ts";
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
