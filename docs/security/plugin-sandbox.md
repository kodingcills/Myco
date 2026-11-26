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
child processes, workers, native addons or WASI, no stdio streams (`process.stdin/stdout/stderr`
throw; `console` is discarded), an empty environment, no host path of the trial, and no other
trial's data.

## Enforcement

| Limit | Mechanism | Test (each mutation-proven) |
|---|---|---|
| Out of process | one `node` child per request (`spawnSync`), no state carried between calls | all of `test/plugins/sandbox.test.ts` |
| No reads outside plugin + SDK | Node permission model: `--permission --allow-fs-read=<sdk> --allow-fs-read=<plugin>`; no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` | `fsImport`, `bindingFs`, `write` probes |
| No network, layer 1: OS (prerequisite) | Every child runs under an OS network layer (`networkIsolation()` in `src/plugins/host/sandbox.ts`): Linux, a fresh empty network namespace (`unshare --user --map-root-user --net`; no interface is up, so no IP route exists, loopback included); macOS, `sandbox-exec` with `(deny network*)` (IP and Unix-domain sockets), then `env -i` so the plugin still starts with an empty environment. With neither (e.g. Windows, or a Linux host that forbids user namespaces) the call is `PLUGIN_NO_NET_ISOLATION` and no plugin code runs. CI lifts Ubuntu 24.04's AppArmor block on user namespaces for this | `test/plugins/sandbox-os.test.ts`: a plain `node` child (no permission model, no guard, ordinary pipes) under the OS layer alone gets **zero** TCP connections to a host listener, and on macOS zero Unix-socket connections; the same child connects without it; no OS layer gives `PLUGIN_NO_NET_ISOLATION`. `sandbox.test.ts` `noInterfaces` (Linux): the plugin's own process sees no interface |
| No network, layer 2: no socket in the child | A Node pipe is a `net.Socket`, and its class connects (TCP and Unix socket) with no import, so the child gets none: stdin and stdout are regular files in a private host temp dir, stderr is `/dev/null`, and `child.ts` replaces `process.stdin/stdout/stderr` with throwing, non-configurable getters and `console` with a frozen no-op before plugin code loads | `sandbox.test.ts` D1 probes `stdoutClass`, `stdinClass`, `stderrClass`, `handleClass` (every `process._getActiveHandles()` object and its `_handle`), `consoleStream` and `exfil` (the verifier's plugin, sending the captured bytes): each tries TCP and a Unix socket and asserts **zero** connections on both listeners and no bytes received; a bite check shows both listeners are reachable unsandboxed |
| No network, layer 3: module guard | the preloaded guard (`src/plugins/sdk/guard.ts`) denies every builtin outside the allowlist (`net`, `http(s)`, `http2`, `tls`, `dgram`, `dns`, `fs`, `module`, `vm`, `os`, `child_process`, `worker_threads`, `inspector`, ...), denies non-`file:` module URLs, deletes `fetch`/`WebSocket`/`EventSource`, and pins `process.getBuiltinModule` and `process.kill` to throwing stubs (non-writable, non-configurable). `process.binding` is denied by the permission model. A plugin cannot install its own earlier resolve hook because `node:module` itself is denied | `net`, `netBare`, `http`, `fetch`, `websocket`, `builtin`, `dns`, `binding` probes, each also asserting a real local TCP listener received **zero** connections |
| Empty environment | `env: {}` on spawn | `env` probe |
| Basename only | host strips directories; the wire parser refuses `/` and `\` in file names | `hostPath` probe; registry test with a capture path |
| Time | `timeout: caps.timeoutMs`, `killSignal: SIGKILL` | hang test (`PLUGIN_TIMEOUT` well under the test's limit) |
| Memory | `--max-old-space-size=caps.memoryMb` (heap) and a resident-memory watchdog in the child (`memoryMb` + 128 MiB runtime allowance), checked every 5 ms and before answering | heap-growth and 400 MiB `Buffer` tests; asynchronous ~600 MiB `Buffer` growth stopped by the watchdog interval |
| Input size | host refuses documents over `maxInputBytes` and request envelopes over the matching bound before spawning | input test |
| Output size | the answer file is refused over `caps.maxOutputBytes` after the child exits. Plugin code has no stdout, so the file holds only the child's answer | output test and its control |
| Closed answers | closed parser: unknown keys, wrong op, unknown status, non-code `code` are all `PLUGIN_MALFORMED_OUTPUT`; the child also refuses a non-code `code` itself (exit 71, nothing written); a plugin cannot write its own answer line (`process.stdout` throws) | malformed-answer table; V6 child test; `protocol.test.ts` |
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
2. **Path-based Unix sockets on Linux.** A network namespace leaves the child no IP route
   (`sandbox-os.test.ts` checks TCP to loopback) but does not cover a Unix socket reached by a
   filesystem path, and the Node permission
   model does not check `connect()` paths (`sandbox-os.test.ts` asserts this residual). On
   Linux that route is closed by layers 2 and 3 only: the child holds no socket object and no
   module or global that makes one. Round 1 found such a route (`process.stdout.constructor`,
   D1), so the JavaScript layers are not treated as a boundary on their own; an unknown way to
   reach a socket class would reopen this route on Linux (not on macOS, where Seatbelt denies
   it). Hardening: hide the host filesystem from the child (bubblewrap, or Landlock's
   socket-scoping) (TO FILE). Windows hosts cannot run plugins at all (no OS layer).
3. **Memory accounting.** The heap cap is exact; the resident-memory watchdog cannot interrupt a
   synchronous allocation, which the wall-clock kill bounds instead. A cgroup/rlimit cap is the
   stronger fix (TO FILE).
4. **Side channels.** Timing and CPU use are observable to the host only; a plugin cannot reach
   another trial, but two plugin calls on one host share CPU.
5. **Plugin code is readable by the plugin.** A plugin can read its own directory and the SDK.
   Neither holds secrets; keep it that way (the SDK is pure code).
6. **Host identity is readable.** A plugin can read host paths and the host name
   (`process.cwd()`, `process.argv`, `process.report.getReport().header`) and a reader could
   place them in its state. Nothing a plugin returns reaches an agent today; the agent-facing
   `plugin_state` tool (TO FILE) needs the host-path scan the measurement guardrail names.

## Operator rules

- Register plugins from a directory you control; registration records the tree hash and the
  self-test report, and both belong in any pack that cites a plugin result.
- Never pass secrets in an intent; the plugin receives the intent verbatim.
- Plugin results are `evidenceClass: "plugin-experiment"`. Do not relabel them.
