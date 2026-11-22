// One-shot probe: does a REAL PNG reach Anthropic's Messages API?
//
// Context: the earlier probe sent a hand-built "synthetic-png" and got
// 400 invalid_request_error "Could not process image". That is a decode
// failure, not auth/billing. This probe isolates one variable — the image —
// by sending a genuine PNG from disk through the real planner path.
//
// Scope of the claim it can support: the IMAGE PATH only (the Messages call
// accepts and decodes this PNG). It is not the c1-spike; there is no reset, no
// deploy, no agent loop and no judge here.
//
// Spend: exactly two paid requests per run (one count_tokens, one messages),
// both issued by planner.act(). The bound that actually holds is MAX_CALL_MICROS
// inside the planner; the wrapper below is an ENDPOINT ALLOWLIST plus a
// PRE-SEND SNAPSHOT, not a budget — its repeat counters cannot fire inside a
// single act() because act() makes one request to each endpoint with no retry.
// biome-ignore-all lint/suspicious/noConsole: CLI diagnostic output for the operator log.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlanner } from "../src/baseline/planner.ts";

const PNG_SIGNATURE = "89504e470d0a1a0a";
/** IHDR is the first chunk: 8-byte signature, 4-byte length, 4-byte type, then w, h. */
function readPngHeader(png: Buffer): { isPng: boolean; width: number; height: number } {
  const isPng =
    png.length >= 24 &&
    png.subarray(0, 8).toString("hex") === PNG_SIGNATURE &&
    png.subarray(12, 16).toString("ascii") === "IHDR";
  if (!isPng) throw new Error("not a PNG: bad signature or missing IHDR");
  return { isPng, width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

const directory = process.argv[2] || "/tmp/baseline/c1-realpng-probe";
const imagePath = process.argv[3];
mkdirSync(directory, { recursive: true });

const result: Record<string, unknown> = {
  imagePath,
  startedAt: new Date().toISOString(),
};

try {
  if (!imagePath) throw new Error("usage: c1-realpng-probe.ts <outdir> <png-path>");
  const png = readFileSync(imagePath);
  // Assert, do not merely record: a non-PNG here would test the wrong thing.
  const header = readPngHeader(png);
  result.imageBytes = png.length;
  result.imageMagic = png.subarray(0, 8).toString("hex");
  result.imageIsPng = header.isPng;
  result.imageWidth = header.width;
  result.imageHeight = header.height;

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required");

  const requests: { endpoint: string; status?: number; failure?: string }[] = [];
  let countRequests = 0;
  let messageRequests = 0;

  const paidFetch: typeof fetch = async (url, init) => {
    const endpoint = String(url);
    // Allowlist: anything that is not one of these two endpoints throws, so a
    // future planner change cannot quietly add a third paid call here.
    if (endpoint.endsWith("/count_tokens")) {
      if (countRequests >= 1) throw new Error("endpoint allowlist: second token-count");
      countRequests++;
    } else if (endpoint === "https://api.anthropic.com/v1/messages") {
      if (messageRequests >= 1) throw new Error("endpoint allowlist: second messages call");
      messageRequests++;
    } else {
      throw new Error(`endpoint allowlist: unexpected ${endpoint}`);
    }

    // Snapshot the body BEFORE sending, so a thrown error still leaves evidence
    // of exactly what was attempted, even though a later request would otherwise
    // overwrite this file.
    const body = JSON.parse(String(init?.body ?? "{}"));
    const image = body?.messages?.[0]?.content?.find?.(
      (block: { type?: string }) => block.type === "image",
    );
    const base64: string | undefined = image?.source?.data;
    const snapshot = {
      endpoint,
      model: body.model,
      maxTokensPresent: "max_tokens" in body,
      maxTokens: body.max_tokens,
      imageMediaType: image?.source?.media_type,
      imageSourceType: image?.source?.type,
      imageBase64Chars: base64?.length,
      // First chars of the base64, enough to spot a data-URI prefix leak.
      imageBase64Head: base64?.slice(0, 24),
      imageBase64IsBarePng: base64?.startsWith("iVBORw0KGgo") ?? false,
    };
    writeFileSync(
      join(directory, `request-${requests.length + 1}.json`),
      JSON.stringify(snapshot, null, 2),
    );
    if (endpoint === "https://api.anthropic.com/v1/messages") {
      writeFileSync(join(directory, "request-inspection.json"), JSON.stringify(snapshot, null, 2));
    }

    const response = await fetch(url, init);
    requests.push({ endpoint, status: response.status });
    return response;
  };

  const planner = createPlanner(paidFetch, { ANTHROPIC_API_KEY: apiKey });
  const outcome = await planner.act("Edit the open spreadsheet and save it.", {
    mimeType: "image/png",
    data: png.toString("base64"),
  });

  result.requests = requests;
  // The status, not the usage block, is what proves the request was accepted.
  result.messagesStatus = planner.lastMessageStatus;
  result.calls = outcome.calls;
  result.decision = outcome.decision;
  result.usage = outcome.calls.map((c) => ({ model: c.model, ...c.usage }));
  result.outcome = "completed";
} catch (error) {
  result.outcome = "threw";
  result.error = error instanceof Error ? error.message : String(error);
}

result.finishedAt = new Date().toISOString();
writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
