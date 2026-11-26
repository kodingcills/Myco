/**
 * Track S: the loopback webhook. Real HTTP on 127.0.0.1 (ephemeral port), the scheduler
 * behind it with a scripted executor. A planted marker in the secrets file must never
 * appear in a response, a row, a notification or a diagnostic.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  startWebhookServer,
  type WebhookServer,
  webhookSignature,
} from "../../src/schedule/webhook.ts";
import { setup, spec, tmp } from "./helpers.ts";

const SECRET = "PLANTEDwebhookSecret0123456789abcdefXYZ";
let server: WebhookServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function boot(
  o: { secretFile?: string; schedules?: Parameters<typeof setup>[0]["schedules"] } = {},
) {
  const s = setup({
    schedules: o.schedules ?? [spec({ budget: { runsPerDay: 50, wallTimeS: 60, concurrency: 4 } })],
  });
  const secretFile = o.secretFile ?? join(s.dir, "webhook.env");
  if (!o.secretFile) writeFileSync(secretFile, `MYCO_WEBHOOK_SECRET=${SECRET}\n`, { mode: 0o600 });
  const done: Promise<unknown>[] = [];
  server = await startWebhookServer({
    scheduler: s.scheduler,
    secret: { file: secretFile, name: "MYCO_WEBHOOK_SECRET" },
    port: 0,
    onSubmission: (x) => done.push(x.done),
    onDiagnostic: (c) => s.diagnostics.push(c),
  });
  const post = async (path: string, body: string, headers: Record<string, string>) => {
    const r = await fetch(`http://127.0.0.1:${server?.port}${path}`, {
      method: "POST",
      body,
      headers,
    });
    return { status: r.status, body: (await r.json()) as Record<string, string> };
  };
  const signed = (scheduleId: string, delivery: string, body = "{}", secret = SECRET) =>
    post(`/v1/trigger/${scheduleId}`, body, {
      "x-myco-delivery": delivery,
      "x-myco-signature": webhookSignature(secret, scheduleId, delivery, body),
    });
  return { ...s, secretFile, post, signed, done };
}

describe("webhook", () => {
  it("a correctly signed delivery runs once; a replay is a 409 duplicate", async () => {
    const w = await boot();
    const r = await w.signed("nightly", "d-1");
    expect(r).toEqual({
      status: 202,
      body: { code: "ACCEPTED", runId: expect.stringMatching(/^sched-nightly-/) },
    });
    expect((await w.signed("nightly", "d-1")).status).toBe(409);
    await Promise.all(w.done);
    expect(w.executor.calls).toHaveLength(1);
    expect(w.executor.calls[0]?.source).toBe("webhook");
  });

  it("a correctly signed delivery with a malformed delivery id is refused 401 and never runs", async () => {
    const w = await boot();
    for (const delivery of ["has space", "x".repeat(129), "semi;colon", "slash/path"]) {
      const r = await w.signed("nightly", delivery);
      expect(r).toEqual({ status: 401, body: { code: "BAD_SIGNATURE" } });
    }
    expect(w.executor.calls).toHaveLength(0);
    expect(w.done).toHaveLength(0);
  });

  it("refuses bad, missing, re-aimed and wrong-secret signatures with one code, and never runs", async () => {
    const w = await boot({
      schedules: [spec({ id: "nightly" }), spec({ id: "other", taskId: "fc-v1-002" })],
    });
    const body = "{}";
    const good = webhookSignature(SECRET, "nightly", "d-2", body);
    const attempts = [
      w.post("/v1/trigger/nightly", body, { "x-myco-delivery": "d-2" }),
      w.post("/v1/trigger/nightly", body, { "x-myco-signature": good }),
      w.post("/v1/trigger/nightly", body, {
        "x-myco-delivery": "d-2",
        "x-myco-signature": good.toUpperCase(),
      }),
      w.post("/v1/trigger/other", body, { "x-myco-delivery": "d-2", "x-myco-signature": good }), // re-aimed
      w.post("/v1/trigger/nightly", body, { "x-myco-delivery": "d-3", "x-myco-signature": good }), // new delivery id
      w.post("/v1/trigger/nightly", '{"x":1}', {
        "x-myco-delivery": "d-2",
        "x-myco-signature": good,
      }), // body changed
      w.signed("nightly", "d-4", body, "not-the-secret"),
      w.post("/v1/trigger/nightly", body, {
        "x-myco-delivery": "bad id with spaces",
        "x-myco-signature": good,
      }),
    ];
    for (const r of await Promise.all(attempts))
      expect(r).toEqual({ status: 401, body: { code: "BAD_SIGNATURE" } });
    expect(w.executor.calls).toHaveLength(0);
  });

  it("an unreadable secret refuses every request (503), it never disables the check", async () => {
    const w = await boot();
    rmSync(w.secretFile);
    const r = await w.signed("nightly", "d-5");
    expect(r).toEqual({ status: 503, body: { code: "SECRET_UNAVAILABLE" } });
    expect(w.executor.calls).toHaveLength(0);
  });

  it("maps scheduler refusals to codes; wrong method, path and oversized body are refused", async () => {
    const w = await boot({ schedules: [spec({ events: { webhook: false, manual: true } })] });
    expect(await w.signed("nightly", "d-6")).toEqual({
      status: 403,
      body: { code: "SOURCE_NOT_ENABLED" },
    });
    expect(await w.signed("ghost", "d-6")).toEqual({
      status: 404,
      body: { code: "UNKNOWN_SCHEDULE" },
    });
    w.scheduler.pause();
    expect((await w.signed("nightly", "d-7")).body.code).toBe("SOURCE_NOT_ENABLED");
    const get = await fetch(`http://127.0.0.1:${server?.port}/v1/trigger/nightly`);
    expect(get.status).toBe(405);
    expect((await w.post("/etc/passwd", "{}", {})).status).toBe(404);
    const big = await fetch(`http://127.0.0.1:${server?.port}/v1/trigger/nightly`, {
      method: "POST",
      body: "x".repeat(70_000),
    }).catch(() => ({ status: 413 }));
    expect(big.status).toBe(413);
    expect(w.executor.calls).toHaveLength(0);
  });

  it("paused: 423", async () => {
    const w = await boot();
    w.scheduler.pause();
    expect(await w.signed("nightly", "d-8")).toEqual({ status: 423, body: { code: "PAUSED" } });
  });

  it("binds loopback only", async () => {
    const s = setup({});
    await expect(
      startWebhookServer({
        scheduler: s.scheduler,
        secret: { file: "/nonexistent", name: "X" },
        port: 0,
        host: "0.0.0.0" as never,
      }),
    ).rejects.toThrow(/loopback only/);
    const w = await boot();
    expect(w.diagnostics).toEqual([]);
    expect(server?.server.address()).toMatchObject({ address: "127.0.0.1" });
  });

  it("planted marker: the secret never reaches a response, row, notification or diagnostic", async () => {
    const w = await boot();
    const responses = [
      await w.signed("nightly", "d-9"),
      await w.signed("nightly", "d-10", "{}", "wrong"),
      await w.signed("nightly", "d-9"),
    ];
    rmSync(w.secretFile);
    writeFileSync(w.secretFile, `OTHER=${SECRET}\n`);
    responses.push(await w.signed("nightly", "d-11"));
    await Promise.all(w.done);
    const everything = [
      JSON.stringify(responses),
      readFileSync(w.ledgerPath, "utf8"),
      readFileSync(join(w.state.dir, "claims.jsonl"), "utf8"),
      JSON.stringify(w.notifier.sent),
      JSON.stringify(w.diagnostics),
    ].join("\n");
    expect(everything).not.toContain("PLANTED");
    expect(everything).not.toContain(SECRET);
    expect(w.diagnostics.some((d) => d.startsWith("WEBHOOK_SECRET_UNAVAILABLE"))).toBe(true);
  });
});

void tmp;
