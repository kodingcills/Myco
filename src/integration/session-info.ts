/**
 * §5 desktop-proof gate CLI — TIF-209 (F16). Contract, exit codes, and token
 * handling: `src/integration/session-info-core.ts`.
 *
 * Usage:
 *   pnpm exec tsx src/integration/session-info.ts [--token-file PATH]
 *
 * This file is only the entry point and runs unconditionally. It has no
 * `import.meta.url === argv[1]` check: that check is false when the script is
 * reached through a symlinked path (macOS `/tmp` → `/private/tmp`), and a CLI
 * whose exit 0 means "desktop proof passed" must never exit 0 without running
 * the proof. Tests import `session-info-core.ts`, never this file.
 */

import { main } from "./session-info-core.ts";

main();
