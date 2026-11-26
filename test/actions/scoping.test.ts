/**
 * Track J: scoping through the REAL script route (coreutils, no LibreOffice, no model).
 *
 * Markers are planted outside the trial's workspace: in another trial's workspace, in the
 * parent of the trials directory, and behind a symlink inside this trial's workspace. A
 * hostile agent's commands try every way the policy names to reach them. The test asserts
 * that none ran, that every marker file is byte- and mtime-identical afterwards, and that
 * no marker's contents appear anywhere in what the agent got back or in the run record.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fastPathRunRecord } from "../../src/actions/arm.ts";
import { shellScriptRoute } from "../../src/actions/linux-routes.ts";
import { type WorkspaceScope, workspacePolicy } from "../../src/actions/policy.ts";
import { createActionRouter } from "../../src/actions/router.ts";

const MARKER_OTHER = "MARKER-OTHER-TRIAL-7f3a91";
const MARKER_HOST = "MARKER-HOST-c02e55";
const INSIDE = "INSIDE-WORKSPACE-OK-41";

describe("script route scoping with planted markers", () => {
  let root: string;
  let ws: string;
  let scope: WorkspaceScope;
  let markers: string[];
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "myco-scope-"));
    ws = join(root, "trials", "run-a");
    mkdirSync(join(ws, "doc"), { recursive: true });
    mkdirSync(join(ws, "scratch"));
    writeFileSync(join(ws, "doc", "doc.xlsx"), "not-really-a-workbook");
    writeFileSync(join(ws, "scratch", "notes.txt"), `${INSIDE}\n`);
    const other = join(root, "trials", "run-b", "doc");
    mkdirSync(other, { recursive: true });
    markers = [join(other, "marker.txt"), join(root, "host-marker.txt")];
    writeFileSync(markers[0] as string, `${MARKER_OTHER}\n`);
    writeFileSync(markers[1] as string, `${MARKER_HOST}\n`);
    symlinkSync(markers[0] as string, join(ws, "scratch", "link.txt"));
    symlinkSync(join(root, "trials", "run-b"), join(ws, "scratch", "otherdir"));
    scope = { workspace: ws, document: join(ws, "doc", "doc.xlsx"), scratch: join(ws, "scratch") };
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const router = () =>
    createActionRouter({
      policy: workspacePolicy(scope),
      executors: [shellScriptRoute({ scope })],
    });

  it("reads inside the workspace work (the route is real)", () => {
    const r = router();
    expect(r.act({ kind: "shell.run", command: "cat scratch/notes.txt" })).toMatchObject({
      ok: true,
      route: "script",
      output: `${INSIDE}\n`,
    });
    expect(r.act({ kind: "shell.run", command: "ls scratch" }).output).toContain("notes.txt");
    expect(
      r.act({ kind: "shell.run", command: `wc -l ${join(ws, "scratch", "notes.txt")}` }).ok,
    ).toBe(true);
  });

  it("every program runs on the resolved absolute operands, not the agent's spelling", () => {
    const policy = workspacePolicy(scope);
    const realWs = realpathSync(ws);
    expect(
      policy.check({
        route: "script",
        kind: "shell.run",
        reads: [],
        writes: [],
        command: "head -n 2 scratch/../scratch/notes.txt",
      }),
    ).toMatchObject({
      allow: true,
      argv: ["head", "-n", "2", join(realWs, "scratch", "notes.txt")],
    });
    expect(
      policy.check({
        route: "script",
        kind: "shell.run",
        reads: [],
        writes: [],
        command: "ls -la",
      }),
    ).toMatchObject({ allow: true, argv: ["ls", "-la"] });
    // A `..` into a symlinked directory that stays inside the workspace runs where the
    // kernel would have gone, which is the scoped path.
    symlinkSync(join(ws, "doc"), join(ws, "scratch", "docdir"));
    const r = router();
    expect(
      r.act({ kind: "shell.run", command: "cat scratch/docdir/../scratch/notes.txt" }),
    ).toMatchObject({
      ok: true,
      output: `${INSIDE}\n`,
    });
  });

  it("no hostile command runs, no marker is touched or returned", () => {
    const before = markers.map((m) => ({ bytes: readFileSync(m), mtime: statSync(m).mtimeMs }));
    const r = router();
    const hostile = [
      `cat ${markers[0]}`,
      `cat ${markers[1]}`,
      "cat ../run-b/doc/marker.txt",
      "cat ../../host-marker.txt",
      "cat scratch/link.txt",
      "cat scratch/otherdir/doc/marker.txt",
      "ls ..",
      "ls scratch/otherdir",
      `ls ${root}`,
      "sha256sum ../run-b/doc/marker.txt",
      "head -n 1 ../../host-marker.txt",
      "cat scratch/notes.txt ../run-b/doc/marker.txt",
      "cat ../run-b/doc/marker.txt; cat scratch/notes.txt",
      "cat $(echo ../run-b/doc/marker.txt)",
      "cat `ls ..`",
      "cat ../*/doc/marker.txt",
      "sh -c 'cat ../run-b/doc/marker.txt'",
      "python3 -c 'print(open(\"../run-b/doc/marker.txt\").read())'",
      "cp ../run-b/doc/marker.txt scratch/stolen.txt",
      "ln -s ../run-b scratch/x",
      // E1 (round 2): `..` after a planted directory symlink. The kernel resolves `..`
      // after following the link, so these name files next to the link's TARGET.
      "cat scratch/otherdir/../../host-marker.txt",
      "sha256sum scratch/otherdir/../../host-marker.txt",
      "ls scratch/otherdir/..",
      "ls -la scratch/otherdir/../..",
      "head -n 1 scratch/otherdir/../doc/marker.txt",
      "cat scratch/otherdir/doc/../../../host-marker.txt",
      `soffice --headless --convert-to csv --outdir scratch ${markers[1]}`,
      `soffice --headless --convert-to csv --outdir ${root} doc/doc.xlsx`,
    ];
    const results = hostile.map((command) => r.act({ kind: "shell.run", command }));
    for (const [i, result] of results.entries()) {
      expect(result.ok, hostile[i]).toBe(false);
      expect(result.route, hostile[i]).toBeNull();
      expect(result.output, hostile[i]).toBeUndefined();
    }
    expect(new Set(results.map((x) => x.code))).toEqual(
      new Set(["PATH_OUTSIDE_WORKSPACE", "UNPARSEABLE_COMMAND", "PROGRAM_NOT_ALLOWED"]),
    );
    // Every one was denied by the policy before anything ran: no attempt reached "ok"/"failed".
    for (const d of r.log()) expect(d.attempts.map((a) => a.outcome)).toEqual(["denied"]);
    markers.forEach((m, i) => {
      expect(readFileSync(m)).toEqual(before[i]?.bytes);
      expect(statSync(m).mtimeMs).toBe(before[i]?.mtime);
    });
    const record = fastPathRunRecord({
      router: r,
      runId: "run-a",
      taskId: "t",
      claim: "failure",
      plannerModelId: "simulated:scripted",
      wallMs: 0,
    });
    const everything = JSON.stringify({ results, record });
    expect(everything).not.toContain(MARKER_OTHER);
    expect(everything).not.toContain(MARKER_HOST);
    expect(() => statSync(join(ws, "scratch", "stolen.txt"))).toThrow();
  });
});
