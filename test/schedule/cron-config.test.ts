/** Track S: the cron matcher and the strict schedule file (no secrets in schedule files). */
import { describe, expect, it } from "vitest";
import {
  looksLikeSecret,
  parseScheduleFile,
  ScheduleFileError,
} from "../../src/schedule/config.ts";
import { CronError, cronMatches, cronSlotsBetween, parseCron } from "../../src/schedule/cron.ts";

const at = (iso: string) => Date.parse(iso);

describe("cron", () => {
  it("matches minutes, hours, steps, ranges and lists in UTC", () => {
    const c = parseCron("*/15 9-17 * * 1-5");
    expect(cronMatches(c, at("2026-11-26T09:45:00Z"))).toBe(true); // Thursday
    expect(cronMatches(c, at("2026-11-26T09:46:00Z"))).toBe(false);
    expect(cronMatches(c, at("2026-11-26T18:00:00Z"))).toBe(false);
    expect(cronMatches(c, at("2026-11-28T10:00:00Z"))).toBe(false); // Saturday
    expect(cronMatches(parseCron("0 0 * * 7"), at("2026-11-29T00:00:00Z"))).toBe(true); // 7 = Sunday
    expect(cronMatches(parseCron("5,10 * * * *"), at("2026-11-26T03:10:30Z"))).toBe(true);
  });

  it("day-of-month OR day-of-week when both are restricted (Vixie rule)", () => {
    const c = parseCron("0 0 1 * 1");
    expect(cronMatches(c, at("2026-12-01T00:00:00Z"))).toBe(true); // the 1st (a Tuesday)
    expect(cronMatches(c, at("2026-11-30T00:00:00Z"))).toBe(true); // a Monday
    expect(cronMatches(c, at("2026-12-02T00:00:00Z"))).toBe(false);
  });

  it("refuses what it does not fully understand", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * MON",
      "*/0 * * * *",
      "L * * * *",
      "5-1 * * * *",
      "* * ? * *",
      "",
    ])
      expect(() => parseCron(bad), bad).toThrow(CronError);
  });

  it("enumerates slots in (after, upto], keeps the newest `limit`, counts all", () => {
    const c = parseCron("* * * * *");
    const r = cronSlotsBetween(c, at("2026-11-26T10:00:00Z"), at("2026-11-26T12:00:30Z"), 5);
    expect(r.total).toBe(120);
    expect(r.slots.map((s) => new Date(s).toISOString())).toEqual([
      "2026-11-26T11:56:00.000Z",
      "2026-11-26T11:57:00.000Z",
      "2026-11-26T11:58:00.000Z",
      "2026-11-26T11:59:00.000Z",
      "2026-11-26T12:00:00.000Z",
    ]);
    expect(cronSlotsBetween(c, at("2026-11-26T10:00:00Z"), at("2026-11-26T10:00:59Z")).total).toBe(
      0,
    );
  });

  it("bounds the scan when the cursor is absurdly old", () => {
    const r = cronSlotsBetween(parseCron("0 0 * * *"), 0, at("2026-11-26T00:00:00Z"));
    expect(r.truncatedScan).toBe(true);
    expect(r.total).toBeLessThanOrEqual(367);
  });
});

const base = () => ({
  version: "myco.schedule/v1",
  stateDir: "/var/lib/myco/schedule",
  ledgerKey: { keyFile: "/etc/myco/secrets/schedule.env", keyName: "MYCO_SCHEDULE_LEDGER_KEY" },
  webhook: {
    port: 8787,
    secretsFile: "/etc/myco/secrets/schedule.env",
    secretName: "MYCO_WEBHOOK_SECRET",
  },
  notifier: { kind: "file", path: "/var/lib/myco/schedule/notifications.jsonl" },
  schedules: [
    {
      id: "nightly-calc",
      taskId: "fc-v1-001",
      cron: "30 2 * * *",
      events: { inbox: { dir: "/var/lib/myco/inbox" }, webhook: true, manual: true },
      budget: { runsPerDay: 4, wallTimeS: 900, concurrency: 1 },
      missed: "run-latest",
    },
  ],
});

