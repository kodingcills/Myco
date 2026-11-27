/**
 * Capability track K: the agent's recovery tools (docs/product/capability-spec.md, "K.
 * Recovery"; docs/recovery/recovery.md).
 *
 *  - `checkpoint_take()` copies the agent's own current guest document into a HOST-side store
 *    and returns an opaque random id;
 *  - `checkpoint_restore({id})` writes a checkpoint back into the guest document;
 *  - `snapshot_restore_start()` writes back the document the agent was handed for this attempt.
 *
 * What the tools cannot do, by construction:
 *  - restore a state the agent did not produce or was not given: the only bytes a restore can
 *    write are the handed document (fixed when the tools are built) or bytes `checkpoint_take`
 *    read from the agent's own guest document. An id is looked up in THIS instance only, and
 *    an instance belongs to one attempt of one trial (the harness builds a fresh one per
 *    attempt and closes it when the attempt ends), so an id from another trial, another
 *    attempt, or a guessed id is `CHECKPOINT_UNKNOWN`;
 *  - touch the verdict or the evidence: the tools write the guest document only. The gate
 *    reads the harness's own capture, taken after the agent stopped (src/recovery/trial.ts),
 *    and nothing here reaches the gate, the evidence root, a path, or a verdict;
 *  - buy turns: every call, refused or not, takes one step from the trial's shared meter; with
 *    no step left the call is `STEP_BUDGET_EXHAUSTED` and does nothing.
 *
 * Replies are codes only: `{ ok: true, id? }` or `{ ok: false, code }`. `call` is total: it
 * never throws and never rejects; anything unexpected fails closed with a code.
 */
import { createHash, randomBytes } from "node:crypto";
import { STATE_FILE_LIMIT } from "../gate/gate.ts";
import type { ToolClass } from "../integrity/surface.ts";

export const RECOVERY_TOOLS = [
  "checkpoint_take",
  "checkpoint_restore",
  "snapshot_restore_start",
] as const;
export type RecoveryTool = (typeof RECOVERY_TOOLS)[number];

/** Every code a recovery reply can carry. Agent-facing: codes only, never a message. */
export const RECOVERY_CODES = [
  "TOOL_UNKNOWN",
  "ARGS_INVALID",
  "CHECKPOINT_UNKNOWN",
  "CHECKPOINT_LIMIT",
  "DOCUMENT_TOO_LARGE",
  "DOCUMENT_UNREADABLE",
  "DOCUMENT_WRITE_FAILED",
  "STEP_BUDGET_EXHAUSTED",
  "TOOLS_CLOSED",
] as const;
export type RecoveryCode = (typeof RECOVERY_CODES)[number];

export type RecoveryReply =
  | { readonly ok: true; readonly id?: string }
  | { readonly ok: false; readonly code: RecoveryCode };

/** The MCP server name the recovery tools are served under, as `mcp__myco-recovery__<tool>`. */
export const RECOVERY_SERVER_NAME = "myco-recovery";

/**
 * The surface classification for an audit (`auditToolSurface(..., { extraServers })`). Not in
 * the default `MCP_SERVERS`: only the K arm's audit passes it, so an R1 gated audit keeps
 * refusing these tools as unclassified.
 */
export const RECOVERY_SERVER_CLASS: Readonly<
  Record<string, Readonly<Record<RecoveryTool, ToolClass>>>
> = {
  [RECOVERY_SERVER_NAME]: {
    checkpoint_take: {
      reach: "guest",
      note: "K: copies the trial's own guest document into a harness-held store; returns an opaque id",
    },
    checkpoint_restore: {
      reach: "guest",
      note: "K: writes a checkpoint this attempt took back into its own guest document",
    },
    snapshot_restore_start: {
      reach: "guest",
      note: "K: writes the document the attempt was handed back into its own guest document",
    },
  },
};

