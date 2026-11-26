# Plugin sandbox: security model (capability track T)

Scope: third-party `myco.plugin/1` plugins (`docs/plugins/byoa.md`). This page says what a
plugin is trusted with, what it is not, how each limit is enforced, how each is tested, and
what is left open.

## Threat model

A plugin is **untrusted code** from outside the repo. Assume it is written to:

1. read things it should not (host files, other trials' captures, secrets, the environment);
2. reach the network (exfiltrate, or fetch a verdict);
3. exhaust the host (hang, allocate, flood output);
4. corrupt the host's view of it (malformed answers, free text in codes, forged responses,
   look-alike registrations, editing itself after registration);
5. pass the R5 self-test without being a good oracle (over-claiming).

The one property that must hold whatever the plugin does: **a plugin failure is never a
`verified`.** Every fault is `uncertain` with a code.

## What a plugin gets

- The captured bytes of one document and its basename, over stdin.
- The task intent (JSON, at most 64 KiB).
- Read access to its own directory and the SDK directory (to load its code).
- A short list of pure builtins (`assert`, `buffer`, `crypto`, `events`, `path`,
  `querystring`, `stream`, `string_decoder`, `timers`, `url`, `util`, `zlib`).

Nothing else: no network, no filesystem outside those two directories, no writes anywhere, no
child processes, workers, native addons or WASI, an empty environment, no host path of the
trial, and no other trial's data.

## Enforcement

| Limit | Mechanism | Test (each mutation-proven) |
|---|---|---|
| Out of process | one `node` child per request (`spawnSync`), no state carried between calls | all of `test/plugins/sandbox.test.ts` |
| No reads outside plugin + SDK | Node permission model: `--permission --allow-fs-read=<sdk> --allow-fs-read=<plugin>`; no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` | `fsImport`, `bindingFs`, `write` probes |
| No network | Node 22/24's permission model has no network switch, so the preloaded guard (`src/plugins/sdk/guard.ts`) denies every builtin outside the allowlist (`net`, `http(s)`, `http2`, `tls`, `dgram`, `dns`, `fs`, `module`, `vm`, `os`, `child_process`, `worker_threads`, `inspector`, ...), denies non-`file:` module URLs, deletes `fetch`/`WebSocket`/`EventSource`, and pins `process.getBuiltinModule` and `process.kill` to throwing stubs (non-writable, non-configurable). `process.binding` is denied by the permission model. A plugin cannot install its own earlier resolve hook because `node:module` itself is denied | `net`, `netBare`, `http`, `fetch`, `websocket`, `builtin`, `dns`, `binding` probes, each also asserting a real local TCP listener received **zero** connections; a bite check shows the listener is reachable when unsandboxed |
| Empty environment | `env: {}` on spawn | `env` probe |
| Basename only | host strips directories; the wire parser refuses `/` and `\` in file names | `hostPath` probe; registry test with a capture path |
| Time | `timeout: caps.timeoutMs`, `killSignal: SIGKILL` | hang test (`PLUGIN_TIMEOUT` well under the test's limit) |
| Memory | `--max-old-space-size=caps.memoryMb` (heap) and a resident-memory watchdog in the child (`memoryMb` + 128 MiB runtime allowance), checked every 5 ms and before answering | heap-growth and 400 MiB `Buffer` tests |
| Input size | host refuses documents over `maxInputBytes` and request envelopes over the matching bound before spawning | input test |
| Output size | `maxBuffer: caps.maxOutputBytes` (overflow kills the child) | output test |
| Closed answers | one line, closed parser: unknown keys, wrong op, unknown status, non-code `code` are all `PLUGIN_MALFORMED_OUTPUT` | malformed-answer table; `protocol.test.ts` |
| Codes only | `code` must match `^[A-Z][A-Z0-9_]{0,63}$`, so no prose, path or value can ride on a verdict | `protocol.test.ts` free-text case |
| Registration is unforgeable | a `WeakSet` of issued registrations; a copy is `PLUGIN_NOT_REGISTERED` | forged-registration test |
| No self-edits | directory tree hash at registration, re-checked on every call (`PLUGIN_CHANGED`); symlinks refused | edited-plugin test, symlink test |
| No over-claiming | R5 self-test per claimed class, plus host-derived read corruptions, plus "the sandbox must answer every self-test document" | over-claim tests (no corruption run; easy self-supplied corruption; crash-as-catch) |
| Grader independence | import-graph walk both ways between `src/plugins/`, `examples/plugins/` and `src/benchmark/grade/` | `test/benchmark/independence.test.ts` |
| Gate unchanged | no plugin module reaches `src/gate/`, `src/verify/` or `src/benchmark/` | `test/plugins/sdk-boundary.test.ts` |

## Residual risks (stated, not hidden)

1. **Self-test gaming.** A plugin knows the correct documents it supplied and could
   special-case them. Host-derived corruptions narrow this, but cannot close it: the host does
   not know the app's semantics, so value classes (`wrong-value`, `wrong-target`, ...) come from
   the plugin. This is the main reason plugin verdicts are never R1 evidence, and why a measured
   app family needs an independent grader entry.
2. **Module-layer network block.** On Node 22/24 the network is closed by the guard, not by
   the permission model. The tests probe every route we know of; an unknown route through an
   allowed builtin would bypass it. Hardening: Node ≥ 25's permission model network switch, or
   an OS network namespace / seccomp for the child (TO FILE).
3. **Memory accounting.** The heap cap is exact; the resident-memory watchdog cannot interrupt a
   synchronous allocation, which the wall-clock kill bounds instead. A cgroup/rlimit cap is the
   stronger fix (TO FILE).
4. **Side channels.** Timing and CPU use are observable to the host only; a plugin cannot reach
   another trial, but two plugin calls on one host share CPU.
5. **Plugin code is readable by the plugin.** A plugin can read its own directory and the SDK.
   Neither holds secrets; keep it that way (the SDK is pure code).

## Operator rules

- Register plugins from a directory you control; registration records the tree hash and the
  self-test report, and both belong in any pack that cites a plugin result.
- Never pass secrets in an intent; the plugin receives the intent verbatim.
- Plugin results are `evidenceClass: "plugin-experiment"`. Do not relabel them.