describe("schedule file", () => {
  it("parses a full file", () => {
    const f = parseScheduleFile(JSON.stringify(base()));
    expect(f.schedules[0]?.cron?.source).toBe("30 2 * * *");
    expect(f.webhook?.secret).toEqual({
      file: "/etc/myco/secrets/schedule.env",
      name: "MYCO_WEBHOOK_SECRET",
    });
    expect(f.tickSeconds).toBe(30);
  });

  const mutate = (fn: (o: ReturnType<typeof base>) => void) => {
    const o = base();
    fn(o);
    return JSON.stringify(o);
  };
  const refusals: [string, string, RegExp][] = [
    [
      "unknown top-level key",
      mutate((o) => Object.assign(o, { extra: 1 })),
      /\$\.extra: unknown key/,
    ],
    [
      "unknown budget key (a typo cannot drop a budget)",
      mutate((o) => Object.assign(o.schedules[0]!.budget, { runsPerDy: 1 })),
      /unknown key/,
    ],
    [
      "missing budget",
      mutate((o) => {
        delete (o.schedules[0] as Record<string, unknown>).budget;
      }),
      /budget: required/,
    ],
    [
      "zero concurrency",
      mutate((o) => {
        o.schedules[0]!.budget.concurrency = 0;
      }),
      /concurrency/,
    ],
    [
      "bad cron",
      mutate((o) => {
        o.schedules[0]!.cron = "every day";
      }),
      /cron/,
    ],
    [
      "relative path",
      mutate((o) => {
        o.stateDir = "state";
      }),
      /absolute/,
    ],
    [
      "dot-dot path",
      mutate((o) => {
        o.stateDir = "/var/../etc";
      }),
      /\.\./,
    ],
    [
      "inline webhook secret field",
      mutate((o) => Object.assign(o.webhook, { secret: "hunter2" })),
      /unknown key/,
    ],
    [
      "webhook without config",
      mutate((o) => {
        delete (o as Record<string, unknown>).webhook;
      }),
      /\$\.webhook: required/,
    ],
    [
      "duplicate ids",
      mutate((o) => {
        o.schedules.push({ ...o.schedules[0]! });
      }),
      /duplicate/,
    ],
    [
      "no trigger",
      mutate((o) => {
        const s = o.schedules[0] as Record<string, unknown>;
        delete s.cron;
        s.events = {};
      }),
      /no trigger/,
    ],
    [
      "bad secret name",
      mutate((o) => {
        o.webhook.secretName = "my secret";
      }),
      /secretName/,
    ],
  ];
  for (const [name, text, re] of refusals)
    it(`refuses: ${name}`, () => {
      expect(() => parseScheduleFile(text)).toThrow(ScheduleFileError);
      expect(() => parseScheduleFile(text)).toThrow(re);
    });

  const PLANTED = [
    // Assembled at run time so no committed file holds a key-shaped literal (the Sai
    // tracked-files check and gitleaks scan the source).
    ["sk", "ant", "api03", "PLANTEDmarker0000000000000000"].join("-"),
    ["ghp", "PLANTEDmarker000000000000000000000"].join("_"),
    "PLANTEDa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
    `-----BEGIN OPENSSH ${"PRIVATE"} KEY-----PLANTED`,
  ];
  for (const secret of PLANTED)
    it(`refuses a key-shaped value anywhere, without echoing it (${secret.slice(0, 7)}…)`, () => {
      for (const text of [
        mutate((o) => {
          o.schedules[0]!.taskId = secret;
        }),
        mutate((o) => {
          o.notifier.path = `/var/${secret}`;
        }),
        mutate((o) => {
          o.webhook.secretsFile = secret;
        }),
        mutate((o) => Object.assign(o, { [secret]: 1 })),
      ]) {
        let message = "";
        try {
          parseScheduleFile(text);
        } catch (e) {
          message = (e as Error).message;
        }
        expect(message).toMatch(/looks like a secret|unknown key|invalid form|absolute/);
        expect(message).not.toContain("PLANTED");
      }
    });

  it("does not flag ordinary paths, ids and uuids", () => {
    for (const ok of [
      "/var/lib/myco/inbox",
      "fc-v1-001",
      "/tmp/e7de90f6-5b25-556c-a28a-f9c89a56848a/x",
      "30 2 * * *",
      "MYCO_WEBHOOK_SECRET",
    ])
      expect(looksLikeSecret(ok), ok).toBe(false);
  });
});
