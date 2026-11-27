/**
 * The Myco Linux fleet for the public R1 (lead rulings 2026-11-27 14:05Z, 14:37Z, 15:21Z; #741
 * round-1 verdict B1 a-c). MOCK, plumbing only: nothing here builds or starts the image, a
 * container or a VM. test/benchmark/osworld_fleet_check.py records what the provider, the UTM
 * reference provider and the parity harness did against fakes; every assertion is here.
 *
 * Claims proved:
 *  - the image definition has the accessibility stack (LibreOffice's GTK3 VCL plugin, the AT-SPI
 *    bus started before any LibreOffice, pyatspi) and OSWorld's action interface (PyAutoGUI and
 *    python3-xlib at upstream's pinned versions, hash-pinned), and runs OSWorld's own controller
 *    server at the pin, byte-verified and unmodified;
 *  - the provider refuses a desktop whose accessibility tree, pyautogui/python-xlib or
 *    screenshot is missing (a stand-in controller per failure), and a desktop is used only when
 *    all three answer; it refuses an image not pinned by digest and never downloads;
 *  - the provider files are pinned by SHA-256 in the harness stamp (pins.ts MYCO_FLEET);
 *  - the parity harness runs each pre-declared sequence through a DesktopEnv and records the
 *    score evaluate() returned, refuses the reference run without an approval link, and its
 *    records feed parity.ts, which passes only when every task matches.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { UpstreamTask } from "../../src/benchmark/upstream/import.ts";
import { sha256Hex } from "../../src/benchmark/upstream/import.ts";
import {
  assessParity,
  type ParityRecord,
  type ParitySample,
  paritySampleProblems,
} from "../../src/benchmark/upstream/parity.ts";
import { MYCO_FLEET, OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import { preregSha256 } from "../../src/benchmark/upstream/prereg.ts";
import { OSWORLD_EVALUATE_GRADER } from "../../src/benchmark/upstream/r1-grade.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const FLEET = join(ROOT, "src/benchmark/upstream/fleet");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const DOCKERFILE = read("src/benchmark/upstream/fleet/Dockerfile");
const START = read("src/benchmark/upstream/fleet/start.sh");
const REQS = read("src/benchmark/upstream/fleet/requirements-fleet.txt");
const OSW = process.env.MYCO_UPSTREAM_OSWORLD ?? "";
const REQUIRED = process.env.MYCO_UPSTREAM_REQUIRED === "1";
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const work = mkdtempSync(join(tmpdir(), "myco-fleet-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** apt packages the desktop stage installs (the second `apt-get install`). */
const APT = (() => {
  const stage = DOCKERFILE.slice(DOCKERFILE.lastIndexOf("\nFROM "));
  const m = stage.match(/apt-get install -y --no-install-recommends([\s\S]*?)&&/);
  return new Set((m?.[1] ?? "").replace(/\\\n/g, " ").split(/\s+/).filter(Boolean));
})();

