/**
 * Linux desktop fleet: a paced scripted agent. No model is called, ever.
 *
 * A real desktop agent spends most of a trial waiting (on the model, on the app), not on the
 * host's CPU, and that wait is what parallel desktops overlap. `pacedFileAgent` stands in for
 * it: inside its own desktop it runs `sleep` for a fixed think time, then acts exactly like
 * track L's `scriptedFileAgent` (writes the saved CSV, or skips the save, or edits the wrong
 * row) and calls the gate with the same claim. The pause runs in the desktop through
 * `desktop.exec`, so it holds a desktop slot as a real agent would.
 */

import type { AgentBehaviour, ScriptedDesktopAgent } from "../parallel/agents.ts";
import { scriptedFileAgent } from "../parallel/agents.ts";

/** Most think time one trial may ask for (keeps a CI run bounded). */
export const MAX_THINK_MS = 10_000;

export function pacedFileAgent(behaviour: AgentBehaviour, thinkMs: number): ScriptedDesktopAgent {
  if (!Number.isSafeInteger(thinkMs) || thinkMs < 0 || thinkMs > MAX_THINK_MS)
    throw new Error(`thinkMs must be an integer in 0..${MAX_THINK_MS}`);
  const inner = scriptedFileAgent(behaviour);
  if (thinkMs === 0) return inner;
  return {
    id: `paced-file:${behaviour}:${thinkMs}ms`,
    simulated: true,
    async run(ctx) {
      const r = await ctx.desktop.exec("sleep", [(thinkMs / 1000).toFixed(3)], {
        timeoutMs: thinkMs + 10_000,
      });
      if (r.code !== 0) throw new Error(`think pause failed (exit ${String(r.code)})`);
      return inner.run(ctx);
    },
  };
}
