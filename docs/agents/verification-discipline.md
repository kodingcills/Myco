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
