import { readFileSync } from "node:fs";

/**
 * TIF-206: read one `NAME=value` secret from a file at the point of use.
 *
 * The launchers used to `set -a; source ~/.myco/secrets/anthropic.env`, which exported
 * the key into the environment of `caffeinate`, `node`, `tee` and every child they
 * spawned. Any agent that ran `ps eww` on the sweep then printed the live key into a
 * thread (TIF-193). Reading the file inside the process keeps the value in one JS
 * string: it is never in a process environment (`ps eww`) or argv (`ps -o command`).
 *
 * Errors name the file and the variable only. They never echo file contents.
 */
export function readSecretFromFile(path: string, name: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Error(`${name}: cannot read secrets file ${path}`);
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line.startsWith(`${name}=`)) continue;
    let value = line.slice(name.length + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")));
    if (quoted) value = value.slice(1, -1);
    if (value) return value;
  }
  throw new Error(`${name} not found in secrets file ${path}`);
}

/**
 * The Anthropic key for the paid planner.
 *
 * An explicit `ANTHROPIC_API_KEY` still wins, for back-compat with operators and tests
 * that set it. Otherwise the key is read from `MYCO_ANTHROPIC_KEY_FILE`, which the
 * launchers set to the secrets file PATH (a path is safe to show in `ps`). There is
 * deliberately no default path: a test that spawns a runnable must never pick up the
 * developer's real key by accident.
 */
export function resolveAnthropicKey(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (env.ANTHROPIC_API_KEY) return env.ANTHROPIC_API_KEY;
  const file = env.MYCO_ANTHROPIC_KEY_FILE;
  return file ? readSecretFromFile(file, "ANTHROPIC_API_KEY") : undefined;
}
