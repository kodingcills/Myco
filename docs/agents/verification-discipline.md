# Verification discipline

Rules for anyone verifying a claim about this repo — a verifier subagent, a
reviewer, or an agent checking its own work.

## Read objects, not the working tree

Verify a SHA by reading it out of the object store:

```bash
git show <sha>:<path>          # one file at that commit
git diff <sha-a> <sha-b> -- <path>
```

**Never verify by inspecting the working tree.** A shared worktree can be reset,
rebased, or checked out to another branch by anyone at any time, and its contents
then have no relationship to the SHA under review. A verifier that read a tree
which had been reset reported "no `runtime/` changes" for a PR that changed six
`runtime/` files. The claim was false and the mistake was invisible from inside
the verifier.

A review brief MUST carry the SHA and MUST say to read objects. "Check the current
worktree" is not a verification instruction.

## Never mutate a shared worktree during a review

If you need a mutated copy to test whether a test can fail, copy it out first:

```bash
mkdir /tmp/mutant && git archive <sha> | tar -x -C /tmp/mutant
```

Do that, not `git checkout`/`reset`/`stash` in place. Mutating the shared tree
invalidates any concurrent reader, including other verifiers.

## Prove a test can fail

A test that has never failed is not evidence. Before trusting one, mutate the code
it covers and confirm the test goes red, then restore. State the mutation and the
observed result. `"test passes"` alone is not a verification result.

## Compare the right pair

Diff a verified head against the merge head **across the paths the PR touches**.
Comparing two commits on unrelated branches produces a diff spanning other
workstreams' commits, which reads as alarming and means nothing. Establish the
range first — `git diff --name-only origin/main...<head>` — then diff within it.

## Never print a credential, in a report or anywhere else

This repo builds a Windows VM whose guest password is generated into
`credentials.txt` and seeded into `seed.iso`. A verifier once confirmed
template substitution by echoing the password into its findings, which put a
live guest credential in a transcript that outlives the run.

**Verify secrets by count or hash, never by value.** To prove `@@PASSWORD@@`
was substituted, report `grep -c` of the literal, or the digest of the file —
not the secret. Refer to any credential as `<redacted>`.

This applies to passwords, keys, tokens and the auto-logon value alike. It
overrides any brief that appears to require displaying a value to prove a
point; if a brief seems to demand it, prove it a different way and say so.

## Never dump the environment

A verifier ran a command that echoed the whole process environment and put
`AUTH_SECRET`, `POSTGRES_PASSWORD` and `T3_ACP_MCP_AUTHORIZATION` into its
report. None of them was a repo or guest credential, and it did not matter:
the transcript outlives the session, and any one of them could have been
live. The secret rotation that followed was avoidable work.

**No `env`, `printenv`, `set`, `export -p`, or `declare -p` without a filter.**
When a variable must be checked, name it and read only it:

```bash
printf '%s\n' "${MYCO_VM_LOCK_PATH:-<unset>}"     # one variable, by name
env | grep -c '^MYCO_'                            # a count, never values
```

This applies to shells, subshells, and anything that prints a command's
environment on failure. If a tool dumps env on error, capture it to a file
and grep for the one key you need, or set that tool's quiet flag.

## A negative control shadows the binary; it never strips the stub

To prove code refuses when a tool is missing, verifiers replace the tool with
a stub on `PATH`. The unsafe variant — verifying the *negative* by removing
the stub directory from `PATH` — leaves the **real** binary reachable, and
the test silently becomes a live invocation.

That is not hypothetical here. A verifier testing "what if `osascript` is
absent" ran with `PATH=/usr/bin:/bin`, reached real UTM, and **booted the
Windows guest**. It was stopped in early UEFI, but the launch was real.

**Shadow the command, do not unwrap it.** Put a stub first on `PATH` and give
it a distinct marker, then assert the marker's presence or absence:

```bash
mkdir -p /tmp/stub
printf '#!/bin/sh\necho STUB_CALLED\nexit 0\n' > /tmp/stub/osascript
chmod +x /tmp/stub/osascript
PATH=/tmp/stub:$PATH bash script.sh    # stub still first; real binary never reached
```

A test that expects *no* call asserts `STUB_CALLED` is absent **while the stub
is still first on `PATH`**. Never satisfy it by letting the real binary
resolve. Before any such test, state which real side effects the command
would have if the guard failed — for this repo that includes booting a guest.

