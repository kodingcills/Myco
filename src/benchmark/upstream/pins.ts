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
