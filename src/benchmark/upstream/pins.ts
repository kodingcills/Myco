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
 * OSWorld's OWN DesktopEnv, controller and its server, evaluator and Claude runner, at
 * OSWORLD_PIN.commit. Myco adds only the DONE gate and (14:05Z ruling, #741) the `myco-fleet`
 * provider registration (see docs/benchmark/upstream and MYCO_FLEET below). Each file is
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
   * SHA-256 of the runner after the documented gate-hook patch surface
   * (docs/benchmark/upstream/gate-hook.md). All three arms run this same patched runner; arms no-gate and
   * self-check bypass the gate by configuration. A run stamp must carry this digest for the
   * runner file and the upstream digest for every other harness file.
   */
  patchedAgentRunnerSha256: "f1cf97c61b433896f2890ade19db70bdc97307f8232333c230ed1d91f037470e",
  /**
   * Every harness file a run uses patched, with its patched SHA-256: the runner (gate hook
   * plus the `myco-fleet` provider choice) and the two files the provider registration patch
   * (src/benchmark/upstream/fleet/desktop_env_providers.patch) touches. In
   * `desktop_env/desktop_env.py` that patch changes only the two provider-name sets, never
   * `evaluate`. Every other harness file must carry its upstream digest.
   */
  patchedFiles: {
    "scripts/python/run_multienv_claude.py":
      "f1cf97c61b433896f2890ade19db70bdc97307f8232333c230ed1d91f037470e",
    "desktop_env/desktop_env.py":
      "383fc1e64c5aaa22de779645ab7911180878242379413d38fb59e002ed75340d",
    "desktop_env/providers/__init__.py":
      "39a50578665bb0b798e1f7123be9d5e8b079cc4fc703bbcd8e2aed84ac336c43",
  } as Readonly<Record<string, string>>,
  /** Providers the patched runner's --provider_name accepts (upstream's six plus the fleet). */
  providers: ["aws", "virtualbox", "vmware", "docker", "azure", "pyromind", "myco-fleet"],
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
    "desktop_env/providers/__init__.py":
      "dc770371f2f9dfb46d43e2fa4ffa0e492646327b8f49dfa3e0c932f29df08b02",
    "desktop_env/providers/base.py":
      "3c71294f1b63c5b81ae17a2895934adb15c4877aa5a7359c5d5282a4126646eb",
    // OSWorld's controller server, which the fleet image runs unmodified (fleet/server.sha256).
    "desktop_env/server/__init__.py":
      "74a63beb9b241af3b2e7e379d7fcf849e40829378c2d7a130699b2560ce97369",
    "desktop_env/server/main.py":
      "efd969e8b3b272b3694cb66450ddb7c90818970c98bd153f5a2050363cdb88c7",
    "desktop_env/server/pyxcursor.py":
      "87d09a465bf87c3766ac3b8584f80c3288890e874b45d9a56b811b0a4268e840",
    "desktop_env/server/screen_recording.py":
      "68ad468287b11cd1583df361bb06126151f93af97f1807dcd6ed1885bb890d06",
  } as Readonly<Record<string, string>>,
} as const;

/**
 * The Myco Linux fleet (lead rulings 2026-11-27 14:05Z and 14:37Z, #741): the R1 host. Every
 * arm runs OSWorld's DesktopEnv with the `myco-fleet` provider on one digest-pinned image built
 * from these files. A run stamp must carry exactly these digests (`r1-grade.ts`
 * `harnessStampProblems`); test/benchmark/osworld-fleet.test.ts recomputes them from the repo.
 * `referenceFiles` are what the parity reference run uses (`utm-reference`, 15:21Z ruling).
 */
export const MYCO_FLEET = {
  provider: "myco-fleet",
  referenceProvider: "utm-reference",
  adapter: "src/benchmark/upstream/fleet/myco_fleet_provider.py",
  image: "src/benchmark/upstream/fleet/Dockerfile",
  files: {
    "src/benchmark/upstream/fleet/Dockerfile":
      "b71a3c8b589e2d6de663962fa85748450eeb35cf5a1bf14d4413c5a2b1209d83",
    "src/benchmark/upstream/fleet/start.sh":
      "9f0b02c087494ddd8c038fa0f2a0b423e636e5294b35f3bad7663021526c07b0",
    "src/benchmark/upstream/fleet/registrymodifications.xcu":
      "78cba110322b2b28ca6e60fa7cc1676c6c9ca2f1ce471b8856042436e53cc78b",
    "src/benchmark/upstream/fleet/requirements-fleet.txt":
      "c73c523153ec0815703020b66f3c6a6ae0d8f55508be243a90ee35c1e203d080",
    "src/benchmark/upstream/fleet/server.sha256":
      "7310403b5101629194d409b6f36b6bac3cd292bcfef0580a3b0de604aefd7ac1",
    "src/benchmark/upstream/fleet/myco_fleet_provider.py":
      "40d442ab66c59d520a0f0046d19597f4320ac6063def6505845ac18adf130920",
    "src/benchmark/upstream/fleet/desktop_env_providers.patch":
      "70222e0cc0cda0397958b94e4f7fd0370bcbf98aab463551cdf87eac897b2e7d",
  } as Readonly<Record<string, string>>,
  referenceFiles: {
    "src/benchmark/upstream/fleet/myco_fleet_provider.py":
      "40d442ab66c59d520a0f0046d19597f4320ac6063def6505845ac18adf130920",
    "src/benchmark/upstream/fleet/utm_reference_provider.py":
      "515cafae189b00b28380e3ad327783928860f2c2b5a82b11ba81ac10469d0150",
    "src/benchmark/upstream/fleet/desktop_env_providers.patch":
      "70222e0cc0cda0397958b94e4f7fd0370bcbf98aab463551cdf87eac897b2e7d",
  } as Readonly<Record<string, string>>,
} as const;
