# Plugin sandbox: security model (capability track T)

Scope: third-party `myco.plugin/1` plugins (`docs/plugins/byoa.md`). This page says what a
plugin is trusted with, what it is not, how each limit is enforced, how each is tested, and
what is left open.

## Threat model

A plugin is **untrusted code** from outside the repo. Assume it is written to:

1. read things it should not (host files, other trials' captures, secrets, the environment);
2. reach the network (exfiltrate, or fetch a verdict);
3. exhaust or disrupt the host (hang, allocate, flood output or the host disk, signal host processes);
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
child processes, workers, native addons or WASI, no signals to any other process (no host
PID is even visible on Linux), no stdio streams (`process.stdin/stdout/stderr`
throw; `console` is discarded), an empty environment, no host path of the trial, and no other
trial's data.

## Enforcement

| Limit | Mechanism | Test (each mutation-proven) |
|---|---|---|
| Out of process | one `node` child per request (`spawnSync`), no state carried between calls | all of `test/plugins/sandbox.test.ts` |
| No reads outside plugin + SDK | Node permission model: `--permission --allow-fs-read=<sdk> --allow-fs-read=<plugin>`; no `--allow-fs-write`, `--allow-child-process`, `--allow-worker`, `--allow-addons`, `--allow-wasi` | `fsImport`, `bindingFs`, `write` probes |
| No network, layer 1: OS (prerequisite) | Every child runs under an OS network layer (`networkIsolation()` in `src/plugins/host/sandbox.ts`): Linux, a fresh empty network namespace (`unshare --user --map-root-user --net --pid --fork --kill-child`; no interface is up, so no IP route exists, loopback included); macOS, `sandbox-exec` with `(deny network*)` (IP and Unix-domain sockets). With neither (e.g. Windows, or a Linux host that forbids user namespaces) the call is `PLUGIN_NO_NET_ISOLATION` and no plugin code runs. CI lifts Ubuntu 24.04's AppArmor block on user namespaces for this | `test/plugins/sandbox-os.test.ts`: a plain `node` child (no permission model, no guard, ordinary pipes) under the OS layer alone gets **zero** TCP connections to a host listener, and on macOS zero Unix-socket connections; the same child connects without it; no OS layer gives `PLUGIN_NO_NET_ISOLATION`. `sandbox.test.ts` `noInterfaces` (Linux): the plugin's own process sees no interface |
| No network, layer 2: no socket in the child | A Node pipe is a `net.Socket`, and its class connects (TCP and Unix socket) with no import, so the child gets none: stdin and stdout are regular files in a private host temp dir, stderr is `/dev/null`, and `child.ts` replaces `process.stdin/stdout/stderr` with throwing, non-configurable getters and `console` with a frozen no-op before plugin code loads | `sandbox.test.ts` D1 probes `stdoutClass`, `stdinClass`, `stderrClass`, `handleClass` (every `process._getActiveHandles()` object and its `_handle`), `consoleStream` and `exfil` (the verifier's plugin, sending the captured bytes): each tries TCP and a Unix socket and asserts **zero** connections on both listeners and no bytes received; a bite check shows both listeners are reachable unsandboxed |
| No network, layer 3: module guard | the preloaded guard (`src/plugins/sdk/guard.ts`) denies every builtin outside the allowlist (`net`, `http(s)`, `http2`, `tls`, `dgram`, `dns`, `fs`, `module`, `vm`, `os`, `child_process`, `worker_threads`, `inspector`, ...), denies non-`file:` module URLs, deletes `fetch`/`WebSocket`/`EventSource`, and pins every `process` function in its `PINNED_PROCESS_FUNCTIONS` list (signals, bindings, `execve`, credentials; see "process surface" below) to throwing stubs (non-writable, non-configurable). A plugin cannot install its own earlier resolve hook because `node:module` itself is denied | `net`, `netBare`, `http`, `fetch`, `websocket`, `builtin`, `dns`, `binding` probes, each also asserting a real local TCP listener received **zero** connections |
| No signals to host processes (round 2, D2) | OS layer: on Linux the child runs in a fresh **PID namespace** (`--pid --fork`), so no host PID exists for it to name; `/bin/sh` is the namespace init (node runs as PID 2, so V8's out-of-memory abort still reports as SIGABRT, exit 134) and `--kill-child` tears the whole namespace down when the host SIGKILLs on timeout. Detection requires the namespace to be real (the probe child must see its parent as PID 1), or the host has no OS layer and fails closed. macOS: the Seatbelt profile adds `(deny signal)(allow signal (target self))` (round 3 first tried `(deny signal (target others))`; macOS CI showed a victim in the child's process group, which includes the host, still killed under it). JS layer: the guard pins `kill`, `_kill`, `_debugProcess`, `_debugEnd` and the profiler-idle notifiers | `sandbox-os.test.ts`: a plain child (no guard) under the OS layer alone calls `_debugProcess`, `_kill` and `kill` on a host victim run by the same user: the victim stays alive and opens no inspector; the same child kills it and opens its inspector without the layer (bite check); Linux: the child sees itself as PID 2 under init PID 1. `sandbox.test.ts`: `sigKillRaw`, `sigKillPublic`, `sigDebug`, `sigDebugEnd`, `sigDebugParent` through `runInSandbox` (victim alive, no "Debugger listening", and the test process's own inspector stays closed); `pinned` checks every pinned function is a non-writable, non-configurable stub that throws `PLUGIN_CAP_DENIED`; a timed-out plugin leaves no process behind (Linux) |
| Empty environment | `env: {}` on spawn; the Linux namespace init unsets the `PWD` it would export; on macOS the child also removes `__CF_USER_TEXT_ENCODING`, which CoreFoundation sets inside the process at startup | `env` probe (reports variable names, never values, on failure) |
| Basename only | host strips directories; the wire parser refuses `/` and `\` in file names | `hostPath` probe; registry test with a capture path |
| Time | `timeout: caps.timeoutMs`, `killSignal: SIGKILL` | hang test (`PLUGIN_TIMEOUT` well under the test's limit) |
| Memory | `--max-old-space-size=caps.memoryMb` (heap) and a resident-memory watchdog in the child (`memoryMb` + 128 MiB runtime allowance), checked every 5 ms and before answering | heap-growth and 400 MiB `Buffer` tests; asynchronous ~600 MiB `Buffer` growth stopped by the watchdog interval |
| Input size | host refuses documents over `maxInputBytes` and request envelopes over the matching bound before spawning | input test |
| Output size, enforced while the child runs (#537 round 3, D3) | the kernel, not a check after exit: every child runs under `RLIMIT_FSIZE` set by `/bin/sh` (`LIMIT_WRAPPER` in `src/plugins/host/sandbox.ts`: `ulimit -c 0 && ulimit -f <blocks>`, then `exec env -i` into the OS layer). The limit is the smallest whole number of shell blocks above `caps.maxOutputBytes`, so an exact-cap answer fits. The block size is measured, not assumed (`measureFsizeUnit`: 512 bytes for dash, 1024 for macOS's bash 3.2; anything else fails closed) and any write past it fails (`EFBIG`; Node ignores SIGXFSZ). The child can write only the answer file: no `--allow-fs-write`, `fs` denied, stderr `/dev/null`. So plugin output on the host disk is at most `maxOutputBytes` + 1024 bytes per call, whatever route reaches the file (round 3 reached it with a `node:stream` prototype hook and wrote 14.5 GB in one call). The child stops on its own write error or at the wall-clock kill. The host reports `PLUGIN_OUTPUT_TOO_LARGE` whenever the file is over the cap, before it looks at the exit status, so overflowing and then hanging or crashing is still reported as an overflow. Core dumps are off, so a crash writes nothing to the plugin directory. Detection runs every OS layer under the wrapper and requires node to see exactly the expected file-size limit and a zero core limit, or there is no OS layer and the call fails closed | `sandbox.test.ts` "D3": a watcher process samples the io directory during the call. A 64 MiB prototype-hook write, an endless 16 MiB write loop, an overflow then a hang, and an honest 2 MiB answer all stay at or under the cap + 1024 on disk and give `PLUGIN_OUTPUT_TOO_LARGE`; the endless loop ends at the time cap at the latest; an exact-cap answer is read (control). `sandbox-os.test.ts` "D3": the block size measures as 512 or 1024; detection refuses a layer under which node sees another limit; the wrapper turns core dumps off even when the host had them on (bite-checked); when the host's hard file-size limit is below the request (a launcher lowers it; as root, inside a user namespace, which cannot raise it), the wrapper exits 90 and `runInSandbox` returns `PLUGIN_SPAWN_FAILED`, while a call within that limit still answers (control). The earlier output test and its control still hold |
| Closed answers | closed parser: unknown keys, wrong op, unknown status, non-code `code` are all `PLUGIN_MALFORMED_OUTPUT`; the child also refuses a non-code `code` itself (exit 71, nothing written). `process.stdout` throws for plugin code, but a plugin can still reach the answer stream (D3's prototype hook), so it controls the answer bytes. That is no new power, since the plugin chooses its answer anyway, and the host re-parses every byte with the closed parser | malformed-answer table; V6 child test; `protocol.test.ts` |
| No `fs` (#537 round 3, Y5) | the guard denies `fs`, `node:fs` and `fs/promises` at import. This matters beyond the permission model: an fd write (`fs.writeSync(1, ...)`) needs no path permission | `fsLoads`, `fsBareLoads`, `fsPromisesLoads`, `fsFdWrite` probes |
| Codes only | `code` must match `^[A-Z][A-Z0-9_]{0,63}$`, so no prose, path or value can ride on a verdict | `protocol.test.ts` free-text case |
| Registration is unforgeable | a `WeakSet` of issued registrations; a copy is `PLUGIN_NOT_REGISTERED` | forged-registration test |
| No self-edits | directory tree hash at registration, re-checked on every call (`PLUGIN_CHANGED`); symlinks refused | edited-plugin test, symlink test |
| No over-claiming | R5 self-test per claimed class, plus host-derived read corruptions, plus "the sandbox must answer every self-test document" | over-claim tests (no corruption run; easy self-supplied corruption; crash-as-catch) |
| Grader independence | import-graph walk both ways between `src/plugins/`, `examples/plugins/` and `src/benchmark/grade/` | `test/benchmark/independence.test.ts` |
| Gate unchanged | no plugin module reaches `src/gate/`, `src/verify/` or `src/benchmark/` | `test/plugins/sdk-boundary.test.ts` |

## `process` surface (reviewed in round 3)

Every function on `process` in the plugin child (Node 22 and 24), and what stops its misuse:

| Function(s) | Disposition |
|---|---|
| `kill`, `_kill`, `_debugProcess`, `_debugEnd` | pinned (signals another process; `_debugProcess` sends SIGUSR1, which opens the target's V8 inspector). Also blocked by the OS layer |
| `_startProfilerIdleNotifier`, `_stopProfilerIdleNotifier` | pinned (no use to a plugin) |
| `binding`, `_linkedBinding`, `dlopen`, `getBuiltinModule` | pinned (native bindings, addons, denied builtins); the permission model also denies the first three |
| `execve`, `loadEnvFile`, `openStdin` | pinned (process replacement, host file read, stdin); the permission model and the hidden stdio also deny them |
| `setuid`, `setgid`, `seteuid`, `setegid`, `setgroups`, `initgroups` | pinned (the user namespace maps a single uid, so they could not reach another host user anyway) |
| `exit`, `reallyExit`, `abort` | allowed: they end the plugin's own process, which the host records as a fault (`uncertain`). The child needs `exit` |
| `_getActiveHandles`, `_getActiveRequests`, `getActiveResourcesInfo` | allowed: the child holds no socket or pipe handle (D1 probes `handleClass`, `socketHandles`) |
| `_rawDebug` | allowed: writes to fd 2, which is `/dev/null` |
| `_fatalException`, `_tickCallback`, `nextTick`, `setUncaughtExceptionCaptureCallback`, `hasUncaughtExceptionCaptureCallback`, `emitWarning`, `assert` | allowed: in-process event-loop and error plumbing, no capability |
| `cwd`, `chdir`, `umask` | allowed: the permission model checks reads against fixed paths and grants no writes, so neither changes what a plugin can open |
| `uptime`, `hrtime`, `cpuUsage`, `threadCpuUsage`, `resourceUsage`, `memoryUsage`, `constrainedMemory`, `availableMemory`, `getuid`, `geteuid`, `getgid`, `getegid`, `getgroups`, `ref`, `unref`, `setSourceMapsEnabled` | allowed: read-only or self-only |
| `report` (getter) | `getReport()` allowed (host identity, residual risk 6); `writeReport` is denied by the permission model (no writes) |

A function added to `process` by a future Node is allowed until it is reviewed here; the
`pinned` probe pins the list above, not "everything else" (residual risk 7).

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

7. **New `process` functions.** The guard pins a reviewed list (above), not every function a
   future Node release adds. The OS layer still blocks signals and network whatever the
   function; re-review the list when the Node major changes.

## Operator rules

- Register plugins from a directory you control; registration records the tree hash and the
  self-test report, and both belong in any pack that cites a plugin result.
- Never pass secrets in an intent; the plugin receives the intent verbatim.
- Plugin results are `evidenceClass: "plugin-experiment"`. Do not relabel them.