/** The agent-facing tool definitions (closed input schemas). */
export const RECOVERY_TOOL_DEFS: readonly {
  readonly name: RecoveryTool;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}[] = [
  {
    name: "checkpoint_take",
    description:
      "Save a checkpoint of your current document. Returns an opaque id for checkpoint_restore.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "checkpoint_restore",
    description: "Restore your document to a checkpoint you took in this attempt.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
  },
  {
    name: "snapshot_restore_start",
    description: "Restore your document to the document you were handed at the start.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

/** The trial's one step budget, shared by every attempt and every tool call. */
export class StepMeter {
  readonly budget: number;
  #used = 0;
  constructor(budget: number) {
    if (!Number.isSafeInteger(budget) || budget < 1)
      throw new Error(`step budget must be a positive integer, got ${String(budget)}`);
    this.budget = budget;
  }
  /** Take one step; false (and nothing taken) when the budget is spent. */
  take(): boolean {
    if (this.#used >= this.budget) return false;
    this.#used++;
    return true;
  }
  get used(): number {
    return this.#used;
  }
  get remaining(): number {
    return this.budget - this.#used;
  }
}

/** The agent's own guest document, as the harness reaches it. */
export interface GuestDocument {
  read(): Promise<Uint8Array>;
  write(bytes: Uint8Array): Promise<void>;
}

/** Operator-side record of one tool call (never shown to the agent). */
export interface RecoveryEvent {
  readonly seq: number;
  readonly tool: string;
  readonly ok: boolean;
  readonly code?: RecoveryCode;
  /** sha256 of the bytes taken or written (absent when nothing was). */
  readonly sha256?: string;
}

export const MAX_CHECKPOINTS = 16;
const ID = /^ckpt_[0-9a-f]{32}$/;

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function isEmptyArgs(args: unknown): boolean {
  if (args === undefined) return true;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return false;
  if (Object.getPrototypeOf(args) !== Object.prototype) return false;
  return Reflect.ownKeys(args).length === 0;
}

function restoreId(args: unknown): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return undefined;
  if (Object.getPrototypeOf(args) !== Object.prototype) return undefined;
  const keys = Reflect.ownKeys(args);
  if (keys.length !== 1 || keys[0] !== "id") return undefined;
  const id = (args as { id?: unknown }).id;
  return typeof id === "string" && ID.test(id) ? id : undefined;
}

export interface RecoveryToolsOptions {
  readonly document: GuestDocument;
  /** The document this attempt was handed (host-generated). Copied at construction. */
  readonly handed: Uint8Array;
  readonly meter: StepMeter;
  readonly maxCheckpoints?: number;
  readonly maxBytes?: number;
}

/** One attempt's recovery tools. Build a fresh instance per attempt; `close()` when it ends. */
export class RecoveryTools {
  readonly #document: GuestDocument;
  readonly #handed: Uint8Array;
  readonly #meter: StepMeter;
  readonly #maxCheckpoints: number;
  readonly #maxBytes: number;
  readonly #store = new Map<string, Uint8Array>();
  readonly #events: RecoveryEvent[] = [];
  #closed = false;

  constructor(opts: RecoveryToolsOptions) {
    this.#document = opts.document;
    this.#handed = Uint8Array.from(opts.handed);
    this.#meter = opts.meter;
    this.#maxCheckpoints = opts.maxCheckpoints ?? MAX_CHECKPOINTS;
    this.#maxBytes = opts.maxBytes ?? STATE_FILE_LIMIT;
  }

  /** The operator-side log of every call, in order. */
  events(): readonly RecoveryEvent[] {
    return [...this.#events];
  }

  /** End the attempt: every later call is `TOOLS_CLOSED`, and the checkpoints are dropped. */
  close(): void {
    this.#closed = true;
    this.#store.clear();
  }

  #log(tool: string, reply: RecoveryReply, bytes?: Uint8Array): RecoveryReply {
    this.#events.push({
      seq: this.#events.length,
      tool,
      ok: reply.ok,
      ...(reply.ok ? {} : { code: reply.code }),
      ...(bytes === undefined ? {} : { sha256: sha256(bytes) }),
    });
    return reply.ok ? (reply.id === undefined ? { ok: true } : { ok: true, id: reply.id }) : reply;
  }

  async call(name: unknown, args?: unknown): Promise<RecoveryReply> {
    const tool = typeof name === "string" ? name.slice(0, 64) : "?";
    const fail = (code: RecoveryCode) => this.#log(tool, { ok: false, code });
    if (this.#closed) return fail("TOOLS_CLOSED");
    if (!this.#meter.take()) return fail("STEP_BUDGET_EXHAUSTED");
    try {
      if (name === "checkpoint_take") {
        if (!isEmptyArgs(args)) return fail("ARGS_INVALID");
        if (this.#store.size >= this.#maxCheckpoints) return fail("CHECKPOINT_LIMIT");
        let bytes: Uint8Array;
        try {
          bytes = Uint8Array.from(await this.#document.read());
        } catch {
          return fail("DOCUMENT_UNREADABLE");
        }
        if (bytes.byteLength > this.#maxBytes) return fail("DOCUMENT_TOO_LARGE");
        if (this.#closed) return fail("TOOLS_CLOSED");
        const id = `ckpt_${randomBytes(16).toString("hex")}`;
        this.#store.set(id, bytes);
        return this.#log(tool, { ok: true, id }, bytes);
      }
      if (name === "checkpoint_restore") {
        const id = restoreId(args);
        if (id === undefined) return fail("ARGS_INVALID");
        const bytes = this.#store.get(id);
        if (bytes === undefined) return fail("CHECKPOINT_UNKNOWN");
        return await this.#write(tool, bytes);
      }
      if (name === "snapshot_restore_start") {
        if (!isEmptyArgs(args)) return fail("ARGS_INVALID");
        return await this.#write(tool, this.#handed);
      }
      return fail("TOOL_UNKNOWN");
    } catch {
      return fail("ARGS_INVALID");
    }
  }

  /** Called only from `call`, after its closed check and with no await in between. */
  async #write(tool: string, bytes: Uint8Array): Promise<RecoveryReply> {
    try {
      await this.#document.write(Uint8Array.from(bytes));
    } catch {
      return this.#log(tool, { ok: false, code: "DOCUMENT_WRITE_FAILED" });
    }
    return this.#log(tool, { ok: true }, bytes);
  }
}
