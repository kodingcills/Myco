import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { object } from "./core.ts";

type Recovery = {
  version: 1;
  workspaceId: string;
  dryRun: boolean;
  baseline: string[];
  created: string[];
};

export const recoveryFile = "recovery.local.json";

export function isId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

export async function readRecovery(path: string): Promise<Recovery> {
  const state = object(JSON.parse(await readFile(path, "utf8")));
  if (
    state.version !== 1 ||
    !isId(state.workspaceId) ||
    typeof state.dryRun !== "boolean" ||
    !Array.isArray(state.baseline) ||
    !state.baseline.every(isId) ||
    !Array.isArray(state.created) ||
    !state.created.every(isId) ||
    state.created.some((id) => (state.baseline as string[]).includes(id))
  ) {
    throw new Error("Invalid recovery journal");
  }
  return {
    version: 1,
    workspaceId: state.workspaceId,
    dryRun: state.dryRun,
    baseline: state.baseline,
    created: state.created,
  };
}

/** Publish a synced snapshot. The initial hard link refuses to overwrite an earlier run. */
export async function writeRecovery(path: string, state: Recovery, initialize = false) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(state)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    if (initialize) await link(temp, path);
    else await rename(temp, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await rm(temp, { force: true });
  }
}
