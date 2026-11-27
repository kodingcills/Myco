/**
 * `myco-l-infra` — track L's zero-contamination run (L-infra): fc-v1's satisfiable tasks at
 * N = 1, 2, 4, 8 on the unprivileged Linux backend, a unique canary per desktop. $0:
 * scripted agents only. See src/parallel/l-infra-cli.ts and docs/product/l-infra/README.md.
 */

import { mainRun } from "../src/parallel/l-infra-cli.ts";

process.exitCode = await mainRun(process.argv.slice(2));
