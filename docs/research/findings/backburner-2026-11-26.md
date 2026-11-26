# Back-burner research R-A to R-F (lead request, 2026-11-26)

> **Status: research input, L0/L1, not a decision.** Requested by Tiffany at 6:22 PM ET on 2026-11-26. Claude only, $0, no accounts, no outreach, nothing published outside the repo. Sources were accessed 2026-11-26. R-A, R-C, R-D and R-E come from one Claude Fable 5.2 research worker; it re-fetched the load-bearing claims it names below, and everything else is a single pass through a summarising fetch tool, so quoted strings are "as returned by the tool" until a verifier re-reads them. R-B and R-F are from repo documents. Items marked UNVERIFIED could not be confirmed.

## Ranking by how much each changes a decision

| Rank | Item | Decision it changes | Weight |
|---|---|---|---|
| 1 | R-C Distribution | Packaging has to come before any listing | High |
| 2 | R-A Competitive delta | Comparison section and pitch must name new claimants | Medium |
| 3 | R-D Hosted pricing | The billing unit "per verified check" has an incentive problem | Medium (timing low) |
| 4 | R-E Proof clips | Export defaults for the replay/share feature (#567) | Medium |
| 5 | R-B Credibility benchmarks | Confirms the existing plan; adds one independence rule | Low to medium |
| 6 | R-F Back-burner engineering | Scoping only; nothing changes before the demo | Low |

## R-C. Distribution channels for an MCP gate (High)

- **Claude Code needs no approval.** A plugin is `.claude-plugin/plugin.json` plus `.mcp.json`; a marketplace is `.claude-plugin/marketplace.json` in a git repo, with no submission form. Users run `/plugin marketplace add owner/repo`.
- **Anthropic's directory** takes a local server only inside a plugin bundle; "MCP connector" listings are remote-only. Submission needs a paid Claude plan and a public repo, a person reviews it, and review time is not fixed. Its checklist holds for review any server launched through `npx`, a shell or a package-manager script. Whether the official `claude-plugins-official` marketplace takes submissions is unclear: the docs and the repo README conflict.
- **The official MCP Registry** (preview, no pre-review) stores metadata only and needs a public install method: npm with a matching `mcpName`, an MCPB on a GitHub release, or OCI. Namespace `io.github.<user>/*` is proven by GitHub login; stdio is supported. PulseMCP has paused submissions and says it will pick up from the registry.
- **OpenAI's public plugin directory is closed to stdio** ("Public submission still requires a remote HTTPS MCP endpoint"). Cursor (`.cursor/mcp.json`, install deeplink) and Codex (`codex mcp add`) need no listing.
- **Docker MCP catalog** requires a Dockerfile, Docker team review, and goes live 24 hours after approval.

**Two Myco blockers** (inference from `docs/gate/clients.md`): the launch command is a clone-relative `tsx`, which no channel can install; and the server will not start without `--task` and `--run`, while a marketplace install starts it with fixed arguments.

**Ranked path:** (1) Myco's own Claude Code marketplace in the repo, with a launcher that runs from `${CLAUDE_PLUGIN_ROOT}`; (2) an npm package, then the official MCP Registry (`server.json`, `mcpName`); (3) README install snippets for Cursor, Codex and VS Code; (4) the Anthropic directory as a plugin bundle (README of at least 40 words, licence, `node ${CLAUDE_PLUGIN_ROOT}/<file>` launch, files under 256 KiB); (5) Glama, then awesome-mcp-servers; (6) Cline marketplace; (7) mcpservers.org and mcp.so; (8) Docker catalog; (9) Cursor Marketplace; (10) Smithery, UNVERIFIED.

**Decision it changes:** an installable launcher and a way to bind task and run without fixed arguments gate every channel. Proposed issue below.

Sources: code.claude.com/docs/en/plugins-reference, /plugins/publish.md, /plugin-marketplaces; claude.com/docs/directory/publish, /plugins/pre-submission-checklist; github.com/anthropics/claude-plugins-official; modelcontextprotocol.io/registry/about (re-checked); raw.githubusercontent.com/docker/mcp-registry/main/CONTRIBUTING.md (re-checked); pulsemcp.com/submit (re-checked); developers.openai.com/codex/plugins/build.md (re-checked); cursor.com/docs/context/mcp; glama.ai; github.com/cline/mcp-marketplace. UNVERIFIED: cursor.directory (HTTP 429), Smithery (404), mcp.so (403).

## R-A. Competitive delta beyond the existing teardowns (Medium)

Builds on `findings/m2-01-competitive-teardown.md` and `mvp-competitive-teardown.md`, which already cover Cua, Orgo, HCU, UFO2, Simular, the lab stacks and UiPath.

- **Nine eval and observability vendors** (Braintrust, LangSmith, Langfuse, Arize/Phoenix, AgentOps, Laminar, Galileo, Scale; Patronus has retired its eval platform) grade traces or outputs with LLM judges, code scorers or humans. None documents reading the persisted state of the system the agent acted on, except through a custom scorer the user writes. None blocks an agent's "done" at run time; Arize says "Arize AX doesn't block requests — your app does", and Langfuse calls its checks "ex-post". Galileo, now Splunk Agent Observability, can block, but on model and tool inputs and outputs.
- **Closest claimant: Browserbase Universal Verifier** (with Microsoft Research, 2026-04-21), which says it "drops false positive rates in task success verification to essentially 0%". It is an AI verifier for browser agents, described for grading and training signals, not for stopping a run (re-checked).
- **Small coding-agent projects** gate "done" through hooks: TrueCall (deterministic post-condition checks; blocking UNVERIFIED), doneguard, groundtruth; verify-action-mcp returns four verdicts but the caller supplies the evidence. No funded product was found that gates desktop GUI agents on persisted state.

**How Myco's gate differs:** the witness is the saved artifact, not the trace; it runs before "done", not after; the agent cannot supply the evidence; "could not look" is its own verdict.

**Where Myco is weaker:** distribution (Langfuse lists "100+ integrations"; Braintrust and LangSmith host MCP servers; Myco is a git clone); breadth (a judge covers any app, Myco needs an oracle per app); oracle authoring (competitors take natural-language criteria, Myco needs code); hosting (no HTTP transport); brand (Splunk/Cisco and Browserbase with Microsoft Research now make the near-zero false-positive claim publicly).

**Decision it changes:** the public comparison and the Imagine Cup pitch should name Browserbase's verifier and the coding-agent stop-hook projects. The "nobody reads persisted state and blocks done" claim survives.

Sources: docs.braintrust.dev; docs.langchain.com/langsmith; langfuse.com/docs; arize.com/docs/ax; docs.agentops.ai; laminar.sh/docs; docs.patronus.ai (re-checked); docs.galileo.ai; scale.com/evaluation; browserbase.com/blog/building-verifiers-for-computer-use-agents (re-checked); github.com/abhid1234/truecall (re-checked); github.com/Armada735/verify-action-mcp; github.com/vnmoorthy/groundtruth. UNVERIFIED: Sentience / Predicate SDK.

## R-D. Hosted API pricing comparables (Medium; timing low)

Three patterns: observability bills data volume with a $29 to $50 entry plan (Langfuse Core $29 for 100k units, Arize Pro $50, Laminar Pro $30, Braintrust Pro $249); compute bills metered seconds against a dollar credit (E2B, Daytona, Modal, Browserbase $0.12 per browser-hour after 100 hours on $20); the nearest analogue to "per check" is per snapshot, 5,000 free and then about one to four cents (Chromatic $0.008, Percy $0.036, partly UNVERIFIED). Intercom Fin charges $0.99 per outcome and nothing when Fin fails or hands off. Re-checked: Chromatic, Fin, Langfuse.

**Sketch from comparables, not a recommendation to contact anyone:** bill per gate check that returns verified or refuted; do not bill `unknown` or rejected requests (Fin's no-charge-on-failure rule). Do not bill only on `verified`: that pays the vendor to say yes. Free allowance about 5,000 checks a month; a $29 to $50 plan with a bundle, then $0.008 to $0.036 per check. A design partner gives back its task set and oracle feedback, permission to publish an anonymised false-success rate, and a named quote.

**Decision it changes:** the unit named in `docs/product/vision.md` ("per verified check") rewards saying yes; prefer per check returning a verdict. Nothing is built for hosting now, per the open-core ruling.

Sources: braintrust.dev/pricing; langchain.com/pricing; langfuse.com/pricing (re-checked); arize.com/pricing; laminar.sh/pricing; e2b.dev/pricing; daytona.io/pricing; modal.com/pricing; browserbase.com/pricing; cua.ai/pricing; orgo.ai/pricing.md; browserstack.com/pricing; testmuai.com/pricing; chromatic.com/pricing (re-checked); fin.ai/pricing (re-checked). UNVERIFIED: LangSmith overage, Cua cloud sandbox rates.

## R-E. Shareable proof clips on X (Medium)

- **Firm format limits** (X API media docs, re-checked): H.264 High, AAC-LC, 30 or 60 fps, 1280×720, 720×1280 or 720×720 recommended, aspect between 1:3 and 3:1; GIFs at most 15 MB, 1280×1080, 350 frames. X's own pages conflict on free-account length and size (help page 140 s and 512 MB; API docs 20 min and 8 GB): respect the lower pair. Videos of 60 s or less loop.
- **Creative guidance is thin:** X's ad page (via Wayback) says keep under 15 s, show movement in the first few seconds, add captions for sound-off viewing, brand within 3 s, without sources. Vendor studies: Verizon Media/Publicis 2019 (5,616 US adults) 69% watch with sound off in public; Facebook 2016 captioned ads raised view time 12% on average. Uploaded `.srt` captions show only when the viewer turns them on. Link treatment on X is contested. No source was found on speed labels or verdict overlays.

**Spec bullets for the replay/share feature (#567):** MP4 H.264 High, AAC-LC, 30 fps, 1280×720 and 720×720 presets; target 15 s or less, stay under 60 s so it loops, hard cap 140 s; target under 30 MB, hard cap 512 MB, GIF fallback within 15 MB and 350 frames; the first 3 s show the task, the agent's "done" claim and the verdict stamp, with motion; burn in every caption; keep the verdict, the oracle's one-line evidence and the run id on screen throughout so any single frame carries the proof; show a speed label whenever time is compressed and a "simulated" label on mock runs (recommendation, not sourced); burn in the project name and URL.

Sources: docs.x.com/x-api/media/quickstart/best-practices (re-checked); help.x.com x-videos, posting-gifs-and-pictures, upload-caption-srt-file and business.x.com creative pages via Wayback (live pages return 403); streamingmedia.com coverage of the Verizon study; Facebook 2016 via Wayback; buffer.com/resources/links-on-x. Opinion only: speedrun.substack.com, flowjam.com, atomikgrowth.com.

## R-B. Credibility benchmarks (Low to medium)

From `benchmark-survey.md` §8, `findings/m2-00-failure-mode-sweep.md` and `docs/benchmark/public/`:

- **Report against:** Myco's own fc-v1 (100 tasks, Apache-2.0, independent byte-level grader, public package ready, RESULTS PENDING), plus an adapted subset of Windows Agent Arena's 24 LibreOffice Calc tasks under Myco's verifier, labelled "adapted WAA Calc subset", never a WAA score. OSWorld-Verified (47 `libreoffice_calc` tasks) is the reference everyone cites but runs on x86 VMs. OS-Omni (2611.34232) would add a Windows slice, but its code returned 404 on 2026-11-26.
- **Can the gate wrap their tasks cheaply?** Partly. A task needs an oracle; reusing the benchmark's own checker as the oracle is cheap but makes gate and grader the same thing, so a gated score would say nothing about false-done (M2 plan F2). The honest cheap path is the benchmark's checker as the independent grader and Myco's oracle as the gate. Calc tasks are the cheapest, because Myco's UNO verifier already reads Calc.
- **Published false-done rates** (sourced in m2-00): 91 to 105 of 361 OSWorld-Verified tasks end in a false DONE at 100 steps, 25 to 29% of all attempted (arXiv 2604.21375); 81 to 90 of 108 OSWorld 2.0 long-horizon trajectories stop or claim done with work left (2606.29537); 5 of 9 DONE claims fail a state check in Snorkel's Cua-Bench; 2 of 82 false successes in an AndroidWorld audit (2605.10448).

**Decision it changes:** confirms the existing plan (fc-v1 first, adapted WAA Calc subset second). Adds one rule for any public claim: the benchmark's own checker can be the grader, never the gate's oracle.

## R-F. Back-burner engineering, scoping only (Low)

- **KVM Linux backend (TIF-143):** `docs/product/linux-scale.md` (track U) already holds the design and a pre-registered bar: on fc-v1's 90 satisfiable tasks, zero contamination, parity within 5 points, and at least 4× verified throughput at N = 8. The Mac host has no `/dev/kvm` (HVF only, `docs/coordination/runtime-state.md`), so it needs a Linux host with KVM and Firecracker, which is a cost not yet measured. Nothing runs before the integrity fixes and the lead's GO.
- **Live Now mode:** deferred to v1 in `docs/design/gui-spec.md`. One open question remains: live transport by tailing the trace file or a local WebSocket from the runtime (§12, item 2).
- **Infinite / lineage canvas:** "branches lanes and Compare (J4, J5)" and "Replay (J6)" are deferred to v1 in `gui-spec.md`; the Timeline already draws on Canvas 2D. No design beyond that exists yet.

**Decision it changes:** none before the demo. The cheapest next scoping step for TIF-143 is pricing a KVM-capable Linux host for U-infra; for Now mode, choosing the transport when v1 starts.

## Proposed issue (ISSUE-FIRST; for the outer loop)

- **Package `myco-gate` so it can be installed from a channel.** Ship a launcher that runs without the clone-relative `tsx` path (an npm package or committed plain JS runnable as `node ${CLAUDE_PLUGIN_ROOT}/…`), and a way to bind task and run without fixed launch arguments. Acceptance: a Claude Code marketplace entry in the repo installs and answers on a clean machine; the same package can be described by a `server.json` for the MCP Registry. Evidence: R-C above; `docs/gate/clients.md`.

No other item implies work now.
