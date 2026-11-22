/** Validate and account for the live ledger using the shared evidence code. */
import { readFileSync } from "node:fs";
import process from "node:process";
import { ledgerRowSchema } from "../schemas/ledger-row.ts";
import { assertSchema, auditLedgerRows, type LedgerRow } from "../src/core/evidence.ts";

const ledgerPath = process.argv[2];
if (!ledgerPath) throw new Error("ledger path is required");
const rows: LedgerRow[] = readFileSync(ledgerPath, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const row: unknown = JSON.parse(line);
    assertSchema(row, ledgerRowSchema, "live corrupted-suite ledger row");
    return row as LedgerRow;
  });
process.stdout.write(JSON.stringify(auditLedgerRows(rows)));
