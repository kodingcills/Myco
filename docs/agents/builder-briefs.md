# Builder briefs

How to brief a builder (an agent or person writing a PR), so leaks are caught by the builder
before review instead of by the verifier after it. Verifiers keep their own checks
([verifier-briefs.md](verifier-briefs.md)); this brief makes them the second line, not the
first (TIF-98: #533, #548 and the dataset writers of #542 and #531 reached review with
username or host-path leaks that only verifiers caught).

## The brief template

> Build PR `<title>` in kodingcills/Myco on branch `<branch>`, from the latest `origin/main`
> (`pnpm install --frozen-lockfile`). Linked issue: `<TIF-n>`. Tier: `<0|1|2>`.
>
> **Context.** What to build and why.
>
> **Outward output.** Anything this PR writes that leaves the machine (a dataset, an episode
> export, a bundle, a report) is serialized through `src/leak-guard/serialize.ts`: a
> `ClosedSchema` lists every field; free text and paths become digests; blobs are
> digest-only. Do not write such output with `writeFileSync` (the routing lint fails it).
>
> **Fixtures.** Use generated fake identities only (`zq...` accounts, `<placeholder>` paths,
> key shapes assembled at runtime). Never paste a real path, username, host name or key,
> not even into a test.
>
> **Preflight before EVERY push.** Run `pnpm leak-guard` (add `--scan <dir>` for any
> outputs or logs your change produced). It must print `leak-guard: PASS`. Then
> `pnpm typecheck`, `pnpm lint`, the targeted tests, and `npx biome check .` without a pipe.
>
> **State the result.** Every PR comment that announces a push says
> `leak-guard: PASS @ <sha8>` (or quotes the `file:line class` lines it printed and what you
> changed). Never add to `src/leak-guard/allowlist.json` to get it green: fix the leak.
>
> **On a guard block or tool refusal:** stop and report; never rework around it.

## Why each rule exists

### The guard runs before the push, not only in CI

CI runs the same checks (`test/leak-guard/`, in the core smoke set), but a leak that reaches
a pushed commit is already in the history, the PR page and every clone. The preflight keeps
it on the builder's machine. On a builder's own machine the guard also checks that machine's
real account and host names, which CI (account `runner`) cannot.

### The result goes in the PR comment

A stated result is checkable: the verifier can rerun `pnpm leak-guard` at the stated SHA and
compare. An unstated one invites "I'm sure I ran it".

### The guard never prints the value

A finding is `file:line class`. A report that echoed the matched text would itself be the
leak, in a log or a PR comment.
