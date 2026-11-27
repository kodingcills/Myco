/**
 * Test-only synthetic upstream checkout (#682): the OSWorld layout in miniature, with metric
 * modules that need nothing beyond the Python standard library, so the importer and the
 * evaluator driver are exercised in every CI job. Labelled MOCK wherever a verdict is shown.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { UpstreamPin } from "../../src/benchmark/upstream/import.ts";
import { MYCO_FLEET, OSWORLD_HARNESS, OSWORLD_PIN } from "../../src/benchmark/upstream/pins.ts";
import type { HarnessStamp } from "../../src/benchmark/upstream/r1-grade.ts";

/**
 * The stamp of a run on the pinned harness: upstream files at their pinned digests, the
 * documented patches applied, on the myco-fleet provider with a digest-pinned image (or, for
 * the parity reference, on utm-reference with its pinned files).
 */
export function pinnedStamp(provider: "myco-fleet" | "utm-reference" = "myco-fleet"): HarnessStamp {
  return {
    repo: OSWORLD_HARNESS.repo,
    commit: OSWORLD_PIN.commit,
    files: { ...OSWORLD_HARNESS.files, ...OSWORLD_HARNESS.patchedFiles },
    provider,
    imageDigest: provider === "myco-fleet" ? `sha256:${"a".repeat(64)}` : null,
    fleetFiles: { ...(provider === "myco-fleet" ? MYCO_FLEET.files : MYCO_FLEET.referenceFiles) },
  };
}

export const SYN_LICENSE = "Synthetic license text for tests.\n";

/** Metric modules: `text.py` defines file-comparing metrics and imports a helper via the package. */
export const SYN_METRICS: Record<string, string> = {
  "__init__.py": "raise ImportError('the package __init__ must never run')\n",
  "helpers.py":
    "def read(path):\n    with open(path, 'r', encoding='utf-8') as f:\n        return f.read()\n",
  "text.py": [
    "import os",
    "from desktop_env.evaluators.metrics.helpers import read",
    "",
    "def same_text(result, expected, **options):",
    "    print('noise on stdout from an upstream metric')",
    "    if result is None:",
    "        return 0.0",
    "    a, b = read(result), read(expected)",
    "    if options.get('ignore_case'):",
    "        a, b = a.lower(), b.lower()",
    "    return 1.0 if a == b else 0.0",
    "",
    "def has_rule_word(result, rules, **options):",
    "    if result is None:",
    "        return 0.0",
    "    return 1.0 if rules['word'] in read(result) else 0.0",
    "",
    "def half(result, expected, **options):",
    "    return 0.5",
    "",
    "def env_probe(result, expected, **options):",
    "    return 1.0 if os.environ.get('MYCO_UPSTREAM_PROBE_SECRET') else 0.0",
    "",
    "def boom(result, expected, **options):",
    "    raise ValueError('upstream metric raised')",
    "",
  ].join("\n"),
  "other.py": "def unrelated(result, **options):\n    return 1.0\n",
};

export interface SynTask {
  readonly domain: string;
  readonly id: string;
  readonly body: Record<string, unknown>;
}

export const fileEval = (func: string | string[], extra: Record<string, unknown> = {}) => ({
  func,
  result: { type: "vm_file", path: "/home/user/out.txt", dest: "out.txt" },
  expected: { type: "cloud_file", path: "https://example.invalid/gold.txt", dest: "gold.txt" },
  ...extra,
});

export const SYN_TASKS: SynTask[] = [
  {
    domain: "libreoffice_calc",
    id: "calc-0001",
    body: {
      instruction: "Type HELLO into the file.  Keep  the spacing.",
      related_apps: ["libreoffice calc"],
      config: [
        {
          type: "download",
          parameters: { files: [{ url: "https://example.invalid/seed.xlsx", path: "/x" }] },
        },
      ],
      evaluator: fileEval("same_text", { postconfig: [{ type: "sleep" }] }),
    },
  },
  {
    domain: "libreoffice_calc",
    id: "calc-0002",
    body: {
      instruction: "Impossible task.",
      related_apps: ["libreoffice_calc"],
      evaluator: { func: "infeasible" },
    },
  },
  {
    domain: "libreoffice_writer",
    id: "writer-0001",
    body: {
      instruction: "Mention the rule word.",
      related_apps: ["libreoffice writer"],
      evaluator: {
        func: ["has_rule_word", "same_text"],
        conj: "and",
        result: [
          { type: "vm_file", path: "/a" },
          { type: "vm_file", path: "/b" },
        ],
        expected: [
          { type: "rule", rules: { word: "rule" } },
          { type: "cloud_file", path: "https://example.invalid/g.txt" },
        ],
        options: [{}, { ignore_case: true }],
      },
    },
  },
  {
    domain: "libreoffice_impress",
    id: "impress-0001",
    body: {
      instruction: "Probe the guest.",
      related_apps: ["libreoffice_impress"],
      evaluator: {
        func: "same_text",
        result: { type: "vm_command_line", command: "ls" },
        expected: { type: "cloud_file", path: "https://example.invalid/g.txt" },
      },
    },
  },
  {
    domain: "multi_apps",
    id: "multi-0001",
    body: {
      instruction: "Calc and Chrome.",
      related_apps: ["libreoffice_calc", "chrome"],
      proxy: true,
      evaluator: fileEval("same_text"),
    },
  },
  {
    domain: "multi_apps",
    id: "multi-0002",
    body: {
      instruction: "GIMP only: not an office task.",
      related_apps: ["gimp"],
      evaluator: fileEval("same_text"),
    },
  },
];

export const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");

export function synPin(): UpstreamPin {
  return {
    name: "OSWorld",
    repo: "https://example.invalid/osworld",
    commit: "0".repeat(40),
    license: "Apache-2.0",
    licenseFile: "LICENSE",
    licenseSha256: sha(SYN_LICENSE),
  };
}

/** Write the synthetic checkout to a fresh temp dir and return its root. */
export function writeSyntheticUpstream(tasks: SynTask[] = SYN_TASKS): string {
  const root = mkdtempSync(join(tmpdir(), "myco-syn-upstream-"));
  const put = (rel: string, text: string) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  put("LICENSE", SYN_LICENSE);
  for (const [name, text] of Object.entries(SYN_METRICS))
    put(`desktop_env/evaluators/metrics/${name}`, text);
  put("desktop_env/__init__.py", "raise ImportError('the package __init__ must never run')\n");
  put("desktop_env/evaluators/__init__.py", "raise ImportError('never')\n");
  const listed: Record<string, string[]> = {
    libreoffice_calc: [],
    libreoffice_writer: [],
    libreoffice_impress: [],
    multi_apps: [],
    chrome: ["not-imported"],
  };
  for (const t of tasks) {
    listed[t.domain]?.push(t.id);
    put(
      `evaluation_examples/examples/${t.domain}/${t.id}.json`,
      `${JSON.stringify({ id: t.id, snapshot: t.domain, ...t.body }, null, 2)}\n`,
    );
  }
  put("evaluation_examples/test_all.json", `${JSON.stringify(listed, null, 2)}\n`);
  return root;
}
