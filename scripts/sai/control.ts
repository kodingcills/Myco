/**
 * Direct Control wrapper (research preview): open a lease, run Simulang blocks, read files, close.
 * Direct Control makes no model calls for these blocks. The free computer is deleted when a lease
 * closes, so callers must copy out anything they need first.
 */
import type { SaiClient } from "./client.ts";
import { powershellCommand } from "./client.ts";

export interface ExecResult {
  httpStatus: number | null;
  result: unknown;
  error: { kind?: string; message?: string } | null;
  logs: string[];
  durationMs: number | null;
  wallMs: number;
  vendorError: string | null;
}

export class Control {
  leaseOpen = false;

  constructor(
    private readonly client: SaiClient,
    readonly machineId: string,
  ) {}

  private path(suffix = ""): string {
    return `/v1/machines/${this.machineId}/control${suffix}`;
  }

  async open(
    stage: string,
    label: string,
  ): Promise<{ status: number | null; ms: number; body: unknown }> {
    const r = await this.client.call({
      stage,
      label,
      method: "POST",
      path: this.path(),
      timeoutMs: 300_000,
    });
    this.leaseOpen = r.ok;
    return { status: r.status, ms: r.ms, body: r.body };
  }

  async exec(stage: string, label: string, code: string, timeoutMs = 120_000): Promise<ExecResult> {
    const r = await this.client.call({
      stage,
      label,
      method: "POST",
      path: this.path("/exec"),
      body: { code, timeoutMs },
      timeoutMs: timeoutMs + 45_000,
    });
    const b = (r.body && typeof r.body === "object" ? r.body : {}) as Record<string, unknown>;
    const err = b.error;
    const errObj =
      err && typeof err === "object" ? (err as { kind?: string; message?: string }) : null;
    return {
      httpStatus: r.status,
      result: b.result ?? null,
      error: errObj,
      logs: Array.isArray(b.logs) ? (b.logs as unknown[]).map(String) : [],
      durationMs: typeof b.durationMs === "number" ? b.durationMs : null,
      wallMs: r.ms,
      vendorError: typeof err === "string" ? err : null,
    };
  }

  /** Run a short PowerShell script through machine.exec; returns stdout/stderr/exit code (or null on failure). */
  async powershell(
    stage: string,
    label: string,
    script: string,
    timeoutMs = 60_000,
  ): Promise<{
    exec: ExecResult;
    stdout: string | null;
    stderr: string | null;
    exitCode: number | null;
  }> {
    const cmd = powershellCommand(script);
    const code = `var r = await machine.exec({ command: ${JSON.stringify(cmd)}, timeout: ${timeoutMs} });\n({ stdout: r.stdout, stderr: r.stderr, exitCode: r.exitCode })`;
    const exec = await this.exec(stage, label, code, timeoutMs + 15_000);
    const res = exec.result as { stdout?: string; stderr?: string; exitCode?: number } | null;
    const ok =
      exec.httpStatus === 200 && exec.error === null && res !== null && typeof res === "object";
    return {
      exec,
      stdout: ok && typeof res.stdout === "string" ? res.stdout : null,
      stderr: ok && typeof res.stderr === "string" ? res.stderr : null,
      exitCode: ok && typeof res.exitCode === "number" ? res.exitCode : null,
    };
  }

  /** Place a text file (UTF-8, no BOM) via machine.writeToFile after ensuring its directory exists. */
  async placeFile(stage: string, label: string, path: string, text: string): Promise<ExecResult> {
    const dir = path.slice(0, path.lastIndexOf("\\"));
    await this.powershell(
      stage,
      `${label}:mkdir`,
      `New-Item -ItemType Directory -Force -Path '${dir}' | Out-Null`,
    );
    const code = `await machine.writeToFile({ text: ${JSON.stringify(text)}, path: ${JSON.stringify(path)}, overwrite: true });\n"written"`;
    return this.exec(stage, label, code);
  }

  /**
   * Read a file's actual bytes. Returns bytes, "absent" (readback worked, file missing), or null
   * (unreadable: lease/exec failure, malformed output). Hashing/comparison happens on the host.
   */
  async readBytes(
    stage: string,
    label: string,
    path: string,
  ): Promise<Uint8Array | "absent" | null> {
    const script = `$p='${path}'; if (Test-Path -LiteralPath $p) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($p)) } else { 'MISSING' }`;
    const r = await this.powershell(stage, label, script);
    if (r.stdout === null || r.exitCode !== 0) return null;
    const out = r.stdout.trim();
    if (out === "MISSING") return "absent";
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(out)) return null;
    return new Uint8Array(Buffer.from(out, "base64"));
  }

  async close(stage: string, label: string): Promise<number | null> {
    const r = await this.client.call({
      stage,
      label,
      method: "DELETE",
      path: this.path(),
      timeoutMs: 60_000,
    });
    this.leaseOpen = false;
    return r.status;
  }
}
