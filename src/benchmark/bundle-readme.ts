import { FAULT_CLASS_HARNESS_NOTE } from "./taskset.ts";

/** One table row per fault class, from the single source the harness notes live in. */
const FAULT_CLASS_TABLE = Object.entries(FAULT_CLASS_HARNESS_NOTE)
  .map(([cls, note]) => `| \`${cls}\` | ${note} |`)
  .join("\n");

/** README shipped inside the published bundle (`benchmark/false-completion/fc-v1/README.md`). */
export const BUNDLE_README = `# Myco false-completion benchmark, task set fc-v1

Licensed Apache-2.0, like the rest of this repository.

An agent is asked to edit one spreadsheet cell and save. Some tasks carry a fault
(the app is killed, the save is dropped, focus is stolen) or cannot be done at all
(the record or column does not exist). The benchmark measures how often an agent's
"done" is accepted when the saved document does not actually satisfy the task. The
judge is an independent grader that reads only the saved file's bytes, the pristine
fixture, and the task's intent. It never sees the agent's claim.

## Contents

| File | What it is |
|---|---|
| \`tasks.jsonl\` | 100 tasks, one JSON object per line (schema \`myco.benchmark.task/1\`). \`inDemo\` marks the 30-task demo subset |
| \`fixtures/<sha256>.csv\` | The pristine spreadsheet for each task, named by its SHA-256 |
| \`manifest.json\` | Counts, the grader version, and the SHA-256 of every file here |

Each task gives the instruction text the agent receives, the intent (\`rowKey\`,
\`column\`, \`newValue\`), each column's type, and the fixture. The task does not store an
expected end state; the grader derives it from the fixture and the intent.

## Fault classes

What each \`faultClass\` asks of the harness that runs the task:

| \`faultClass\` | What the harness does |
|---|---|
${FAULT_CLASS_TABLE}

## Checking your copy

\`manifest.json\` records the SHA-256 of every other file. From a checkout of the Myco
repo, \`npx tsx scripts/benchmark-verify-bundle.ts <this dir>\` re-hashes the files on disk
against it and reports any that are missing, differ, or are not listed. That script uses
Node built-ins only, so it can also be copied out and run on its own.

## Running your own agent against it

1. For each task, open its fixture in a spreadsheet app (LibreOffice Calc imports the
   CSV and saves \`.xlsx\`), give your agent the task's \`instruction\`, and apply the
   task's \`faultClass\` if you are measuring faults (see "Fault classes" above). The
   arm's agent must see only the task's \`instruction\` and the fixture. \`faultClass\`,
   \`satisfiable\`, \`intent\` and the rest of the task row are for your harness and the
   grader; an agent that can read them can key its answer off them, and its result is
   not comparable.
2. When the agent stops, copy the saved file, exactly as written, to
   \`docs/<trialKey>.xlsx\`. \`trialKey\` is any id you choose (\`[A-Za-z0-9._:-]\`).
3. Write one arm row per trial (schema \`myco.benchmark.arm-row/1\`, in the Myco repo's
   \`schemas/benchmark-ledger.ts\`): what the agent claimed, whether the "done" was
   accepted, and the SHA-256 of the saved file.
4. From a checkout of the Myco repo, build the grade requests, grade, and check:

   \`\`\`
   npx tsx scripts/benchmark-make-requests.ts --bundle <this dir> --arm arm.jsonl --docs docs --out work
   npx tsx scripts/benchmark-grade.ts work/requests.jsonl > grades.jsonl
   npx tsx scripts/benchmark-check.ts --arm arm.jsonl --grades grades.jsonl --expect hcu+shell=100
   \`\`\`

   The check prints, per arm, accepted DONEs, false DONEs accepted, and the false-accept
   rate with its denominator and a Wilson 95% interval.

## What is not here

No traces, run directories, host paths, credentials, or model output. The grader
needs none of them, and none are required to recompute a published number.
`;
