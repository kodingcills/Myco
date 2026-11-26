# Strict per-trial isolation (`strict-linux-ns`)

Track L2 (a TIF-265 follow-up), split out of #541 by the lead's ruling. Code:
`src/isolation/strict-linux-ns.ts`. Tests: `test/isolation/strict-linux-ns.test.ts`.
Mutation proof: `test/isolation/strict-ns-mutants.py`.

Several trials can run at once on one Linux host. This backend gives each trial a view of
the filesystem in which only that trial's own files exist. It exists because the strict
mode in #541 round 1 could be beaten (D1, below), and a beaten isolation mode can produce
a false VERIFIED across trials, which is the one thing the gate must never do.

## 1. What a trial sees

Every agent command runs inside this tree, and nothing else of the host is in it:

| Path | What it is |
| --- | --- |
| `/workspace` | the trial's own `<root>/workspace`, read-write |
| `/evidence` | the trial's own `<root>/evidence`, **read-only** (only the harness writes evidence) |
| `/tmp`, `/home`, `/dev/shm` | private tmpfs for this trial, gone when the trial ends |
| `/usr`, `/bin`, `/sbin`, `/lib*`, `/etc/alternatives` | the host's, bound read-only |
| `/etc` | a small generated `/etc` (passwd, group, hosts, nsswitch, ld.so.cache), never the host's |
| `/dev` | `null`, `zero`, `full`, `random`, `urandom` only |
| `/proc` | the proc of the command's own pid namespace |
| `/` | a read-only tmpfs |

The agent runs as uid 1000 in its own user namespace. It has no capabilities and
`no_new_privs` is set. Its environment holds only `PATH`, `HOME`, `TMPDIR`, `USER`, `LANG`
and the keys the harness passes in. Its network namespace has no device except a loopback
that is down.

## 2. How it is built

1. **Setup (once per trial).** `unshare --user --map-root-user --mount --pid --net --ipc --fork`
   runs a setup script as root of the trial's own user namespace (call it U1). The script
   mounts a tmpfs at `<root>/.nsroot`, binds the entries in §1 into it, makes them
   read-only, and `pivot_root`s into it. Then it **detaches the old root** with
   `umount -l /.old`. From then on the host's filesystem, the run root included, is not in
   the trial's mount namespace at all. The script then becomes the holder: pid 1 of the
   trial's pid namespace. It waits on its stdin, a pipe from the harness, and reaps every
   orphan handed to it.
2. **Each exec.** The harness runs `nsenter` into U1 and the trial's mount, net, ipc and
   pid namespaces. A wrapper checks the trial's nonce in `/.myco-trial`. It tells the harness
   on fd 3 that it reached the right trial, then closes fd 3. Then it runs
   `setpriv --no-new-privs` and `unshare --user --mount --pid --fork --kill-child
   --mount-proc --map-user=1000 --map-group=1000`, then `prlimit --as --cpu`, then
   `env -i`. So the agent's command runs in a **nested** user namespace (U2) that U1 owns,
   with a mount namespace copied across that boundary.
3. **Self-check before hand-off.** After setup the backend runs a check script **as the
   agent**. It checks:
   - uid 1000
   - every capability set is empty
   - `NoNewPrivs: 1`
   - the right trial nonce
   - `/` is not writable
   - the agent is in a fresh pid namespace
   - only the mounts in §1 exist, the ones that must be read-only are, and the writable
     ones (`/workspace`, `/tmp`, `/home`, `/dev/shm`) are `nosuid,nodev`
   - only a loopback network device
   - an ipc namespace that is not the harness's (the harness also checks the holder's)
   - no `hide` path, and not the host path of the trial root, exists inside. Each `hide`
     entry is probed both as written and at its real path (every symlink in it resolved)

   If any check fails, the trial is destroyed and `create` throws
   `STRICT_NS_SELFCHECK_FAILED`. The isolation report is built only from a passing
   self-check, never from what the setup meant to do.

## 3. Why the D1 attack is closed

