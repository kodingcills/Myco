/**
 * Guest-health precondition and trial cleanup (M1-019 / TIF-48).
 *
 * Contamination is the thing that makes a verdict untrustworthy: a stray
 * LibreOffice instance can serve a foreign document over this trial's UNO
 * socket, and a leftover run dir can be read as this trial's fixture (log 27).
 * The probe runs BEFORE the trial launches anything — probing after launchCalc
 * would find the trial's own soffice and kill it. The agent has no process-list
 * op, so `kill` is used as the observation: the set it reports as killed is
 * exactly the set that was alive. Killing is safe here: a clean guest has none,
 * and a contaminated guest must not be trusted for this trial anyway.
 *
 * Cleanup is unconditional and runs in a finally. It kills LibreOffice (the
 * document is still open — there is no close step on Windows), deletes the
 * trial's nonce-named run dir and throwaway UNO profile, then verifies by
 * listing again. Residue is reported, never thrown: the next trial's health
 * probe aborts on it, so a failed cleanup cannot masquerade as a clean guest.
 */

import type { AgentClient } from "../win/agent-client.js";
import { GUEST_ADMIN_DIRNAME, runGuestScript } from "./guest-shell.js";

/** soffice.exe is the launcher, soffice.bin holds the document; kill both. */
const SOFFICE_IMAGES = ["soffice.bin", "soffice.exe"] as const;
const LISTING_SPLIT = "__MYCO_RUN_ROOT_SPLIT__";
const PROFILE_DIRNAME = "profiles";

export interface GuestHealthFinding {
  /** Guest pids/names reported alive by the stray-process probe. */
  strayProcesses: Array<number | string>;
  /** Run-root directories this trial does not own. */
  strayRunDirs: string[];
  /** Leftover throwaway profiles: residue, not a contamination trigger. */
  strayProfileDirs: string[];
}

export interface GuestHealthOptions {
  client: AgentClient;
  runRoot: string;
  /** This trial's own dir name, excluded when known (normally before creation). */
  ownRunDirName?: string;
  ownProfileDirName?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export async function probeGuestHealth(options: GuestHealthOptions): Promise<GuestHealthFinding> {
  const strayProcesses: Array<number | string> = [];
  for (const image of SOFFICE_IMAGES) {
    const killed = await options.client.kill({ image_name: image });
    strayProcesses.push(...killed);
  }
  const listing = await listTrialDirs(options.client, options.runRoot, options);
  const strayRunDirs = listing.runDirs.filter(
    (name) =>
      name !== GUEST_ADMIN_DIRNAME && name !== PROFILE_DIRNAME && name !== options.ownRunDirName,
  );
  const strayProfileDirs = listing.profileDirs.filter((name) => name !== options.ownProfileDirName);
  return { strayProcesses, strayRunDirs, strayProfileDirs };
}

/** Only stray processes and stray run dirs make a reading untrustworthy. */
export function guestContaminated(finding: GuestHealthFinding): boolean {
  return finding.strayProcesses.length > 0 || finding.strayRunDirs.length > 0;
}

export function describeGuestHealth(finding: GuestHealthFinding): string {
  const parts: string[] = [];
  if (finding.strayProcesses.length > 0) {
    parts.push(`stray soffice: ${finding.strayProcesses.join(", ")}`);
  }
  if (finding.strayRunDirs.length > 0) {
    parts.push(`leftover run dirs: ${finding.strayRunDirs.join(", ")}`);
  }
  if (finding.strayProfileDirs.length > 0) {
    parts.push(`leftover profiles: ${finding.strayProfileDirs.join(", ")}`);
  }
  return parts.length > 0 ? parts.join("; ") : "guest clean";
}

export interface GuestCleanupOptions {
  client: AgentClient;
  runRoot: string;
  /** Nonce-named dirs created by this trial (absent when convert never ran). */
  runDirName?: string;
  profileDirName?: string;
  timeoutMs?: number;
  pollMs?: number;
}

export interface GuestCleanupResult {
  killed: Array<number | string>;
  /** Names verified absent after the delete attempts. */
  removed: string[];
  /** Names still present after the bounded retries. */
  residue: string[];
  /** Steps that could not be completed or verified. */
  errors: string[];
}

export async function cleanupTrialGuest(options: GuestCleanupOptions): Promise<GuestCleanupResult> {
  const targets = [
    ...(options.runDirName
      ? [{ name: options.runDirName, path: `${options.runRoot}\\${options.runDirName}` }]
      : []),
    ...(options.profileDirName
      ? [
          {
            name: options.profileDirName,
            path: `${options.runRoot}\\${PROFILE_DIRNAME}\\${options.profileDirName}`,
          },
        ]
      : []),
  ];
  const result: GuestCleanupResult = { killed: [], removed: [], residue: [], errors: [] };

  // Kill before deleting: an open document locks its xlsx on Windows.
  for (const image of SOFFICE_IMAGES) {
    try {
      result.killed.push(...(await options.client.kill({ image_name: image })));
    } catch (error) {
      result.errors.push(
        `kill ${image}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (targets.length === 0) return result;

  const deleteAndList = async (): Promise<string[]> => {
    const lines = [
      ...targets.map((t) => `if exist "${t.path}" rd /s /q "${t.path}" 2>nul`),
      `dir /b /ad "${options.runRoot}" >> %REPORT% 2>nul`,
      `echo ${LISTING_SPLIT}>>%REPORT%`,
      `dir /b /ad "${options.runRoot}\\${PROFILE_DIRNAME}" >> %REPORT% 2>nul`,
    ];
    const report = await runGuestScript({
      client: options.client,
      runRoot: options.runRoot,
      name: "cleanup",
      lines,
      timeoutMs: options.timeoutMs,
      pollMs: options.pollMs,
    });
    const listing = parseListing(report);
    const present = new Set([...listing.runDirs, ...listing.profileDirs]);
    return targets.filter((t) => present.has(t.name)).map((t) => t.name);
  };

  // A just-killed soffice can hold a lock for a few hundred milliseconds.
  let verified = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result.residue = await deleteAndList();
      verified = true;
      if (result.residue.length === 0) break;
    } catch (error) {
      result.errors.push(`delete: ${error instanceof Error ? error.message : String(error)}`);
      result.residue = [];
      break;
    }
    if (attempt === 0) await sleep(500);
  }
  if (!verified) return result; // nothing may be claimed as removed
  const residual = new Set(result.residue);
  result.removed = targets.filter((t) => !residual.has(t.name)).map((t) => t.name);
  return result;
}

interface TrialDirListing {
  runDirs: string[];
  profileDirs: string[];
}

async function listTrialDirs(
  client: AgentClient,
  runRoot: string,
  options: { timeoutMs?: number; pollMs?: number },
): Promise<TrialDirListing> {
  const report = await runGuestScript({
    client,
    runRoot,
    name: "probe",
    lines: [
      `if not exist "${runRoot}" mkdir "${runRoot}"`,
      `dir /b /ad "${runRoot}" >> %REPORT% 2>nul`,
      `echo ${LISTING_SPLIT}>>%REPORT%`,
      `dir /b /ad "${runRoot}\\${PROFILE_DIRNAME}" >> %REPORT% 2>nul`,
    ],
    timeoutMs: options.timeoutMs,
    pollMs: options.pollMs,
  });
  return parseListing(report);
}

function parseListing(report: string): TrialDirListing {
  const [runPart = "", profilePart = ""] = report.split(LISTING_SPLIT);
  return { runDirs: entryNames(runPart), profileDirs: entryNames(profilePart) };
}

function entryNames(part: string): string[] {
  return part
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.includes(":"));
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
