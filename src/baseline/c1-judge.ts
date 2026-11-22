import { type CalcRecordEditParams, groundTruth } from "../tasks/intent.ts";
import { AgentUnoReader, unoVerifierOverAgent } from "../verify/uno-verifier.ts";
import type { AgentClient } from "../win/agent-client.ts";
import type { PreparedC1 } from "./c1-trial.ts";
import type { Observation } from "./index.ts";

type DocumentState = "open" | "closed" | "dialog" | "driver-action" | "unavailable";

/** Grader-side only. The caller supplies an independent document/health probe. */
export function independentC1Judge(options: {
  client: AgentClient;
  socket: string;
  xlsxPath: string;
  params: CalcRecordEditParams;
  documentState(): Promise<DocumentState>;
}): Pick<PreparedC1, "judge" | "audit"> {
  const { client, socket, params, xlsxPath } = options;
  const { cellRef, expectedValue } = groundTruth(params);
  const reader = new AgentUnoReader(client, socket);
  const verifier = unoVerifierOverAgent(client, socket, 240_000);
  // A fresh conversion for each call keeps the audit independent of the first read.
  async function persistedValue(): Promise<string> {
    const parsed = await verifier.readPersisted(xlsxPath);
    if ("error" in parsed || typeof parsed.cells[cellRef] !== "string")
      throw new Error("independent persisted read unavailable");
    return parsed.cells[cellRef];
  }
  return {
    async judge(): Promise<Observation> {
      const state = await options.documentState();
      if (state !== "open" && state !== "closed") return { kind: state };
      if (state === "open" && (await reader.isModified())) return { kind: "modified" };
      return { kind: "persisted", actual: await persistedValue(), expected: expectedValue };
    },
    async audit() {
      return (await persistedValue()) === expectedValue;
    },
  };
}
