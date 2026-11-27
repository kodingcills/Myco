# Policies and guardrails (capability track O)

Host-side enforcement of declared policies on every agent action before it reaches the app or
the guest (`docs/product/capability-spec-2.md`, section O). Code: `src/policy/` (engine and
guard), `src/violations/` (the independent violation checker). Tier 2.

## What it does

A policy decides `allow`, `deny` or `require-approval` for each proposed action. The decision
is made on the host, in the actuator path, before the action is forwarded:

```
agent action -> policed wrapper -> reduce to facts (host) -> guard -> engine -> decision
                                                                 |
                       allow: forward    deny: refuse with a code    require-approval: N handoff
```

The agent cannot read, edit, relax or switch off a policy. It sees `POLICY_DENIED` or
`POLICY_APPROVAL_REQUIRED` and an opaque policy id (`pol-<12 hex>`), never the policy text,
the rule kind or the host reason code. Policies are not a verifier: a run where every action
was allowed says nothing about whether the task is done. Nothing here changes the gate
(`myco.gate/v1` still takes `taskId`, `runId` and `claim` only).

## The host config

One JSON file on the host, `myco.policy-config/1`, closed at every level:

```json
{
  "schema": "myco.policy-config/1",
  "policies": [
    { "id": "keep-original", "kind": "no-overwrite-original", "effect": "deny" },
    { "id": "doc-dir-only", "kind": "write-scope", "effect": "deny" },
    { "id": "no-creds", "kind": "no-credential-input", "effect": "deny" },
    { "id": "apps", "kind": "app-allowlist", "effect": "deny", "apps": ["soffice"] },
    { "id": "at-most-2", "kind": "destructive-limit", "effect": "deny", "max": 2 },
    { "id": "injected", "kind": "flagged-screen", "effect": "require-approval" }
  ]
}
```

| Kind | Matches when the action |
|---|---|
| `no-overwrite-original` | writes or deletes the trial's original document |
| `write-scope` | writes or deletes anything outside the trial's document directory |
| `no-credential-input` | types into a field the host classifies as a credential field |
| `app-allowlist` | launches an app not on the list |
| `destructive-limit` | would take the trial's destructive operations (deletes, overwrites) past `max` |
| `flagged-screen` | is proposed while the host screen sensor flags an injected instruction |

Every rule is evaluated; `deny` beats `require-approval` beats `allow`, and among equals the
first rule in the file names the decision.

`startPolicy` (`src/policy/guard.ts`) reads the file once and pins its SHA-256 over the exact
bytes. Editing the file during a trial changes nothing.

## Fail closed

| Situation | Result |
|---|---|
| Config missing or unreadable | the trial refuses to start (`POLICY_CONFIG_MISSING`); it never runs unpoliced |
| Config path relative, or resolving inside the document directory or any agent root | refused (`POLICY_CONFIG_NOT_HOST`) |
| Trial scope does not resolve | refused (`POLICY_SCOPE_INVALID`) |
| `flagged-screen` declared with no host screen sensor | refused (`POLICY_SENSOR_MISSING`) |
| Config does not parse to the closed schema | every action denied (`POLICY_CONFIG_INVALID`) |
| Facts reducer, classifier or sensor throws | denied (`POLICY_ENGINE_ERROR`) |
| Action the reducer cannot reduce (Save As, an unknown action kind) | denied (`POLICY_ACTION_UNRECOGNISED`) |
| Async decision slower than the timeout (default 2 s) | denied (`POLICY_ENGINE_TIMEOUT`) |
| Synchronous actuator meets `require-approval` | refused (`POLICY_APPROVAL_REQUIRED`), never allowed |

## Every actuator path

`src/policy/actuators.ts` wraps each actuator entry point. `test/policy/actuators.test.ts`
pins the entry points against their declarations, classifies every file in `src/` that
declares an `act`, `calcSet` or `writerAppend` method, and proves each wrapper calls the guard
before it forwards.

| Entry point | Wrapper | Path | `require-approval` |
|---|---|---|---|
| `AppAdapter.act` | `policedAppAdapter` | async | N handoff |
| `DesktopTransport.act` | `policedDesktopTransport` | async | N handoff |
| Linux `Actuator.act` | `policedLinuxActuator` | sync | refused |
| `CrossAppActuator.calcSet` / `writerAppend` | `policedCrossAppActuator` | sync | refused |
| J's `ActionPolicy.check` (every route) | `guardedActionPolicy` | sync | refused |

The async wrappers use track N's seam (`guardAction`, `PauseGate`, `HandoffPolicy`): no action
passes while any handoff is open, `require-approval` is a forced handoff the human approves,
fixes or rejects, and `deny` is a `PolicyDenial` (no handoff opens). With no broker,
`NO_APPROVALS` cancels every approval request, so nothing is forwarded.

Known limit: a click carries only a target ref, so a click on a Save or Delete button is not
recognised by the reducers. The violation checker still sees its effect in the file-system diff.

## The host record

Every decision is logged host-side as
`{ actionSeq, actuator, policyId, decision, code, configSha256 }`: closed values only
(`src/policy/codes.ts`). Nothing the agent sent (text, paths, identities) is written there or
returned to it. `PolicyGuard.row(arm, trialKey)` gives the per-trial row with the config hash
and decision counts; `checkPolicyPack` refuses a pack whose rows mix config hashes within an
arm, carry no hash in a policed arm, or carry one in an unpoliced arm.

Q's proof bundles admit O's codes as is: `POLICY_REASON_CODES` in `src/proof/closed.ts`
appends `POLICY_DECISION_CODES` and `POLICY_AGENT_CODES`. O's `require-approval` corresponds to
the bundle's `ask` decision.

## Independent violation checker

`src/violations/checker.ts` decides violations after the run from the action trace, the
persisted bytes and the guest file-system diff, against the task's own spec. It shares no code
with the engine (`test/violations/independence.test.ts` walks the import graph both ways), so
the engine never grades itself. Input it cannot read is `VIOLATION_INPUT_INVALID`, never zero
violations.

## Boundaries

`test/policy/boundary.test.ts`: the engine reaches no gate, vault, registry, grader, evidence,
episode or proof module, imports no process launcher, names no gate schema, and the gate never
imports it.

## Not built yet (needs a VM or another track)

- Wiring the wrappers into the live trial runners and the `B` / `B+O` arms (trial-run code).
- Recording the policy log and config hash in `myco.episode/1` and the A/B pack rows (schema
  changes, each its own reviewed change).
- The frozen `pol-v1` task set (60 adversarial tasks plus fc-v1's 90 benign ones) and the
  measured bar (zero violations in `B+O`; benign non-inferiority).
- A host screen sensor for injected instructions, and click-target classification (track I).
