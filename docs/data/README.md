# Myco episode datasets: README

This is the README to publish with an exported Myco dataset: the episode export
(`myco.episode/1`, `src/episode/export.ts`), the track U container (`src/dataset/export.ts`) and
Q proof bundles (`src/proof/bundle.ts`). No exporter writes it: publishing it beside the data is
a manual step of the release. Its "Known limits" section reaches the people who use a dataset
only if the release includes this file. The formats are described in
[`episode-format.md`](episode-format.md), [`../product/linux-scale.md`](../product/linux-scale.md)
§6 and [`../architecture/replayable-proof.md`](../architecture/replayable-proof.md).

## What a dataset carries

Only closed values: fixed vocabulary, closed ids and versions, digests and counts. Agent text
(typed text, commands, UI status) is never written; it is a digest. Screenshots and documents are
never written; they are a digest and a size. Simulated rows are labelled and never mixed into real
datasets.

## Identity strings

Before writing, every id, token and closed field is checked for identity strings: the exporting
host's account name and host name (always), and each line of the identity file the exporter was
given (full names, other accounts). The check folds case and accents and ignores separators, so a
configured `First Last` is caught as `FirstLast`, `first.last`, `First-Last`, and by each word of
3 or more characters alone (`<first>_trial`, `<Last>2`, `xx<first>`). An id or token holding one
is written as a digest (`h-` and 60 hex digits); any other closed field holding one refuses the
export. The single-word rule (and the fold) is identical on all three surfaces. For whole
strings, Q proof bundles are stricter: they also match a configured string of 2 characters
(the episode export and track U start at 3) and the first dotted label of a configured string
(`first` of `first.last`), and they exempt no account name. The episode export and track U
exempt a short list of generic account names (`runner`, `root` and the like) from the host
account check.

## Known limits (accepted residual risk)

**Names nobody configured are not caught.** The check knows only the exporting host's identity
and the identity file. A name that is in neither, sitting in a closed id or version that its
grammar admits, is written as is. Two examples:
- another machine's host name, such as `<name>-MacBook-Pro.local`, used as a task or run id;
- a dotted, path-like id with an unconfigured name, such as `Users.<name>.Documents`, used as a
  task id or task-set version.

Free text is always digested, so this concerns only ids, tokens and closed pattern fields. The
exporter's remedy is to list every name that may appear (other accounts, other machines, full
names) in the identity file before exporting. Tests pin this behaviour on each surface (the "O4
residual" tests in `test/episode/`, `test/dataset/` and `test/proof/identity-words.test.ts`), so
this section stays true.

**Words of 1 or 2 characters are not looked for alone.** With `Al Smith` configured, `al` alone
is not matched (it would match nearly every id); `Smith`, `AlSmith` and `al.smith` are.

**Digests are unsalted.** Equal values stay equal, so a party who guesses an exact raw value can
confirm the guess by hashing it.
