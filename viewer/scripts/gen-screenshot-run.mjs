// Usage: node viewer/scripts/gen-screenshot-run.mjs /private/tmp/mvd-008/screens-1000
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";

const count = 1000;
const width = 1440;
const height = 900;
const stride = width * 3 + 1;
const seed = 0x4d59434f;

function chunk(type, data) {
  const bytes = Buffer.alloc(data.length + 12);
  bytes.writeUInt32BE(data.length);
  bytes.write(type, 4, "ascii");
  data.copy(bytes, 8);
  bytes.writeUInt32BE(crc32(bytes.subarray(4, bytes.length - 4)), bytes.length - 4);
  return bytes;
}

function screenshot(step) {
  const pixels = Buffer.alloc(height * stride, 242);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  function rect(x, y, w, h, shade) {
    for (let row = y; row < y + h; row++) {
      const start = row * stride + 1 + x * 3;
      pixels.fill(shade, start, start + w * 3);
    }
  }

  // Desktop app chrome, side navigation, content cards and a textured image panel.
  rect(0, 0, width, 76, 39);
  rect(0, 76, 250, height - 76, 226);
  rect(275, 118, 1100, 726, 255);
  for (let line = 0; line < 12; line++) {
    rect(26, 123 + line * 49, 120 + ((line * 31) % 73), 9, 154);
  }
  for (let line = 0; line < 26; line++) {
    rect(970, 156 + line * 24, 130 + ((line * 71 + step) % 205), 6, 165);
  }
  rect(23, 112 + (step % 12) * 49, 4, 30, 72);

  let random = seed ^ (step + 1);
  for (let y = 0; y < 310; y++) {
    for (let x = 0; x < 490; x++) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      const shade = 24 + ((x + y + (random & 255)) % 208);
      const offset = (y + 200) * stride + 1 + (x + 310) * 3;
      pixels[offset] = shade;
      pixels[offset + 1] = Math.min(255, shade + 13);
      pixels[offset + 2] = Math.min(255, shade + 22);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonl = (events) => `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;

const repo = fileURLToPath(new URL("../..", import.meta.url));
const fixture = join(repo, "foundry/viewer-fixtures/verified");
const output = process.argv[2];
assert(
  output,
  "Usage: node viewer/scripts/gen-screenshot-run.mjs <new directory outside the repo>",
);
const path = resolve(output);
const dir = join(realpathSync(dirname(path)), basename(path));
assert(relative(repo, dir).startsWith(`..${sep}`), "Output must be outside the repo");
mkdirSync(dir);
mkdirSync(join(dir, "artifacts"));

const base = JSON.parse(readFileSync(join(fixture, "result.json"), "utf8"));
assert.equal(base.verdict.status, "verified");
assert(base.verdict.checks.every(({ passed }) => passed === true));
const runId = "viewer-screenshots-1000";
const result = { ...base, runId, steps: [] };
const [runStart] = readFileSync(join(fixture, "trace.jsonl"), "utf8")
  .split("\n")
  .map((line) => (line ? JSON.parse(line) : null));
const trace = [{ ...runStart, runId }];
const ledger = { ...JSON.parse(readFileSync(join(fixture, "ledger.jsonl"), "utf8")), runId };
const manifest = { format: "mycotrace/1", runId, files: {} };
const timestamp = (ms) => new Date(Date.parse(result.startedAt) + ms).toISOString();
const sizes = [];
const hashes = new Set();

function write(name, bytes) {
  writeFileSync(join(dir, name), bytes);
  const hash = sha256(bytes);
  manifest.files[name] = hash;
  return hash;
}

for (let step = 0; step < count; step++) {
  const row = {
    ...base.steps[step % base.steps.length],
    step,
    stateVersionBefore: step,
    stateVersionAfter: step + 1,
  };
  result.steps.push(row);
  const { action, preconditionResults, postconditionResults } = row;
  const start = step * 100;
  trace.push(
    { type: "observation", timestamp: timestamp(start), stateVersion: step, nodeCount: 40 },
    { type: "action", timestamp: timestamp(start + 10), step, action },
    {
      type: "guard-evaluation",
      timestamp: timestamp(start + 20),
      step,
      phase: "pre",
      results: preconditionResults,
      stateVersionBefore: step,
      stateVersionAfter: step,
    },
    {
      type: "guard-evaluation",
      timestamp: timestamp(start + 30),
      step,
      phase: "post",
      results: postconditionResults,
      stateVersionBefore: step,
      stateVersionAfter: step + 1,
    },
  );

  const imagePath = `artifacts/step-${String(step).padStart(4, "0")}.png`;
  const png = screenshot(step);
  const hash = write(imagePath, png);
  hashes.add(hash);
  sizes.push(png.length);
  trace.push({
    type: "screenshot",
    timestamp: timestamp(start + 40),
    step,
    path: imagePath,
    sha256: hash,
    width,
    height,
  });
}
assert.equal(hashes.size, count);
const pngBytes = sizes.reduce((total, size) => total + size, 0);
assert(Math.min(...sizes) >= 100_000 && Math.max(...sizes) <= 400_000);
assert(pngBytes >= 100_000_000 && pngBytes <= 300_000_000);
write("result.json", JSON.stringify(result));
write("trace.jsonl", jsonl(trace));
write("ledger.jsonl", jsonl([ledger]));
writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
process.stdout.write(
  `${JSON.stringify({
    dir,
    seed,
    count,
    width,
    height,
    pngBytes,
    minPngBytes: Math.min(...sizes),
    maxPngBytes: Math.max(...sizes),
    expectedViewerVerdict: "Verified",
  })}\n`,
);