D1 (from the #541 round-1 review): #541's strict mode put tmpfs mounts over the run root to
hide it, and made those mounts inside the same user namespace that agent commands then
entered with full capabilities. The agent ran `umount -l <runRoot>`. That removed the tmpfs
and showed the real run root, and the agent wrote `FORGED` into another trial's
`workspace/record.csv`. The pool then counted that trial VERIFIED, although the trial never
saved anything.

Here the same attack fails, and each layer below closes it on its own:

1. **Nothing is hidden, so nothing can be revealed.** The run root is not covered by a
   mount. After `pivot_root` and the detach, it is not in the trial's mount tree. Unmounting
   any mount leaves an empty mount point. The test "D1 even with full capabilities" enters
   the trial as root of U1, with more power than any agent gets. It unmounts `/workspace`,
   `/usr`, `/tmp` and everything else, and still cannot find or write the run root.
2. **Locked mounts.** The agent runs in U2, a user namespace nested in U1, and its mount
   namespace was copied across that boundary. The kernel marks every inherited mount
   `MNT_LOCKED`, and read-only mounts `MNT_LOCK_READONLY`. Those mounts cannot be unmounted,
   remounted read-write, or split from what they cover, even by root of a further nested
   namespace the agent makes itself (`unshare -Urm`). The agent holds no capability in U1,
   which owns the trial's real mounts.
3. **No privilege.** The agent is uid 1000 with no capabilities and `no_new_privs`, so it
   cannot mount, bind, pivot, or gain privilege through a setuid binary.

Other routes, and why each is closed:

| Route | Result |
| --- | --- |
| `umount`, `umount -l` of any mount, in place or in a nested `unshare -Urm` | refused (EPERM, or EINVAL on a locked mount) |
| `mount -o remount,rw /`, `/usr`, `/evidence` | refused |
| `mount --bind`, `pivot_root` in a nested namespace | only reorders the agent's own copy of its own tree |
| Writing to the host path of another trial | the path does not exist; `/` is read-only |
| `/proc/<pid>/root`, `/proc/1/root` | every pid visible is in the agent's own nested pid namespace, so the path resolves to its own root |
| Symlinks planted in `/workspace` | resolve inside the trial. On the host, `readTrialFile(base, rel)` walks `rel` one component at a time from a directory fd on `base` (normally `paths.workspace`), opening each step with `O_NOFOLLOW` (`O_DIRECTORY` for the directories, `O_NONBLOCK` for the file). A symlink at **any** component is refused, so a sub-directory the agent swaps for a link to a sibling's workspace (`ln -s ../../B/workspace /workspace/out`) is not followed (#551 round-1 D1). `..`, absolute paths and a `base` reached through a symlink are refused too. Anything that is not a regular file is refused, so the #541 D2 FIFO hang cannot happen |
| ptrace of a sibling trial | not addressable: every agent shares one host uid, so the protection is that a sibling's pids are not reachable from the agent's pid namespace. A test runs `PTRACE_ATTACH` from trial A on B's holder (by its host pid) and gets `ESRCH` |
| Abstract unix sockets | per network namespace; the marker test checks that no trial reaches a sibling's socket |
| SysV shared memory, message queues, semaphores | per ipc namespace: each trial has its own. A test has the harness hold a private `0600` segment and has trial A create one; A cannot open the harness's (`ENOENT`) and B cannot open A's. Without `--ipc` both succeed, because every agent runs as the harness's host uid |
| Exec aimed at the wrong trial (pid reuse) | the nonce check refuses it before the command runs (`STRICT_NS_TRIAL_MISMATCH`) |

The tests (`test/isolation/strict-linux-ns.test.ts`) run the D1 attack battery from trial A
against trial B, as the agent and as root of U1. They assert that B's file, B's vault and
the whole run root outside A's workspace are byte-identical afterwards. A concurrent
planted-marker test runs four trials at once and checks that none of them sees or touches
another's markers in the workspace, `/tmp`, `/home`, `/dev/shm` or abstract sockets.

## 4. Fail closed

- `probe()` builds and destroys a real throwaway trial. A host where `unshare -U` succeeds
  but the full setup does not (AppArmor-restricted user namespaces, seccomp, missing
  tools) reports `available: false` with a code.
- `create()` does not rely on the probe. Every failure throws `StrictIsolationError` with a
  code and leaves no root behind:

| Code | Meaning |
| --- | --- |
| `STRICT_NS_UNSUPPORTED_PLATFORM` | not Linux |
| `STRICT_NS_TOOL_MISSING` | `unshare`, `nsenter`, `setpriv`, `pivot_root`, `prlimit`, `mount` or `umount` is missing |
| `STRICT_NS_SETUP_FAILED` | the namespaces or the view could not be built |
| `STRICT_NS_SELFCHECK_FAILED` | built, but a property in §2.3 does not hold |
| `STRICT_NS_BAD_ROOT` | the root is missing, a symlink, not empty, or under a system dir |
| `STRICT_NS_HIDE_OVERLAP` | a `hide` dir is inside the trial root or under a system bind. Compared by real path, not lexically: every symlink in the `hide` entry, the root and each system source is resolved first (a missing tail is placed under its deepest existing ancestor, and a dangling link is followed to where it would land) |
| `STRICT_NS_BAD_SPEC` | a bad run id, cap, env key or command, or a `hide` entry whose real path is not a plain path |
| `STRICT_NS_DISPLAY_UNSUPPORTED` | `display: "xvfb"` was asked for (see §5) |
| `STRICT_NS_TRIAL_MISMATCH` | an exec reached a different trial than the one it was aimed at |
| `STRICT_NS_DESTROYED` | an exec on a destroyed trial |
| `STRICT_NS_BAD_FILE` | host-side capture refused a path: a symlink at any component, `..`, an absolute `rel`, a `base` that is not a real directory, or a file that is not a regular file |

- **There is no weaker fallback.** The backend never hands out a trial with less isolation
  while reporting it strict. Tests feed it an `unshare` that drops `--net`, and one that
  drops `--pid`. Both are refused with a code. No desktop comes back.
- Agent-facing text is the code only. `detail` (host paths, tool stderr) is for the
  operator.

## 5. What strict mode does NOT guarantee

- **Shared kernel.** This is namespace isolation, not a VM. A kernel exploit beats it. The
  microVM backend (track U) is the answer for hostile agents; `strict-linux-ns` is for
  agents that are buggy or careless, or deliberately try the routes in §3, on a patched
  kernel.
- **Per-process caps, not per-trial.** `prlimit` sets `RLIMIT_AS` and `RLIMIT_CPU` per
  process. A trial that forks many processes can use more in total. There is no pids cap,
  so a fork bomb is possible, and nothing confines CPU or memory across the whole trial.
  That needs cgroups (lands with L).
- **Host file names leak, not contents.** `/proc/self/mountinfo` shows the host source path
  of each bind, for example `/tmp/…/trials/A/workspace`. The trial learns names. It gets no
  access through them from inside, and host-side capture never follows a link it plants
  with them (§3).
- **System dirs are shared read-only.** `/usr`, `/lib*`, `/bin` and `/sbin` are the host's.
  A trial can read them, and a host secret stored there would be readable. `/etc` is not
  bound for this reason. When the harness runs as real root, host-root-owned files under
  `/usr` map to the agent's uid, so they are owner-readable to the agent (they are already
  world-readable) and still not writable, because the mounts are read-only and locked.
