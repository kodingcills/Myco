// One-shot probe: does a REAL PNG reach Anthropic's Messages API?
//
// Context: the earlier probe sent a hand-built "synthetic-png" and got
// 400 invalid_request_error "Could not process image". That is a decode
// failure, not auth/billing. This probe isolates one variable — the image —
// by sending a genuine PNG from disk through the real planner path.
//
// Budget: one count_tokens + one messages call, both fail-closed.
// biome-ignore-all lint/suspicious/noConsole: CLI diagnostic output for the operator log.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createPlanner } from "../src/baseline/planner.ts";
import { resolveAnthropicKey } from "../src/baseline/secret-file.ts";

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
  result.imageBytes = png.length;
  result.imageMagic = png.subarray(0, 8).toString("hex");
  // PNG signature must be 89504e470d0a1a0a, else we are testing the wrong thing.
  result.imageIsPng = result.imageMagic === "89504e470d0a1a0a";
  // Dimensions from the IHDR chunk, so the log records what was actually sent.
  result.imageWidth = png.readUInt32BE(16);
  result.imageHeight = png.readUInt32BE(20);

  const apiKey = resolveAnthropicKey();
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY required (or MYCO_ANTHROPIC_KEY_FILE)");

  let countRequests = 0;
  let messageRequests = 0;
  const paidFetch: typeof fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith("/count_tokens")) {
      if (countRequests >= 1) throw new Error("probe token-count limit");
      countRequests++;
    } else if (endpoint === "https://api.anthropic.com/v1/messages") {
      if (messageRequests >= 1) throw new Error("probe message limit");
      messageRequests++;
    } else {
      throw new Error(`unexpected endpoint ${endpoint}`);
    }
    // Record the request body BEFORE sending, so a thrown error still leaves
    // evidence of exactly what was attempted.
    const body = JSON.parse(String(init?.body ?? "{}"));
    const image = body?.messages?.[0]?.content?.find?.(
      (block: { type?: string }) => block.type === "image",
    );
    writeFileSync(
      join(directory, "request-inspection.json"),
      JSON.stringify(
        {
          endpoint,
          model: body.model,
          maxTokensPresent: "max_tokens" in body,
          maxTokens: body.max_tokens,
          imageMediaType: image?.source?.media_type,
          imageBase64Chars: image?.source?.data?.length,
          // First chars of the base64, enough to spot a data-URI prefix leak.
          imageBase64Head: image?.source?.data?.slice(0, 24),
        },
        null,
        2,
      ),
    );
    return fetch(url, init);
  };

  const planner = createPlanner(paidFetch, { ANTHROPIC_API_KEY: apiKey });
  const outcome = await planner.act("Edit the open spreadsheet and save it.", {
    mimeType: "image/png",
    data: png.toString("base64"),
  });

  result.calls = outcome.calls;
  result.decision = outcome.decision;
  // Usage is the thing the Coordinator asked for: a 200 with usage proves the
  // image was decoded and billed.
  result.usage = outcome.calls.map((c) => ({ model: c.model, ...c.usage }));
  result.outcome = "completed";
} catch (error) {
  result.outcome = "threw";
  result.error = error instanceof Error ? error.message : String(error);
}

result.finishedAt = new Date().toISOString();
writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
