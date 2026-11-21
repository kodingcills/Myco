import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { basename, join } from "node:path";
import { decode, EvidenceError, encode } from "../hidden-split/evidence.ts";
import { type commitment, fixtureHash, type HiddenFixture } from "../hidden-split/index.ts";
import type { GuardTraceEvent, ScreenView } from "../types.ts";
import { scoreTrial } from "./blind.ts";
import { oracleForApp } from "./state.ts";

type FileIO = Pick<typeof fs, "readFileSync" | "writeFileSync" | "readdirSync">;
type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Uint8Array);
const shape = (v: unknown, keys: string[]) =>
  obj(v) && Object.keys(v).length === keys.length && keys.every((k) => k in v);
const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === "string");
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
const hex = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
function invalid(message: string): never {
  throw new EvidenceError("invalid", message);
}
function validHidden(v: unknown): v is HiddenFixture {
  if (!shape(v, ["fixture", "intent", "fault"]) || !obj(v)) return false;
  const f = v.fixture,
    i = v.intent,
    fault = v.fault;
  if (
    !shape(f, [
      "fixtureId",
      "app",
      "version",
      "description",
      "screenClaimsToTrap",
      "persistenceFiles",
      "mustNotBeSolvableBy",
      "initialState",
      "defect",
      "disagreement",
    ]) ||
    !obj(f)
  )
    return false;
  const initial = f.initialState;
  if (
    !(
      typeof f.fixtureId === "string" &&
      f.app === "myco-todo" &&
      integer(f.version) &&
      typeof f.description === "string" &&
      typeof f.disagreement === "string" &&
      ["silent-drop", "stale-row", "wrong-value", "partial-write"].includes(String(f.defect)) &&
      strings(f.screenClaimsToTrap) &&
      strings(f.persistenceFiles) &&
      Array.isArray(f.mustNotBeSolvableBy) &&
      f.mustNotBeSolvableBy.every((x) => x === "file-io" || x === "shell-exec") &&
      shape(initial, ["kind", "storePath", "bytes", "companionFiles"]) &&
      obj(initial) &&
      initial.kind === "myco-todo" &&
      typeof initial.storePath === "string" &&
      initial.bytes instanceof Uint8Array &&
      obj(initial.companionFiles) &&
      Object.values(initial.companionFiles).every((x) => x instanceof Uint8Array)
    )
  )
    return false;
  if (
    !obj(i) ||
    !(i.kind === "todo.rename-item"
      ? shape(i, ["kind", "from", "to"]) && typeof i.from === "string" && typeof i.to === "string"
      : (i.kind === "todo.add-items" || i.kind === "todo.delete-items") &&
        shape(i, ["kind", "items"]) &&
        strings(i.items))
  )
    return false;
  return (
    obj(fault) &&
    (shape(fault, ["fault", "version", "seed"]) ||
      shape(fault, ["fault", "version", "seed", "reportError"])) &&
    [
      "stale-ui",
      "interrupted-write",
      "partial-persistence",
      "crash-mid-save",
      "permission-denied",
    ].includes(String(fault.fault)) &&
    integer(fault.version) &&
    Number.isSafeInteger(fault.seed) &&
    (!("reportError" in fault) || typeof fault.reportError === "boolean")
  );
}
function validTrace(v: unknown): v is GuardTraceEvent {
  if (!obj(v) || typeof v.timestamp !== "string") return false;
  if (v.type === "run-start") return shape(v, ["type", "timestamp"]);
  if (v.type === "file-write")
    return (
      shape(v, ["type", "timestamp", "path", "via"]) &&
      typeof v.path === "string" &&
      (v.via === "file-io" || v.via === "shell-exec")
    );
  if (v.type === "save-observed")
    return (
      shape(v, ["type", "timestamp", "files"]) &&
      obj(v.files) &&
      Object.values(v.files).every((x) => x instanceof Uint8Array)
    );
  if (
    v.type !== "action" ||
    !shape(v, ["type", "timestamp", "step", "action"]) ||
    !integer(v.step) ||
    !obj(v.action)
  )
    return false;
  return (
    Object.keys(v.action).every((k) => ["kind", "target", "detail"].includes(k)) &&
    ["click", "typeText", "setValue", "keyPress", "waitFor", "launch"].includes(
      String(v.action.kind),
    ) &&
    (!("target" in v.action) || typeof v.action.target === "string") &&
    (!("detail" in v.action) || typeof v.action.detail === "string")
  );
}
export function scoreRunDir(dir: string, expected: ReturnType<typeof commitment>, io: FileIO = fs) {
  const read = (name: string) => {
    try {
      return io.readFileSync(join(dir, name), "utf8");
    } catch {
      throw new EvidenceError("missing", `Cannot read ${name}`);
    }
  };
  const parse = (name: string) => {
    try {
      return decode(read(name));
    } catch (e) {
      if (e instanceof EvidenceError) throw e;
      throw new EvidenceError("json", `Malformed ${name}`);
    }
  };
  const m = parse("bundle.json");
  if (
    !shape(m, [
      "fixture",
      "intent",
      "hiddenFixture",
      "fixtureHash",
      "fixtureVersion",
      "oracleVersion",
      "faultVersion",
      "hiddenSplitVersion",
    ]) ||
    !obj(m) ||
    !validHidden(m.hiddenFixture)
  )
    invalid("Invalid bundle");
  const hidden = m.hiddenFixture;
  if (
    !hex(m.fixtureHash) ||
    fixtureHash(hidden) !== m.fixtureHash ||
    !expected.perFixtureHash.includes(m.fixtureHash) ||
    expected.rootHash !==
      createHash("sha256").update(JSON.stringify(expected.perFixtureHash)).digest("hex") ||
    expected.count !== expected.perFixtureHash.length ||
    m.hiddenSplitVersion !== expected.hiddenSplitVersion ||
    encode(m.fixture) !== encode(hidden.fixture) ||
    encode(m.intent) !== encode(hidden.intent) ||
    !integer(m.fixtureVersion) ||
    !integer(m.oracleVersion) ||
    !integer(m.faultVersion) ||
    !integer(m.hiddenSplitVersion) ||
    m.fixtureVersion !== hidden.fixture.version ||
    m.oracleVersion !== oracleForApp(hidden.fixture.app).version ||
    m.faultVersion !== hidden.fault.version
  )
    invalid("Commitment or version mismatch");
  const hashes = parse("state/manifest.json");
  if (
    !obj(hashes) ||
    Object.entries(hashes).some(
      ([name, hash]) => basename(name) !== name || name === "manifest.json" || !hex(hash),
    )
  )
    invalid("Invalid state manifest");
  let names: string[];
  try {
    names = io.readdirSync(join(dir, "state")) as string[];
  } catch {
    throw new EvidenceError("missing", "Missing state directory");
  }
  if (
    names.some((name) => name !== "manifest.json" && !(name in hashes)) ||
    names.length !== Object.keys(hashes).length + 1
  )
    invalid("Unexpected state files");
  const files: Record<string, Uint8Array> = {};
  for (const [name, hash] of Object.entries(hashes)) {
    let bytes: Buffer;
    try {
      bytes = io.readFileSync(join(dir, "state", name));
    } catch {
      throw new EvidenceError("missing", `Missing state ${name}`);
    }
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      invalid("State integrity failure");
    files[name] = bytes;
  }
  const screen = parse("screen.json");
  if (
    !shape(screen, ["visibleText", "reachable"]) ||
    !obj(screen) ||
    !strings(screen.visibleText) ||
    typeof screen.reachable !== "boolean"
  )
    invalid("Invalid screen");
  let trace: unknown[];
  try {
    trace = read("trace.jsonl").split("\n").filter(Boolean).map(decode);
  } catch (e) {
    if (e instanceof EvidenceError) throw e;
    throw new EvidenceError("json", "Malformed trace");
  }
  if (!trace.every(validTrace)) invalid("Invalid trace");
  const input = {
    fixture: hidden.fixture,
    intent: hidden.intent,
    faultVersion: hidden.fault.version,
    actual: { kind: hidden.fixture.app, files },
    screen: screen as unknown as ScreenView,
    trace: trace as GuardTraceEvent[],
  } as const;
  const verdict = scoreTrial({ ...input, selfReport: { claimsSuccess: false, text: "" } });
  io.writeFileSync(join(dir, "verdict.json"), encode(verdict));
  const selfReport = parse("selfreport.json");
  if (
    !shape(selfReport, ["claimsSuccess", "text"]) ||
    !obj(selfReport) ||
    typeof selfReport.claimsSuccess !== "boolean" ||
    typeof selfReport.text !== "string"
  )
    invalid("Invalid self report");
  const score = scoreTrial({
    ...input,
    selfReport: { claimsSuccess: selfReport.claimsSuccess, text: selfReport.text },
  });
  if (score.verdict !== verdict.verdict) invalid("Scoring changed the verdict");
  io.writeFileSync(
    join(dir, "score.json"),
    encode({
      ...score,
      selfReport,
      hiddenSplitVersion: m.hiddenSplitVersion,
      commitmentRoot: expected.rootHash,
    }),
  );
  return score;
}