- **No display yet.** `display: "xvfb"` is refused with a code rather than faked. An Xvfb
  per trial, inside the namespaces, lands with L.
- **The holder is reachable from inside U1, not from the agent.** Root of U1 can see and
  kill its own trial's holder. The agent cannot: it runs in U2 and a nested pid namespace.
  Even with full U1 power, nothing outside the trial is reachable (§3.1).
- **Harness-side capture is the harness's job.** `readTrialFile(paths.workspace, rel)` is
  provided and tested. The pool must use it, or something just as strict (no symlink
  followed at any component), for every file it reads from a trial (lands with L). It is
  Linux-only, like the backend.
- **If the harness dies, the trial's processes die with it** (pid 1 exits on stdin EOF).
  The trial's root dir stays on the host until the next cleanup.

## 6. Integration with #541 (lands with L)

The desktop follows the `DesktopBackend` shape that #541 proposes (`src/parallel/backend.ts`):
`probe()`, `create(spec)`, `exec`, `destroy` returning `processesGone` / `rootRemoved`, and
an isolation report whose fields match `IsolationReport`. #541 is not merged, so nothing is
imported from it. Once it merges, a thin adapter registers this backend as
`strict-linux-ns`, and pools with `STRICT_REQUIREMENTS` use it in place of the dropped
strict mode. Two differences the adapter must handle:

- `paths` has `evidence` and no host-side `tmp` or `home`. Those are private tmpfs mounts,
  invisible to the host by design.
- The report also carries `mountsLocked`, `agentUid`, `noNewPrivs` and `capabilities`.

The pool-level D1 regression (a victim trial that skips its save must not be
`countedVerified` while an attacker writes its file) lands with that adapter. This PR
proves the backend half: the attacker's write never reaches the host.
