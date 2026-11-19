/**
 * UnoVerifier tests (M1-007 / TIF-11): three independent checks, three-valued
 * verdicts, exact string comparison, and read-only op discipline — the
 * acceptance rows from docs/backlog/m1.md and ADR-0002.
 */

import { describe, expect, it } from "vitest";
import type { TaskIntent } from "../src/core/verify.ts";
import { intentFor } from "../src/tasks/calc-record-edit.ts";
import { groundTruth } from "../src/tasks/intent.ts";
import { unoVerifierOverAgent } from "../src/verify/uno-verifier.ts";
import {
  AgentClient,
  type AgentTransport,
  AgentUnreachableError,
} from "../src/win/agent-client.ts";
import { FakeAgent } from "./fake/agent.ts";

const PARAMS = {
  fixtureSeed: "seed-alpha",
  rowKey: "EMP-0003",
  column: "name",
  newValue: "myco-x",
};

function makeIntent(newValue = PARAMS.newValue): TaskIntent {
  return intentFor({ ...PARAMS, newValue });
}

const GT = groundTruth(PARAMS);

function fakeWithCsv(csv: string): AgentClient {
  const transport: AgentTransport = {
    call: (req) => new FakeAgent({ unoEval: [], csvBytes: Buffer.from(csv) }).call(req),
  };
  return new AgentClient(transport, { token: "test-token" });
}

function csvWithTarget(value: string): string {
  // Header + 4 data rows; target is column B (name), data row 3 → B4.
  const rows = ["id,name,qty,joined,salary"];
  for (let i = 1; i <= 4; i++) {
    rows.push(
      `EMP-${String(i).padStart(4, "0")},${i === 3 ? value : `Name ${i}`},${i},2020-01-0${i},${i * 100}`,
    );
  }
  return rows.join("\n");
}
function verifierWith(script: ConstructorParameters<typeof FakeAgent>[0]) {
  const agent = new FakeAgent(script);
  const client = new AgentClient(agent, { token: "test-token" });
  return { verifier: unoVerifierOverAgent(client), agent };
}

describe("UnoVerifier verdicts", () => {
  it("happy path: edit landed, saved, and persisted → verified", async () => {
    const { verifier, agent } = verifierWith({
      unoEval: [{ get_string: PARAMS.newValue }, { is_modified: false }],
      csvBytes: Buffer.from(csvWithTarget(PARAMS.newValue)),
    });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("verified");
    expect(verifier.opsIssued).toEqual(["uno_eval", "uno_eval", "launch", "read_file"]);
    // Read-only discipline held.
    const ops = new Set(agent.requests.map((r) => r.op));
    expect([...ops].every((op) => ["ping", "uno_eval", "launch", "read_file"].includes(op))).toBe(
      true,
    );
  });

  it("wrong persisted value → refuted", async () => {
    const { verifier } = verifierWith({
      unoEval: [{ get_string: PARAMS.newValue }, { is_modified: false }],
      csvBytes: Buffer.from(csvWithTarget("WRONG")),
    });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("WRONG");
  });

  it("unsaved edit (isModified true, file stale) → refuted", async () => {
    const { verifier } = verifierWith({
      unoEval: [{ get_string: PARAMS.newValue }, { is_modified: true }],
      csvBytes: Buffer.from(csvWithTarget("Name 3")),
    });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("isModified");
  });

  it("agent unreachable → uncertain, not refuted, not verified", async () => {
    const client = new AgentClient(
      {
        call: () =>
          Promise.reject(
            new AgentUnreachableError("agent at 127.0.0.1:8765 unreachable: ECONNREFUSED"),
          ),
      },
      { token: "test-token" },
    );
    const verifier = unoVerifierOverAgent(client);
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("uncertain");
    expect(verdict.status).not.toBe("refuted");
    expect(verdict.status).not.toBe("verified");
  });

  it("UNO error → uncertain, never refuted", async () => {
    const { verifier } = verifierWith({ unoEval: ["error"] });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("uncertain");
    expect(verdict.reasons.join(" ")).toContain("UNO");
  });

  it("AutoCorrect case flip ('Myco-x' vs 'myco-x') → refuted, NOT verified", async () => {
    const { verifier } = verifierWith({
      unoEval: [{ get_string: "Myco-x" }, { is_modified: false }],
      csvBytes: Buffer.from(csvWithTarget("Myco-x")),
    });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("refuted");
    expect(verdict.reasons.join(" ")).toContain("Myco-x");
  });

  it("unreadable persisted file → uncertain, never refuted", async () => {
    const { verifier } = verifierWith({
      unoEval: [{ get_string: PARAMS.newValue }, { is_modified: false }],
      readFileError: true,
    });
    const verdict = await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    expect(verdict.status).toBe("uncertain");
    expect(verdict.reasons.join(" ")).toContain("could not look");
  });

  it("verifier never issues a mutating op (write_file, kill, uia_invoke)", async () => {
    const { verifier, agent } = verifierWith({
      unoEval: [{ get_string: PARAMS.newValue }, { is_modified: false }],
      csvBytes: Buffer.from(csvWithTarget(PARAMS.newValue)),
    });
    await verifier.verify(makeIntent(), "C:\\work\\fixture.xlsx");
    const mutating = agent.requests.filter((r) =>
      ["write_file", "kill", "uia_invoke"].includes(r.op),
    );
    expect(mutating).toEqual([]);
  });
});

describe("ground truth sanity for these fixtures", () => {
  it("targets B4 for EMP-0003 / name", () => {
    expect(GT.cellRef).toBe("B4");
    expect(GT.expectedValue).toBe(PARAMS.newValue);
  });
});

describe("AgentClient protocol handling", () => {
  it("converts ok:false into AgentOpError with the code", async () => {
    const transport: AgentTransport = {
      call: (req) => new FakeAgent({ unoEval: ["error"] }).call(req),
    };
    const client = new AgentClient(transport, { token: "test-token" });
    await expect(
      client.unoEval({ call: "get_string", sheet: "Sheet1", cell: "B4" }),
    ).rejects.toMatchObject({
      name: "AgentOpError",
      code: "OP_FAILED",
    });
  });

  it("fake agent rejects a wrong token with AUTH_FAILED", async () => {
    const agent = new FakeAgent({ unoEval: [] });
    const client = new AgentClient(agent, { token: "wrong" });
    await expect(client.ping()).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("readFile decodes base64 data_b64", async () => {
    const client = fakeWithCsv("a,b\n1,2\n");
    const bytes = await client.readFile("C:\\work\\fixture.csv");
    expect(bytes.toString("utf8")).toBe("a,b\n1,2\n");
  });
});
