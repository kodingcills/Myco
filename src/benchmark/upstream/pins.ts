/**
 * Pinned upstream commits for the public-benchmark task sets (#675, #682). Changing a pin is a
 * new task-set version, never an edit of a published one: the manifests under
 * `benchmark/upstream/` record these values and the importer refuses a checkout whose HEAD or
 * license bytes differ.
 */
import type { UpstreamPin } from "./import.ts";

export const OSWORLD_PIN: UpstreamPin = {
  name: "OSWorld",
  repo: "https://github.com/xlang-ai/OSWorld",
  commit: "0ad41bee56565efe7bb3c3a5ebc67590a1b8276f",
  license: "Apache-2.0",
  licenseFile: "LICENSE",
  licenseSha256: "a8d1d88a0f9cce3cdbff73b03a80dc5e5d69e3ba2443946c268815a550c9e0ec",
};

export const WAA_PIN: UpstreamPin = {
  name: "WindowsAgentArena",
  repo: "https://github.com/microsoft/WindowsAgentArena",
  commit: "eb220c4dcf64babefc1bfc287edda91ab04132ed",
  license: "MIT",
  licenseFile: "LICENSE",
  licenseSha256: "9906940f61b1f0b533fa7d99baf55178b2808fbe113ea51dfbfad8572ccd5f2b",
};

/**
 * The public-benchmark R1 harness (lead ruling 2026-11-27 ~13:55Z, #700 comment 7220110528):
 * OSWorld's OWN environment, action server, evaluator and Claude runner, unmodified, at
 * OSWORLD_PIN.commit. Myco adds only the DONE gate (src/gate-hooks/osworld/). Each file is
 * pinned by SHA-256; the R1 grader (`./r1-grade.ts`) refuses a run whose recorded harness is
 * not exactly this, and the upstream CI job re-hashes the files in a fresh clone.
 */
export const OSWORLD_HARNESS = {
  repo: OSWORLD_PIN.repo,
  commit: OSWORLD_PIN.commit,
  /** The standard computer-use agent runner for Claude at the pin. */
  agentRunner: "scripts/python/run_multienv_claude.py",
  /** The per-task loop the runner calls: predict -> env.step -> env.evaluate() -> result.txt. */
  taskLoop: "lib_run_single.py#run_single_example",
  /** The agent class the runner constructs, and its action space. */
  agent: "mm_agents/anthropic/main.py#AnthropicAgent",
  actionSpace: "claude_computer_use",
  observationType: "screenshot",
  /** The environment, its in-VM controller, and the evaluation path used as R1 ground truth. */
  environment: "desktop_env/desktop_env.py#DesktopEnv",
  controller: "desktop_env/controllers/python.py#PythonController",
  grader: "desktop_env/desktop_env.py#DesktopEnv.evaluate",
  /**
   * SHA-256 of the runner after src/gate-hooks/osworld/run_multienv_claude.gate.patch (the
   * documented patch surface). All three arms run this same patched runner; arms no-gate and
   * self-check bypass the gate by configuration. A run stamp must carry this digest for the
   * runner file and the upstream digest for every other harness file.
   */
  patchedAgentRunnerSha256: "d08496bd4ae6b72c1c0a8d3f1b0b9100ef468512ffb58b6ca19c98a5489f8373",
  patch: "src/gate-hooks/osworld/run_multienv_claude.gate.patch",
  /** Providers the pinned runner's --provider_name accepts. */
  providers: ["aws", "virtualbox", "vmware", "docker", "azure", "pyromind"],
  files: {
    "scripts/python/run_multienv_claude.py":
      "6f230557ada2f231b71d6d27cc052f85d062d75cc17f82445bbb17be18aa102d",
    "lib_run_single.py": "a326823fc3ee1d76dcdb6ae56986620bcf9be39978f9ebe4309867d8ded82780",
    "desktop_env/desktop_env.py":
      "169f0f196bfa8083e1e3eba329a64c7a2c00284705afc7d47c381f4b4fd1033c",
    "desktop_env/controllers/python.py":
      "385263ab94271557deb904cdcf666dae324753d59896d1f011084ba7da8b2205",
    "desktop_env/controllers/setup.py":
      "bfc3450d7b732ea4eada0afc4a77dd21fc3e80fc1a43d1c07bede2d93c16e4f8",
    "mm_agents/anthropic/main.py":
      "809aab83d3492bedcd12c6bcc3318b7939f5e247db469e26934512a719309441",
    "mm_agents/anthropic/utils.py":
      "8171db9085fa4f67c2a77c5ae1e970d58b82fb140f0f559aec40d7302e7ea9e8",
  } as Readonly<Record<string, string>>,
} as const;