describe("fleet image definition: the a11y stack and OSWorld's action interface (14:37Z gaps 1 and 2)", () => {
  it("installs LibreOffice with its GTK3 VCL plugin and the AT-SPI stack, and selects the plugin", () => {
    for (const pkg of [
      "libreoffice-calc",
      "libreoffice-writer",
      "libreoffice-impress",
      "libreoffice-gtk3",
      "at-spi2-core",
      "libatk-adaptor",
      "libatk-bridge2.0-0",
      "python3-pyatspi",
      "gir1.2-atspi-2.0",
      "dbus",
      "dbus-x11",
      "xvfb",
      "openbox",
      "wmctrl",
      "xdotool",
      "python-is-python3",
      "ffmpeg",
    ])
      expect(APT.has(pkg), pkg).toBe(true);
    expect(DOCKERFILE).toMatch(/^\s+SAL_USE_VCLPLUGIN=gtk3 \\$/m);
    expect(DOCKERFILE).toMatch(/^\s+GTK_MODULES=gail:atk-bridge \\$/m);
  });

  it("installs PyAutoGUI 0.9.54 and python3-xlib 0.15 (upstream's pins), every package hash-pinned", () => {
    expect(DOCKERFILE).toContain(
      "pip install --no-cache-dir --require-hashes --no-deps --no-build-isolation -r /tmp/requirements-fleet.txt",
    );
    const pkgs = [
      ...REQS.matchAll(
        /^([A-Za-z0-9_.-]+)==([^ ]+) \\\n((?:\s+--hash=sha256:[0-9a-f]{64}(?: \\)?\n?)+)/gm,
      ),
    ];
    const names = pkgs.map((m) => `${m[1]}==${m[2]}`);
    expect(names).toEqual(
      expect.arrayContaining(["PyAutoGUI==0.9.54", "python3-xlib==0.15", "Pillow==10.1.0"]),
    );
    const declared = REQS.split("\n").filter((l) => /^[A-Za-z]/.test(l));
    expect(declared).toHaveLength(pkgs.length);
  });

  it("runs OSWorld's own controller server at the pin, byte-verified against pinned digests, unmodified", () => {
    expect(DOCKERFILE).toContain(`ARG OSWORLD_COMMIT=${OSWORLD_PIN.commit}`);
    expect(DOCKERFILE).toContain("RUN cd /osworld && sha256sum -c /server.sha256");
    expect(DOCKERFILE).toContain(
      "COPY --from=osworld-server --chown=user:user /osworld/desktop_env/server/ /home/user/server/",
    );
    const lines = read("src/benchmark/upstream/fleet/server.sha256").trim().split("\n");
    const pinned = Object.fromEntries(lines.map((l) => l.split(/\s+/).reverse()));
    expect(Object.keys(pinned).sort()).toEqual([
      "desktop_env/server/__init__.py",
      "desktop_env/server/main.py",
      "desktop_env/server/pyxcursor.py",
      "desktop_env/server/screen_recording.py",
    ]);
    for (const [rel, digest] of Object.entries(pinned))
      expect(OSWORLD_HARNESS.files[rel], rel).toBe(digest);
    // The controller server runs as its osworld_server.service runs it.
    expect(START.trimEnd().split("\n").at(-1)).toBe(
      "exec /usr/bin/python /home/user/server/main.py",
    );
  });

  it("starts the AT-SPI bus and registry before anything that could start LibreOffice", () => {
    const pos = (s: string) => START.indexOf(s);
    const order = [
      "Xvfb :0 -screen 0 1920x1080x24",
      'eval "$(dbus-launch --sh-syntax)"',
      "/usr/libexec/at-spi-bus-launcher --launch-immediately",
      "org.a11y.Bus.GetAddress",
      "/usr/libexec/at-spi2-registryd",
      "exec /usr/bin/python /home/user/server/main.py",
    ].map(pos);
    expect(order.every((p) => p >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No LibreOffice starts in the entrypoint: tasks open it later through the server.
    const code = START.split("\n").filter((l) => !l.trim().startsWith("#"));
    expect(code.join("\n")).not.toMatch(/soffice|libreoffice/i);
    expect(spawnSync("sh", ["-n", join(FLEET, "start.sh")]).status).toBe(0);
  });

  it("saves Office formats on a bare Ctrl+S (OSWorld's postconfigs do) and never fetches OSWorld's VM image", () => {
    expect(read("src/benchmark/upstream/fleet/registrymodifications.xcu")).toMatch(
      /<prop oor:name="WarnAlienFormat" oor:op="fuse"><value>false<\/value><\/prop>/,
    );
    expect(DOCKERFILE).not.toMatch(/huggingface|\.qcow2|\.vmdk|Ubuntu-arm|happysixd/i);
    expect(DOCKERFILE).toMatch(/^EXPOSE 5000$/m);
  });
});

describe("fleet pins", () => {
  it("pins every fleet file by SHA-256 in the harness stamp", () => {
    for (const set of [MYCO_FLEET.files, MYCO_FLEET.referenceFiles])
      for (const [rel, digest] of Object.entries(set))
        expect(sha256Hex(readFileSync(join(ROOT, rel))), rel).toBe(digest);
    expect(MYCO_FLEET.files[MYCO_FLEET.adapter]).toBeDefined();
    expect(MYCO_FLEET.files[MYCO_FLEET.image]).toBeDefined();
    expect(
      MYCO_FLEET.files["src/benchmark/upstream/fleet/desktop_env_providers.patch"],
    ).toBeDefined();
  });
});

describe.runIf(hasPython)(
  "fleet provider, UTM reference provider and parity harness (MOCK, fakes only)",
  () => {
    const done = spawnSync(
      "python3",
      ["-I", join(ROOT, "test/benchmark/osworld_fleet_check.py"), FLEET, work, OSW],
      { encoding: "utf8", timeout: 120_000, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" } },
    );
    if (done.status !== 0) throw new Error(`check script failed: ${done.stderr}`);
    const report = JSON.parse(readFileSync(join(work, "report.json"), "utf8"));
    type Start = {
      error: string | null;
      ip: string | null;
      docker: string[][];
      containerAfter: unknown;
    };

    it("a desktop is ready only when screenshot, the AT-SPI tree and pyautogui with python-xlib all answer", () => {
      expect(report.ready).toEqual({
        healthy: [],
        noA11y: ["A11Y_TREE_UNAVAILABLE"],
        a11yNotTree: ["A11Y_TREE_UNAVAILABLE"],
        noPyautogui: ["PYAUTOGUI_UNAVAILABLE"],
        noXlib: ["PYAUTOGUI_UNAVAILABLE"],
        wrongSize: ["PYAUTOGUI_UNAVAILABLE"],
        noScreenshot: ["SCREENSHOT_UNAVAILABLE"],
      });
      expect(report.readyUnreachable).toEqual([
        "SCREENSHOT_UNAVAILABLE",
        "A11Y_TREE_UNAVAILABLE",
        "PYAUTOGUI_UNAVAILABLE",
      ]);
    });

    it("the readiness probe is a pyautogui command through the controller's /execute, run as DesktopEnv runs actions (python -c), opening the X display with python-xlib", () => {
      const sent = report.executeSent as { command: string[]; shell: boolean };
      expect(sent.shell).toBe(false);
      expect(sent.command.slice(0, 2)).toEqual(["python", "-c"]);
      expect(sent.command[2]).toBe(report.constants.probe);
      expect(sent.command[2]).toMatch(
        /import pyautogui, Xlib\.display; Xlib\.display\.Display\(\)/,
      );
      expect(report.constants.screen).toEqual([1920, 1080]);
    });

    it("starts one digest-pinned container with the guest ports on 127.0.0.1 only, reports DesktopEnv's host:server:chromium:vnc:vlc, and a revert removes the container", () => {
      const s = report.start.healthy as Start;
      expect(s.error).toBeNull();
      const run = s.docker[0] as string[];
      expect(run.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
      expect(run.at(-1)).toBe(`myco-osworld-desktop@sha256:${"a".repeat(64)}`);
      const published = run.flatMap((a, i) => (a === "-p" ? [run[i + 1]] : []));
      expect(published).toEqual([
        "127.0.0.1::5000",
        "127.0.0.1::9222",
        "127.0.0.1::8006",
        "127.0.0.1::8080",
      ]);
      expect(run).toContain("--memory=2g");
      expect(s.ip).toMatch(/^127\.0\.0\.1:\d+:\d+:\d+:\d+$/);
      const name = run[run.indexOf("--name") + 1] as string;
      expect(name).toMatch(/^myco-fleet-[0-9a-f]{12}$/);
      expect(s.docker.at(-1)).toEqual(["rm", "-f", name]);
      expect(s.containerAfter).toBeNull();
      expect(report.constants.provider).toBe(MYCO_FLEET.provider);
    });

    it("refuses and removes a desktop whose a11y tree or pyautogui/python-xlib is missing; never uses it", () => {
      for (const [mode, code] of [
        ["noA11y", "A11Y_TREE_UNAVAILABLE"],
        ["noPyautogui", "PYAUTOGUI_UNAVAILABLE"],
        ["noXlib", "PYAUTOGUI_UNAVAILABLE"],
      ] as const) {
        const s = report.start[mode] as Start;
        expect(s.error, mode).toBe(code);
        expect(s.ip, mode).toBeNull();
        expect(s.docker.at(-1)?.slice(0, 2), mode).toEqual(["rm", "-f"]);
        expect(s.containerAfter, mode).toBeNull();
      }
    });

    it("refuses an image not pinned by digest (no docker call), and its manager never downloads", () => {
      expect(report.startTagImage).toMatchObject({ error: "IMAGE_NOT_DIGEST_PINNED", docker: [] });
      expect(report.imageRefs).toEqual({
        [`myco-osworld-desktop@sha256:${"a".repeat(64)}`]: [],
        "myco-osworld-desktop:local": ["IMAGE_NOT_DIGEST_PINNED"],
        "": ["IMAGE_NOT_DIGEST_PINNED"],
        [`x@sha256:${"a".repeat(63)}`]: ["IMAGE_NOT_DIGEST_PINNED"],
        [`ubuntu@sha256:${"A".repeat(64)}`]: ["IMAGE_NOT_DIGEST_PINNED"],
      });
      expect(report.manager).toEqual({
        digest: `myco-osworld-desktop@sha256:${"a".repeat(64)}`,
        tag: "ERR:IMAGE_NOT_DIGEST_PINNED",
        unset: "ERR:IMAGE_NOT_DIGEST_PINNED",
        otherScreen: "ERR:SCREEN_SIZE_UNSUPPORTED",
        freeVms: [],
      });
      expect(report.saveState).toBe("NotImplementedError");
      const src = read("src/benchmark/upstream/fleet/myco_fleet_provider.py");
      expect(src).not.toMatch(/huggingface|requests\.get|urlretrieve|docker pull|"pull"/);
    });

    it("the UTM reference provider starts the VM in disposable mode, uses only a 127.0.0.1 forward, and refuses a guest without the a11y tree", () => {
      expect(report.utm.calls).toEqual([
        ["start", "--disposable", "OSWorld Ubuntu arm"],
        ["stop", "OSWorld Ubuntu arm"],
      ]);
      expect(report.utm.ip).toMatch(/^127\.0\.0\.1:\d+:9222:8006:8080$/);
      expect(report.utm.badEndpoint).toBe("REFERENCE_ENDPOINT_INVALID");
      expect(report.utm.noA11y).toBe("A11Y_TREE_UNAVAILABLE");
      expect(report.utm.noA11yCalls.at(-1)).toEqual(["stop", "OSWorld Ubuntu arm"]);
      expect(report.constants.ref).toBe(MYCO_FLEET.referenceProvider);
    });

    describe("the parity harness", () => {
      const sample = JSON.parse(readFileSync(join(work, "sample.json"), "utf8")) as ParitySample;
      const subset = new Set(sample.tasks.map((t) => t.taskId));
      const p = report.parity as Record<string, ParityRecord[]> & Record<string, unknown>;
      /** The fake checkout has no harness files; give the records the pinned OSWorld files. */
      const pinned = (rs: ParityRecord[]) =>
        rs.map((r) => ({
          ...r,
          stamp: {
            ...r.stamp,
            files: { ...OSWORLD_HARNESS.files, ...OSWORLD_HARNESS.patchedFiles },
          },
        }));

      it("runs every declared sequence through DesktopEnv (reset, steps, evaluate, close) and records the score, sample hash, grader and stamp", () => {
        const fleet = p.fleet as ParityRecord[];
        expect(fleet.map((r) => `${r.taskId}:${r.sequence}:${r.score}`)).toEqual([
          "calc-a:known-good:1",
          "calc-a:known-bad:0",
          "writer-b:known-good:1",
          "writer-b:known-bad:0",
        ]);
        for (const r of fleet) {
          expect(r).toMatchObject({
            label: "LIVE-SCRIPTED",
            env: "fleet",
            provider: "myco-fleet",
            graderVersion: OSWORLD_EVALUATE_GRADER,
            sampleSha256: preregSha256(sample),
            hostLabel: "synthetic-host",
          });
          expect(r.stamp).toMatchObject({
            commit: OSWORLD_PIN.commit,
            imageDigest: `sha256:${"a".repeat(64)}`,
          });
          expect(r.stamp.fleetFiles).toEqual(MYCO_FLEET.files);
        }
        for (const r of p.reference as ParityRecord[]) {
          expect(r.stamp.fleetFiles).toEqual(MYCO_FLEET.referenceFiles);
          expect(r.stamp.imageDigest).toBeNull();
        }
        expect(p.sampleSha256).toBe(preregSha256(sample));
        expect(p.grader).toBe(OSWORLD_EVALUATE_GRADER);
        const log = (p.envLog as unknown as [string, string][]).slice(0, 4);
        expect(log).toEqual([
          ["reset", "calc-a"],
          ["close", "calc-a"],
          ["reset", "calc-a"],
          ["close", "calc-a"],
        ]);
      });

      it("records a run that raises as ungradable (score null), never a score; refuses a changed task file", () => {
        const raised = (p.fleetRaises as ParityRecord[]).filter((r) => r.taskId === "calc-a");
        expect(raised.map((r) => [r.score, (r as unknown as { error: string }).error])).toEqual([
          [null, "RUN_RAISED"],
          [null, "RUN_RAISED"],
        ]);
        expect(p.taskChanged).toBe("TASK_FILE_CHANGED");
      });

      it("refuses the reference run without an approval link, an unlabelled host, and a fleet image not pinned by digest", () => {
        expect(report.parityMain).toEqual({
          referenceUnapproved: "REFERENCE_RUN_NOT_APPROVED",
          referenceBadApproval: "REFERENCE_RUN_NOT_APPROVED",
          fleetNoImage: "IMAGE_NOT_DIGEST_PINNED",
          fleetTagImage: "IMAGE_NOT_DIGEST_PINNED",
          unlabelled: "HOST_UNLABELLED",
        });
      });

      it("its records feed parity.ts: matching envs pass; a gap, an ungradable fleet run or a missing env does not", () => {
        const ok = assessParity(
          sample,
          subset,
          pinned([...(p.fleet as ParityRecord[]), ...(p.reference as ParityRecord[])]),
        );
        expect(ok.reasons).toEqual([]);
        expect(ok.passed).toBe(true);
        expect(ok.tasks.map((t) => t.verdict)).toEqual(["MATCH", "MATCH"]);
        const gap = assessParity(
          sample,
          subset,
          pinned([...(p.fleetGap as ParityRecord[]), ...(p.reference as ParityRecord[])]),
        );
        expect(gap.passed).toBe(false);
        expect(gap.reasons).toEqual(["TASK_GAP:writer-b"]);
        const raised = assessParity(
          sample,
          subset,
          pinned([...(p.fleetRaises as ParityRecord[]), ...(p.reference as ParityRecord[])]),
        );
        expect(raised.reasons).toEqual(["TASK_GAP:calc-a"]);
        const fleetOnly = assessParity(sample, subset, pinned(p.fleet as ParityRecord[]));
        expect(fleetOnly.reasons).toEqual(["TASK_INCOMPLETE:calc-a", "TASK_INCOMPLETE:writer-b"]);
        // The harness's own stamps (no OSWorld files in the fake checkout) are refused.
        const unpinned = assessParity(sample, subset, [
          ...(p.fleet as ParityRecord[]),
          ...(p.reference as ParityRecord[]),
        ]);
        expect(unpinned.passed).toBe(false);
        expect(unpinned.reasons[0]).toMatch(/^RECORD_HARNESS_NOT_PINNED:fleet:calc-a:known-good$/);
      });
    });

    it("the parity harness stamps the same OSWorld and Myco files the pins name", () => {
      expect([...(report.parity.harnessFiles as string[])].sort()).toEqual(
        Object.keys(OSWORLD_HARNESS.files).sort(),
      );
      expect(report.parity.fleetFiles).toEqual({
        "myco-fleet": Object.keys(MYCO_FLEET.files),
        "utm-reference": Object.keys(MYCO_FLEET.referenceFiles),
      });
    });

    describe.runIf(Boolean(OSW) || REQUIRED)(
      "against upstream's provider registry at the pin",
      () => {
        it("the registration patch applies and create_vm_manager_and_provider resolves myco-fleet and utm-reference", () => {
          expect(report.registry?.stderr).toBe("");
          expect(report.registry).toMatchObject({
            applied: 0,
            classes: [
              "MycoFleetVMManager",
              "MycoFleetProvider",
              "UtmReferenceVMManager",
              "UtmReferenceProvider",
            ],
          });
        });
      },
    );
  },
);

describe("measure.sh: re-runnable, host-labelled, guarded, and actively driven (B1 d)", () => {
  const SCRIPT = join(FLEET, "measure.sh");
  const SRC = read("src/benchmark/upstream/fleet/measure.sh");
  const guard = (swap: string, pct: string, add: string) =>
    spawnSync("bash", [SCRIPT, "guard-check", swap, pct, add], { encoding: "utf8" });

  it("stops at 300 MB free swap, 20% free memory, or a step over ~1 GiB, and goes on otherwise", () => {
    expect(spawnSync("bash", ["-n", SCRIPT]).status).toBe(0);
    const cases: [string, string, string, number, string][] = [
      ["299", "50", "512", 1, "STOP: host swap free 299 MiB < 300 MiB"],
      ["300", "50", "512", 0, "OK"],
      ["1400.5", "19", "512", 1, "STOP: host free memory 19% < 20%"],
      ["1400", "20", "512", 0, "OK"],
      ["1400", "52", "1025", 1, "STOP: step would add ~1025 MiB > 1024 MiB"],
      ["1400", "52", "1024", 0, "OK"],
    ];
    for (const [swap, pct, add, status, out] of cases) {
      const r = guard(swap, pct, add);
      expect(r.status, `${swap} ${pct} ${add}`).toBe(status);
      expect(r.stdout.trim(), `${swap} ${pct} ${add}`).toBe(out);
    }
    // Every scale-up step and the active run go through the guard first.
    expect(SRC).toMatch(/guard_ok \$\(\( \(k - prev\) \* per \)\) \|\| \{ log scale/);
    expect(SRC).toMatch(/guard_ok \$\(\( k \* \$\{PER_MIB:-600\} \)\) \|\| \{ log active/);
  });

  it("refuses to measure without a host label, before touching docker, and labels every line with it", () => {
    const bin = mkdtempSync(join(work, "bin-"));
    const marker = join(bin, "docker-was-called");
    writeFileSync(join(bin, "docker"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    const r = spawnSync("bash", [SCRIPT, "cleanup"], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOST_LABEL: "",
        OUT_DIR: join(bin, "out"),
        READY_TIMEOUT: "1",
      },
      timeout: 15_000,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/^MEASURE_HOST_UNLABELLED/);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(bin, "out"))).toBe(false);
    expect(SRC).toMatch(/printf '\{"ts":"%s","host":"%s","hostOs":"%s","hostArch":"%s"/);
  });

  it("measures RAM per desktop, cold start to the controller, the AT-SPI tree and Calc in that tree, and max concurrency", () => {
    for (const metric of [
      "controller_ready",
      "a11y_ready",
      "calc_in_a11y",
      "mem_stats",
      "mem_cgroup",
      "mem_avg_stats_idle",
      "max_concurrency",
      "image_size",
    ])
      expect(SRC, metric).toContain(` ${metric} `);
    expect(SRC).toContain('"command": ["libreoffice", "--calc"], "shell": false');
  });

  it("drives desktops actively with scripted pyautogui through the controller's /execute (no model), and records latency and RAM while driven", () => {
    expect(SRC).toMatch(/DRIVE_CMD="import pyautogui, time; pyautogui\.FAILSAFE = False;/);
    expect(SRC).toContain('{"command": ["python", "-c", "%s"], "shell": false}');
    expect(SRC).toContain('"http://127.0.0.1:$p/execute"');
    for (const metric of [
      "driven_actions_ok",
      "driven_latency_p50",
      "driven_latency_p95",
      "mem_avg_stats_driven",
    ])
      expect(SRC, metric).toContain(` ${metric} `);
    expect(SRC).toMatch(/^ACTIVE=\$\{ACTIVE:-1\}$/m);
    expect(SRC).not.toMatch(/anthropic|claude|--model/i);
  });

  it("touches only its own containers and never downloads OSWorld's VM image", () => {
    expect(SRC).toMatch(/^PREFIX=myco-fleet-measure-$/m);
    expect(SRC).toContain('docker ps -aq --filter "name=$PREFIX" | xargs -r docker rm -f');
    expect(SRC).not.toMatch(/huggingface|\.qcow2|\.vmdk|Ubuntu-arm|docker rmi|system prune/i);
  });
});

describe("parity.ts on records (synthetic inputs, not results)", () => {
  const SAMPLE = JSON.parse(read("docs/benchmark/upstream/r1-parity-sample.json")) as ParitySample;
  const TASKS = read("benchmark/upstream/osworld-office-v1/tasks.jsonl")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as UpstreamTask);
  const SUBSET = new Set(TASKS.map((t) => t.taskId));
  const stamp = (provider: "myco-fleet" | "utm-reference") => ({
    repo: OSWORLD_HARNESS.repo,
    commit: OSWORLD_PIN.commit,
    files: { ...OSWORLD_HARNESS.files, ...OSWORLD_HARNESS.patchedFiles },
    provider,
    imageDigest: provider === "myco-fleet" ? `sha256:${"c".repeat(64)}` : null,
    fleetFiles: { ...(provider === "myco-fleet" ? MYCO_FLEET.files : MYCO_FLEET.referenceFiles) },
  });
  const records = (
    score: (env: string, seq: string, id: string) => number | null = (_e, s) =>
      s === "known-good" ? 1 : 0,
  ) =>
    (["fleet", "reference"] as const).flatMap((env) =>
      SAMPLE.tasks.flatMap((t) =>
        (["known-good", "known-bad"] as const).map(
          (sequence): ParityRecord => ({
            label: "LIVE-SCRIPTED",
            env,
            provider: env === "fleet" ? "myco-fleet" : "utm-reference",
            taskId: t.taskId,
            sequence,
            score: score(env, sequence, t.taskId),
            graderVersion: OSWORLD_EVALUATE_GRADER,
            sampleSha256: preregSha256(SAMPLE),
            hostLabel: "h",
            stamp: stamp(env === "fleet" ? "myco-fleet" : "utm-reference"),
          }),
        ),
      ),
    );
  const first = SAMPLE.tasks[0]?.taskId as string;

  it("the committed sample is sound: five subset tasks in all three domains, their task-file hashes are the manifest's", () => {
    expect(paritySampleProblems(SAMPLE, SUBSET)).toEqual([]);
    const byId = new Map(TASKS.map((t) => [t.taskId, t]));
    expect(SAMPLE.tasks).toHaveLength(5);
    for (const t of SAMPLE.tasks) {
      const m = byId.get(t.taskId) as UpstreamTask & {
        taskFile: string;
        taskFileSha256: string;
        domain: string;
      };
      expect(t.taskFileSha256, t.taskId).toBe(m.taskFileSha256);
      expect(t.taskFile, t.taskId).toBe(m.taskFile);
      expect(t.domain, t.taskId).toBe(m.domain);
    }
    expect(new Set(SAMPLE.tasks.map((t) => t.domain))).toEqual(
      new Set(["libreoffice_calc", "libreoffice_writer", "libreoffice_impress"]),
    );
    expect(SAMPLE.envs).toMatchObject({
      fleet: { provider: "myco-fleet" },
      reference: { provider: "utm-reference" },
    });
  });

  it("passes only when every task matches; each inadmissible record or mismatch is a coded reason", () => {
    expect(assessParity(SAMPLE, SUBSET, records())).toMatchObject({ passed: true, reasons: [] });
    const cases: [ParityRecord[], string][] = [
      [
        records((e, s, id) =>
          e === "fleet" && id === first && s === "known-bad" ? 1 : s === "known-good" ? 1 : 0,
        ),
        `TASK_GAP:${first}`,
      ],
      [
        records((e, s, id) =>
          e === "fleet" && id === first && s === "known-good" ? null : s === "known-good" ? 1 : 0,
        ),
        `TASK_GAP:${first}`,
      ],
      [
        records((e, s, id) =>
          e === "reference" && id === first && s === "known-good" ? 0 : s === "known-good" ? 1 : 0,
        ),
        `TASK_SEQUENCE_INVALID:${first}`,
      ],
      [
        records((e, s, id) =>
          e === "reference" && id === first && s === "known-bad"
            ? null
            : s === "known-good"
              ? 1
              : 0,
        ),
        `TASK_SEQUENCE_INVALID:${first}`,
      ],
      [records((_e, s) => (s === "known-good" ? 0.99 : 0)), `TASK_SEQUENCE_INVALID:${first}`],
      [records().slice(1), `TASK_INCOMPLETE:${first}`],
      [
        records().map((r, i) => (i === 0 ? { ...r, label: "MOCK" } : r)),
        `RECORD_NOT_LIVE:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, simulated: true } : r)),
        `RECORD_SIMULATED:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, simulated: "false" } : r)),
        `RECORD_SIMULATED:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, graderVersion: "upstream-metric-mock/1" } : r)),
        `RECORD_NOT_UPSTREAM:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, sampleSha256: "0".repeat(64) } : r)),
        `RECORD_OTHER_SAMPLE:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, provider: "docker" } : r)),
        `RECORD_PROVIDER_WRONG:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, stamp: { ...r.stamp, imageDigest: null } } : r)),
        `RECORD_HARNESS_NOT_PINNED:fleet:${first}:known-good`,
      ],
      [
        records().map((r, i) => (i === 0 ? { ...r, hostLabel: " " } : r)),
        `RECORD_HOST_UNLABELLED:fleet:${first}:known-good`,
      ],
      [[...records(), records()[0] as ParityRecord], `RECORD_DUPLICATE:fleet:${first}:known-good`],
      [
        [...records(), { ...(records()[0] as ParityRecord), taskId: "not-declared" }],
        "RECORD_NOT_DECLARED:fleet:not-declared:known-good",
      ],
    ];
    for (const [rs, code] of cases) {
      const a = assessParity(SAMPLE, SUBSET, rs);
      expect(a.passed, code).toBe(false);
      expect(a.reasons, code).toContain(code);
    }
    expect(
      records((_e, s) => (s === "known-good" ? 1 : 0)).every((r) => r.simulated === undefined),
    ).toBe(true);
    expect(
      assessParity(
        SAMPLE,
        SUBSET,
        records().map((r) => ({ ...r, simulated: false })),
      ).passed,
    ).toBe(true);
  });

  it("refuses a sample without the before-any-live-run rule, outside the subset, or with a malformed sequence", () => {
    const bad = (over: Partial<ParitySample>) =>
      paritySampleProblems({ ...SAMPLE, ...over }, SUBSET);
    expect(bad({ rule: "check parity" })).toEqual(["PARITY_RULE_MISSING"]);
    expect(
      bad({ envs: { fleet: { provider: "myco-fleet" }, reference: { provider: "vmware" } } }),
    ).toEqual(["PARITY_ENVS_WRONG"]);
    expect(bad({ tasks: [] })).toEqual(["PARITY_SAMPLE_EMPTY"]);
    const t0 = SAMPLE.tasks[0] as ParitySample["tasks"][number];
    expect(bad({ tasks: [{ ...t0, taskId: "x" }] })).toEqual(["PARITY_TASK_OUTSIDE_SUBSET:x"]);
    expect(bad({ tasks: [t0, t0] })).toEqual([`PARITY_TASK_DUPLICATE:${t0.taskId}`]);
    expect(bad({ tasks: [{ ...t0, knownBad: [{ action_type: "tool_use" }] }] })).toEqual([
      `PARITY_SEQUENCE_MALFORMED:${t0.taskId}:knownBad`,
    ]);
    expect(assessParity({ ...SAMPLE, rule: "x" }, SUBSET, records()).reasons).toContain(
      "SAMPLE_INVALID:PARITY_RULE_MISSING",
    );
  });
});
