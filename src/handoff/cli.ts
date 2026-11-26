/**
 * `myco-handoff`: the operator's CLI for human handoffs (capability track N).
 *
 *   pnpm myco-handoff list    --connection ~/.myco/handoff/<run>.json
 *   pnpm myco-handoff resolve ho-1 approve|reject|fixed-it --connection <file>
 *                             [--note "one line"] [--operator <label>]
 *
 * It reads the operator connection file (written 0600 by the harness, `writeConnectionFile`),
 * refuses one whose URL is not loopback (so a tampered file cannot send the token elsewhere),
 * and never prints the token. Output is the endpoint's JSON on stdout; errors are codes on
 * stderr. See docs/handoff/protocol.md.
 */
import { readFileSync, statSync } from "node:fs";
import type { Writable } from "node:stream";
import type { OperatorConnection } from "./operator-server.ts";
import { OPERATOR_BASE } from "./operator-server.ts";

export interface CliIo {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly fetch?: typeof fetch;
}

const USAGE =
  "usage: myco-handoff list --connection FILE\n" +
  "       myco-handoff resolve HANDOFF_ID approve|reject|fixed-it --connection FILE [--note TEXT] [--operator LABEL]\n";

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}

/** Read and check a connection file. Throws a code-only Error on anything off. */
export function readConnection(path: string): OperatorConnection {
  const st = statSync(path);
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0)
    throw new Error("CONNECTION_FILE_TOO_OPEN (expected mode 0600)");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<OperatorConnection>;
  if (parsed.schema !== "myco.handoff.connection/1" || typeof parsed.token !== "string")
    throw new Error("CONNECTION_FILE_INVALID");
  const url = new URL(String(parsed.url));
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/")
    throw new Error("CONNECTION_NOT_LOOPBACK");
  return { schema: parsed.schema, url: url.origin, token: parsed.token };
}

export async function main(argvIn: readonly string[], io: CliIo): Promise<number> {
  const argv = [...argvIn];
  const doFetch = io.fetch ?? fetch;
  const connectionPath = flag(argv, "--connection");
  const note = flag(argv, "--note");
  const operator = flag(argv, "--operator");
  const [command, ...rest] = argv;
  if (!connectionPath || (command !== "list" && command !== "resolve")) {
    io.stderr.write(USAGE);
    return 2;
  }
  let conn: OperatorConnection;
  try {
    conn = readConnection(connectionPath);
  } catch (error) {
    // Code only: the message of a JSON/fs error can carry file content or a path.
    const msg =
      error instanceof Error && /^[A-Z_]+( \(|$)/.test(error.message)
        ? error.message
        : "CONNECTION_FILE_UNREADABLE";
    io.stderr.write(`myco-handoff: ${msg}\n`);
    return 2;
  }
  const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` };
  let response: Response;
  try {
    if (command === "list") {
      if (rest.length !== 0) {
        io.stderr.write(USAGE);
        return 2;
      }
      response = await doFetch(`${conn.url}${OPERATOR_BASE}/pending`, { headers });
    } else {
      const [handoffId, outcome, ...extra] = rest;
      if (!handoffId || !outcome || extra.length > 0) {
        io.stderr.write(USAGE);
        return 2;
      }
      const body: Record<string, string> = { handoffId, outcome, via: "cli" };
      if (note !== undefined) body.note = note;
      if (operator !== undefined) body.operatorLabel = operator;
      response = await doFetch(`${conn.url}${OPERATOR_BASE}/resolve`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    }
  } catch {
    io.stderr.write("myco-handoff: ENDPOINT_UNREACHABLE\n");
    return 1;
  }
  const text = await response.text();
  if (!response.ok) {
    let code = `HTTP_${response.status}`;
    try {
      const parsed = JSON.parse(text) as { code?: unknown };
      if (typeof parsed.code === "string" && /^[A-Z_]{1,64}$/.test(parsed.code)) code = parsed.code;
    } catch {
      // keep the HTTP code
    }
    io.stderr.write(`myco-handoff: ${code}\n`);
    return 1;
  }
  io.stdout.write(`${text}\n`);
  return 0;
}
