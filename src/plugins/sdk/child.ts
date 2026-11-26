/**
 * Sandboxed child bootstrap (capability track T). The host starts one of these per request:
 *
 *   node --permission --allow-fs-read=<sdk dir>,<plugin dir> --max-old-space-size=<cap>
 *        --import <sdk>/guard.ts <sdk>/child.ts <plugin entry> <rss cap bytes>
 *
 * with an empty environment, under the host's OS network layer, with stdin and stdout bound
 * to regular files (never pipes or sockets). It reads exactly one request from stdin, then
 * hides `process.stdin`, `process.stdout` and `process.stderr` from plugin code (so no
 * stream object, and no `net.Socket` class, is reachable through them) and makes `console`
 * discard output, imports the plugin, calls it, and writes exactly one response line. Any failure exits non-zero with no
 * output, which the host records as `uncertain` with a `PLUGIN_*` code. The host re-parses the
 * response with the closed parser, so nothing here is trusted for the verdict.
 *
 * Exit codes: 64 bad request, 65 plugin lacks the requested hook, 70 plugin threw,
 * 71 plugin answer malformed, 87 resident memory over the cap.
 */
import { pathToFileURL } from "node:url";
import type { PluginModule } from "./index.ts";
import {
  CODE,
  PLUGIN_SPEC,
  type PluginRequest,
  type PluginResponse,
  parseRequest,
  type WireDocument,
} from "./protocol.ts";

const EXIT_BAD_REQUEST = 64;
const EXIT_NO_HOOK = 65;
const EXIT_THREW = 70;
const EXIT_MALFORMED = 71;
const EXIT_MEMORY = 87;

const [entry, rssCapText] = process.argv.slice(2);
const rssCap = Number(rssCapText);
if (entry === undefined || !Number.isInteger(rssCap) || rssCap <= 0) process.exit(EXIT_BAD_REQUEST);

function checkMemory(): void {
  if (process.memoryUsage.rss() > rssCap) process.exit(EXIT_MEMORY);
}
// Catches asynchronous growth; synchronous loops are bounded by the host's wall-clock kill.
setInterval(checkMemory, 5).unref();

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function decode(doc: WireDocument): { fileName: string; bytes: Uint8Array | null } {
  return {
    fileName: doc.fileName,
    bytes: doc.bytesB64 === null ? null : new Uint8Array(Buffer.from(doc.bytesB64, "base64")),
  };
}

function encode(bytes: Uint8Array | null): string | null {
  return bytes === null ? null : Buffer.from(bytes).toString("base64");
}

async function answer(plugin: PluginModule, req: PluginRequest): Promise<PluginResponse> {
  if (req.op === "verify") {
    if (typeof plugin.oracle !== "function") process.exit(EXIT_NO_HOOK);
    const a = await plugin.oracle(decode(req.doc), req.intent);
    return { spec: PLUGIN_SPEC, op: "verify", status: a.status, code: a.code };
  }
  if (req.op === "read") {
    if (typeof plugin.reader !== "function") process.exit(EXIT_NO_HOOK);
    const a = await plugin.reader(decode(req.doc));
    return a.status === "ok"
      ? { spec: PLUGIN_SPEC, op: "read", status: "ok", code: a.code, state: a.state }
      : { spec: PLUGIN_SPEC, op: "read", status: "uncertain", code: a.code, state: null };
  }
  if (typeof plugin.selftestCases !== "function") process.exit(EXIT_NO_HOOK);
  const cases = await plugin.selftestCases();
  return {
    spec: PLUGIN_SPEC,
    op: "selftest-cases",
    cases: cases.map((c) => ({
      id: c.id,
      intent: c.intent as never,
      correct: { fileName: c.correct.fileName, bytesB64: encode(c.correct.bytes) },
      corruptions: c.corruptions.map((x) => ({
        cls: x.cls,
        doc: { fileName: x.doc.fileName, bytesB64: encode(x.doc.bytes) },
      })),
    })),
  };
}

let req: PluginRequest;
try {
  req = parseRequest(JSON.parse(await readStdin()));
} catch {
  process.exit(EXIT_BAD_REQUEST);
}

// macOS: CoreFoundation sets `__CF_USER_TEXT_ENCODING` inside this process at startup under
// Seatbelt (the host passes no variable; macOS CI showed it). Remove that one OS-set name so
// the plugin sees an empty environment; anything else would still show in the `env` probe.
Reflect.deleteProperty(process.env, "__CF_USER_TEXT_ENCODING");

// From here on plugin code may run. Keep the one stream the child needs, then take all three
// away from the plugin: a throwing getter, non-configurable, so it cannot be put back.
const out = process.stdout;
for (const name of ["stdin", "stdout", "stderr"]) {
  Object.defineProperty(process, name, {
    get() {
      const e = new Error(`PLUGIN_CAP_DENIED: process.${name}`) as Error & { code: string };
      e.code = "PLUGIN_CAP_DENIED";
      throw e;
    },
    configurable: false,
  });
}
const discard = (): void => {};
Object.defineProperty(globalThis, "console", {
  value: Object.freeze(Object.fromEntries(Object.keys(console).map((k) => [k, discard]))),
  writable: false,
  configurable: false,
});

let response: PluginResponse;
try {
  const mod = (await import(pathToFileURL(entry as string).href)) as { default?: PluginModule };
  if (typeof mod.default !== "object" || mod.default === null) process.exit(EXIT_NO_HOOK);
  response = await answer(mod.default, req);
} catch {
  process.exit(EXIT_THREW);
}
checkMemory();
if ("code" in response && (typeof response.code !== "string" || !CODE.test(response.code)))
  process.exit(EXIT_MALFORMED);
let line: string;
try {
  line = `${JSON.stringify(response)}\n`;
} catch {
  process.exit(EXIT_MALFORMED);
}
out.write(line, () => process.exit(0));
