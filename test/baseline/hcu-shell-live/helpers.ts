/**
 * Test helpers for the live hcu+shell harness. Nothing here starts a trial, touches a VM or
 * calls a model:
 *  - `fakeClaude` is an injected `spawn` that returns canned stream-json and records argv,
 *    environment and stdin;
 *  - `useClaudeTrap` puts a `claude` executable FIRST on PATH for the whole file that fails the
 *    suite if anything runs it (it writes a marker file the `afterAll` checks);
 *  - `useFetchTrap` replaces `globalThis.fetch` with one that records any call, so a code path
 *    that reached the Messages API (or any network) fails the test.
 */
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, expect } from "vitest";
import type { SpawnFn } from "../../../src/pilot/claude-cli.ts";

export interface SpawnCall {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  stdin: string;
}

export function fakeClaude(
  replies: readonly { stdout: string; stderr?: string; code?: number | null; hang?: boolean }[],
) {
  const calls: SpawnCall[] = [];
  const signals: string[] = [];
  let i = 0;
  const spawn: SpawnFn = (command, args, options) => {
    const reply = replies[Math.min(i++, replies.length - 1)] ?? { stdout: "" };
    const call: SpawnCall = {
      command,
      args,
      env: { ...(options.env as Record<string, string>) },
      stdin: "",
    };
    calls.push(call);
    const child = new EventEmitter() as ChildProcess & EventEmitter;
    const out = new PassThrough();
    const err = new PassThrough();
    const input = new PassThrough();
    input.on("data", (d: Buffer) => {
      call.stdin += d.toString("utf8");
    });
    Object.assign(child, {
      stdin: input,
      stdout: out,
      stderr: err,
      kill: (signal = "SIGTERM") => {
        signals.push(String(signal));
        setImmediate(() => child.emit("close", null));
        return true;
      },
    });
    if (reply.hang !== true)
      setImmediate(() => {
        out.end(reply.stdout);
        err.end(reply.stderr ?? "");
        setImmediate(() => child.emit("close", reply.code ?? 0));
      });
    return child;
  };
  return { spawn, calls, signals };
}

export const MODEL = "claude-sonnet-5-5";

/** #598's `USAGE_LIMIT_PHRASES` (test/pilot/helpers.ts @ fc01e69a, unchanged since 13fccd96). */
export const USAGE_LIMIT_PHRASES = [
  "Claude AI usage limit reached|1700000000",
  "Claude usage limit reached. Your limit will reset at 3pm (America/New_York).",
  "5-hour limit reached ∙ resets 3pm",
  "5 hour limit reached",
  "Weekly limit reached ∙ resets Mon",
  "weekly limit reached",
  "Opus limit reached ∙ resets 11pm",
  "Sonnet limit reached · resets 3pm",
  "Your limit will reset at 5pm",
  "Limit resets at 9am",
  "daily limit exceeded",
  "usage_limit_reached",
] as const;

/** The round-2 verdict's exact N1 / N2 probe texts. */
export const VERDICT_QUOTA_TEXTS = [
  "Claude usage limit reached. Your limit will reset at 3pm (America/Los_Angeles).",
  "5-hour limit reached ∙ resets 3pm",
  "Weekly limit reached",
] as const;

export const init = (extra: Record<string, unknown> = {}) => ({
  type: "system",
  subtype: "init",
  apiKeySource: "none",
  model: MODEL,
  ...extra,
});

export const result = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  usage: {
    input_tokens: 1000,
    output_tokens: 20,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  ...extra,
});

export const stream = (...events: unknown[]) =>
  events.map((e) => `${JSON.stringify(e)}\n`).join("");

export const okReply = (text: string) => ({ stdout: stream(init(), result(text)) });

/** A `claude` first on PATH that records any invocation; the file fails if it ran. */
export function useClaudeTrap(): { readonly marker: string; readonly dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "claude-trap-"));
  const marker = join(dir, "INVOKED");
  const bin = join(dir, "claude");
  writeFileSync(bin, `#!/bin/sh\necho invoked > "${marker}"\nexit 97\n`);
  chmodSync(bin, 0o755);
  const before = process.env.PATH;
  beforeAll(() => {
    process.env.PATH = `${dir}${delimiter}${before ?? ""}`;
  });
  afterAll(() => {
    process.env.PATH = before;
    expect(existsSync(marker), "the trap `claude` binary was invoked").toBe(false);
  });
  return { marker, dir };
}

/** Replace fetch for the whole file; any call is recorded and fails the file. */
export function useFetchTrap(): { readonly calls: string[] } {
  const calls: string[] = [];
  const original = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      throw new Error("network trap: no code path may fetch");
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = original;
    expect(calls, "a code path called fetch").toEqual([]);
  });
  return { calls };
}
