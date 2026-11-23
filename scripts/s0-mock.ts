#!/usr/bin/env node
/**
 * Run the S0 sequence against the mock desktop (TIF-89, offline half).
 *
 * Usage: tsx scripts/s0-mock.ts [outputDir]
 *
 * This is not evidence. It exercises the full path so the guest window only adds
 * a kernel; the report it writes is marked simulated.
 */
import { resolve } from "node:path";
import { renderS0Sequence, runS0Sequence } from "../src/discovery/s0-sequence.ts";

const outputDir = resolve(process.argv[2] ?? "runs/s0-mock");
const sequence = await runS0Sequence(outputDir);
process.stdout.write(renderS0Sequence(sequence));
process.exit(sequence.ok ? 0 : 1);
