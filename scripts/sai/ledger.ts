/**
 * Append-only, secret-free ledger. Every row passes through `scrubDeep`; approval URLs never enter it.
 * Rows are JSON lines so a crash leaves a readable prefix.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { scrubDeep } from "./redact.ts";

export interface LedgerRow {
  seq: number;
  at: string;
  stage: string;
  label: string;
  kind: "http" | "event" | "guard" | "note";
  method?: string;
  path?: string;
  status?: number | null;
  ms?: number;
  vendorStatus?: string | null;
  reasonCode?: string | null;
  vendorCode?: string | null;
  usage?: unknown;
  credits?: { before: number | null; after: number | null; delta: number | null } | "not_reported";
  note?: string;
  excerpt?: string;
  data?: unknown;
}

export class Ledger {
  readonly rows: LedgerRow[] = [];
  private seq = 0;

  constructor(
    private readonly file: string | null,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (file) {
      mkdirSync(dirname(file), { recursive: true });
      // Continue numbering across separate invocations that append to the same file.
      if (existsSync(file))
        this.seq = readFileSync(file, "utf8").split("\n").filter(Boolean).length;
    }
  }

  append(row: Omit<LedgerRow, "seq" | "at">): LedgerRow {
    this.seq += 1;
    const full = scrubDeep({ seq: this.seq, at: this.now().toISOString(), ...row }) as LedgerRow;
    this.rows.push(full);
    if (this.file) appendFileSync(this.file, `${JSON.stringify(full)}\n`, { mode: 0o644 });
    return full;
  }
}

/** Truncate a body to a bounded, printable excerpt; screenshots/base64 blobs are dropped first. */
export function excerpt(value: unknown, max = 600): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const cleaned = (text ?? "").replace(/"base64":"[^"]*"/g, '"base64":"[omitted]"');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…[+${cleaned.length - max}]` : cleaned;
}
