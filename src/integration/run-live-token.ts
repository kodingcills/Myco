/**
 * Where `run-live.ts` gets the agent token (row-8 H5).
 *
 * Precedence, first match wins:
 *   1. `--token-file PATH`: an explicit path the operator chose, for example the
 *      private `MYCO_TOKEN_OUT` the deploy wrote (G25). A missing, unreadable or
 *      empty file is an error; it never falls through to another source, so a
 *      stale exported `MYCO_AGENT_TOKEN` cannot silently win over a named file.
 *   2. `MYCO_AGENT_TOKEN`: what the sweep drivers pass today (G28, unchanged).
 *   3. `~/.myco-token`: the file `agent/bootstrap/deploy-to-vm.sh` writes after a
 *      verified deploy (the same default `session-info.ts` reads).
 *
 * The flag parser and the file reader are the ones `session-info.ts` uses, so
 * the two CLIs read a token file the same way (trimmed; CRLF is fine).
 */

import { join } from "node:path";
import { readTokenFile, tokenFileFromArgv } from "./session-info-core.ts";

export function resolveRunLiveToken(
  argv: string[],
  env: NodeJS.ProcessEnv,
  home: string,
  read: (path: string) => string = readTokenFile,
): string {
  const explicit = tokenFileFromArgv(argv);
  if (explicit !== undefined) return read(explicit);
  const fromEnv = env.MYCO_AGENT_TOKEN;
  if (fromEnv) return fromEnv;
  const fallback = join(home, ".myco-token");
  try {
    return read(fallback);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `no agent token: ${reason}. A verified deploy writes ${fallback} (or MYCO_TOKEN_OUT; pass that path as --token-file)`,
    );
  }
}
