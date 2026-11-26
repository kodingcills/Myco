/**
 * `myco-state mcp`: the structured-state MCP server over stdio (capability track I).
 *
 * The harness starts one per trial, from the launch plan (`src/state/arms.ts`), with:
 *   MYCO_STATE_RUN_ID     the trial's run id (the launch audit checks it equals the trial's);
 *   MYCO_STATE_UNO_PIPE   the trial's live soffice UNO pipe (`statePipeFor(runId)`);
 *   MYCO_STATE_WITHHELD   optional JSON array of host strings no reply may contain.
 * It takes no other argument and no path. Missing or malformed binding: exit 2, no server.
 */
import type { Readable, Writable } from "node:stream";
import { linuxUnoBackend, UNO_PIPE_NAME } from "./linux/uno.ts";
import { createStateService, serveStateStdio } from "./server.ts";

export const STATE_ENV = {
  runId: "MYCO_STATE_RUN_ID",
  pipe: "MYCO_STATE_UNO_PIPE",
  withheld: "MYCO_STATE_WITHHELD",
} as const;

/** Run ids the state server accepts as a binding (the harness's own run-id shape). */
export const STATE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface StateCliIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
}

function withheldFrom(raw: string | undefined): string[] | null {
  if (raw === undefined || raw === "") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) && parsed.every((s) => typeof s === "string") ? parsed : null;
  } catch {
    return null;
  }
}

export async function main(argv: readonly string[], io: StateCliIo): Promise<number> {
  if (argv.length !== 1 || argv[0] !== "mcp") {
    io.stderr.write("usage: myco-state mcp   (binding comes from the harness environment)\n");
    return 2;
  }
  const runId = io.env[STATE_ENV.runId] ?? "";
  const pipe = io.env[STATE_ENV.pipe] ?? "";
  const withheld = withheldFrom(io.env[STATE_ENV.withheld]);
  if (!STATE_RUN_ID.test(runId) || !UNO_PIPE_NAME.test(pipe) || withheld === null) {
    io.stderr.write("myco-state: not bound to a trial (run id / pipe / withheld list invalid)\n");
    return 2;
  }
  const service = createStateService({
    backend: linuxUnoBackend({
      pipe,
      onDiagnostic: (detail) => io.stderr.write(`myco-state[${runId}]: ${detail}\n`),
    }),
    withheld,
    onDiagnostic: ({ tool, detail }) =>
      io.stderr.write(`myco-state[${runId}] ${tool}: ${detail}\n`),
  });
  await serveStateStdio(service, io.stdin, io.stdout);
  return 0;
}
