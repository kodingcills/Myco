/**
 * TIF-268 - why a REAL `hcu+shell` run cannot start. Empty only when every precondition holds;
 * the CLI checks this before it touches the VM or calls a model, and prints every reason.
 * The same real-run refusals as the other live runners (`m2-r1-pilot.ts launch`,
 * `m2-corrections-ab-run.ts launch`), plus the two this arm needs:
 *
 *  - `launch-flag-missing`: the explicit `--launch-real-trials` flag;
 *  - `plan-sha256-mismatch`: `--plan-sha256` equal to the printed plan's hash;
 *  - `lead-go-*`: the lead's GO, a committed and unchanged `docs/benchmark/hcu-shell-go.json`
 *    naming this plan's hash (absent until the lead gives it);
 *  - `api-key-path-configured`: no API-path credential variable set (names only, values never
 *    read; the subscription preflight shared with the myco-gate arm);
 *  - `cold-boot-guard-missing`: `scripts/reset-trial-vm.sh` carries #546's guard (it prints
 *    `boot class=`) and defaults to `trial-base-v3`; each trial's boot class is then checked
 *    by the runner, which halts on anything but `cold`;
 *  - `vm-lock-not-held`: started under `scripts/vm-session.sh`, so the VM lock (TIF-210) is held
 *    for the whole run, and the reset path accepts it.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { subscriptionPreflight } from "../../pilot/claude-cli.ts";

export const LEAD_GO_FILE = "docs/benchmark/hcu-shell-go.json";
export const LEAD_GO_SCHEMA = "myco.hcu-shell.lead-go/1";

export interface LiveRefusalInput {
  readonly repoRoot: string;
  readonly planSha256: string;
  readonly launchRealTrials: boolean;
  readonly pinnedPlanSha256: string | undefined;
  readonly envNames: Iterable<string>;
  /** Whether an ancestor (`scripts/vm-session.sh`) holds the VM lock for this process. */
  readonly vmLockHeld: boolean;
}

export function leadGoProblems(repoRoot: string, planSha256: string): string[] {
  const path = join(repoRoot, LEAD_GO_FILE);
  if (!existsSync(path))
    return [`lead-go-missing: ${LEAD_GO_FILE} is not committed (real runs wait for the lead's GO)`];
  const out: string[] = [];
  let go: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) go = v as Record<string, unknown>;
  } catch {
    // reported below
  }
  if (go === null) out.push(`lead-go-invalid: ${LEAD_GO_FILE} is not a JSON object`);
  else {
    if (go.schema !== LEAD_GO_SCHEMA || go.arm !== "hcu+shell")
      out.push(`lead-go-invalid: ${LEAD_GO_FILE} is not an hcu+shell GO (${LEAD_GO_SCHEMA})`);
    if (go.planSha256 !== planSha256)
      out.push(`lead-go-plan-mismatch: ${LEAD_GO_FILE} approves another plan (planSha256)`);
  }
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", LEAD_GO_FILE], {
    cwd: repoRoot,
  });
  if (tracked.status !== 0) out.push(`lead-go-uncommitted: ${LEAD_GO_FILE} is not committed`);
  else if (
    spawnSync("git", ["diff", "--quiet", "HEAD", "--", LEAD_GO_FILE], { cwd: repoRoot }).status !==
    0
  )
    out.push(`lead-go-uncommitted: ${LEAD_GO_FILE} differs from the committed copy`);
  return out;
}

export function coldBootGuardProblems(repoRoot: string): string[] {
  let script = "";
  try {
    script = readFileSync(join(repoRoot, "scripts/reset-trial-vm.sh"), "utf8");
  } catch {
    return ["cold-boot-guard-missing: scripts/reset-trial-vm.sh is missing"];
  }
  const out: string[] = [];
  if (!script.includes('echo "reset-trial-vm: boot class=$BOOT_CLASS'))
    out.push("cold-boot-guard-missing: reset-trial-vm.sh does not report #546's boot class");
  // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal bash parameter expansion in reset-trial-vm.sh.
  if (!script.includes("SNAPSHOT=${1:-${MYCO_TRIAL_SNAPSHOT:-trial-base-v3}}"))
    out.push("cold-boot-guard-missing: reset-trial-vm.sh does not default to trial-base-v3");
  return out;
}

export function liveRefusals(input: LiveRefusalInput): string[] {
  const out: string[] = [];
  if (!input.launchRealTrials)
    out.push("launch-flag-missing: a real run needs the explicit --launch-real-trials flag");
  if (input.pinnedPlanSha256 !== input.planSha256)
    out.push("plan-sha256-mismatch: --plan-sha256 must equal the planSha256 printed above");
  out.push(...leadGoProblems(input.repoRoot, input.planSha256));
  const pre = subscriptionPreflight(input.envNames);
  if (!pre.ok)
    out.push(
      `api-key-path-configured: API-path credential variable(s) set: ${pre.configured.join(", ")} (names checked, values never read); the arm runs on the subscription only`,
    );
  out.push(...coldBootGuardProblems(input.repoRoot));
  if (!input.vmLockHeld)
    out.push(
      "vm-lock-not-held: start the run under scripts/vm-session.sh -- ... so the VM lock is held for every trial",
    );
  return out;
}
