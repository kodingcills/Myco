# Myco GUI spec (locked)

Status: **binding** for every human-facing Myco surface (viewer, run reports, demo front end).
Tokens: [`tokens.json`](./tokens.json) is the single source of truth for every color, size, radius,
duration, and easing. Prompt template for briefing UI work: [`ui-prompt-template.md`](./ui-prompt-template.md).
Deviations need outer-loop sign-off in the PR. Owner: outer loop (Grok Bot) on behalf of Tiffany.

## 0. What this is

**Myco Viewer** is a flight recorder for desktop agents. A person opens it to answer three
questions, in this order of importance for a finished run:

| # | Question | Mode name | Shortcut |
|---|---|---|---|
| 3 | **Can I trust the result?** Verification, state changes, external effects, failures, recovery evidence. | **Proof** | `3` |
| 2 | **Why is it happening?** Decisions, dependencies, observed state, actions, alternative paths. | **Why** | `2` |
| 1 | **What's happening?** Live desktops, active agents, execution branches, current work. | **Now** | `1` |

A finished run opens on **Proof** (verdict first). A live run opens on **Now**. It is not a chat app,
not a dashboard of cards, not a landing page. It behaves like a dense desktop tool: T3 Code,
Linear, Chrome DevTools.

### References and the exact pattern taken from each

| Reference | Pattern we take | Where it lands |
|---|---|---|
| **T3 Code** (primary, interaction feel) | Thread sidebar with `Mod+1..9` jump, hint labels shown while `Mod` is held, `Mod+Shift+[`/`]` prev/next; `Mod+B` toggles sidebar; `Mod+D` toggles the right panel; `F6`/`Shift+F6` cycles regions and restores last focus per region; sidebar is a WAI-ARIA tree with one Tab stop; live follow never broken by focus moves; `Mod+F` find inside the diff pane. | Runs sidebar, Inspector, all keyboard rules (§3) |
| **Temporal UI** | Compact (order only) vs Timeline (clock time) views of the same events; pending work = dashed line; selection shared via URL (`?step=`) across views; pending items pinned to top. | Step list vs Scrubber; live states |
| **Chrome DevTools Performance** | Overview strip with a draggable range + playhead above a detail view; filmstrip of screenshots on the time axis. | Scrubber |
| **Datadog / Supabase trace waterfall** | Header with status, duration, counts; virtualized rows; arrow keys move rows, Right/Left expand/collapse, Enter selects; markers drawn over bars. | Step list, Verdict Bar counts |
| **Braintrust trace panel** | Select a row → right panel with Details / Raw tabs; Raw is the exact JSON. | Inspector |
| **Linear** | 13px UI type, 1px borders instead of shadows, keyboard-first, no decoration. | Visual system |
| **details.so** | The quality bar: every detail intentional. Not a visual style to copy. | Review bar |

---

## 1. Visual system lock

All values below exist in `tokens.json`. **Using a value not in `tokens.json` is a bug.**

### 1.1 Color

| Token | Hex | Use |
|---|---|---|
| `bg.canvas` | `#0B0C0E` | App background, Verdict Bar |
| `bg.surface1` | `#111316` | Panels (sidebar, inspector, scrubber) |
| `bg.surface2` | `#171A1E` | Rows on hover, inputs, code blocks |
| `bg.surface3` | `#1E2227` | Selected row, open popover/menu |
| `border.subtle` | `#23272D` | Row separators |
| `border.default` | `#2E333A` | Panel edges, control outlines |
| `border.strong` | `#3D434B` | Popover/menu edge, drag handles on hover |
| `text.primary` | `#E6E8EB` | Values, titles, focus ring, playhead, live indicator |
| `text.secondary` | `#A3AAB4` | Labels, keys in key/value pairs |
| `text.tertiary` | `#7D858F` | Timestamps, hints, "not recorded" (canvas/surface1/surface2 only) |
| `text.disabled` | `#4F555D` | Disabled controls only |

**Verdict colors are the only accents in the product.** They mean verification outcome and nothing else.

| Verdict | `fg` | `tint` (banner/row bg) | Glyph (Lucide) | fg on canvas | fg on surface1 | fg on tint |
|---|---|---|---|---|---|---|
| **Verified** | `#3FB950` | `#112116` | `check` | 7.70:1 | 7.33:1 | 6.60:1 |
| **Recovered** | `#D9A23B` | `#241E13` | `undo-2` | 8.56:1 | 8.14:1 | 7.23:1 |
| **Failed** | `#F2554B` | `#271515` | `x` | 5.76:1 | 5.47:1 | 5.13:1 |
| **Unknown** | `#9AA3AD` | `#1C1E21` | `circle-help` | 7.66:1 | 7.28:1 | 6.54:1 |

`text.primary` on every tint ≥ 13.4:1. `text.primary` on canvas 15.94:1; `text.secondary` 8.36:1;
`text.tertiary` 5.24:1 (4.67:1 on surface2; **not allowed on surface3**, 4.28:1).
Verdict is never conveyed by color alone: always glyph + word + color.

Step-level marks reuse verdict semantics: a failed guard/check = Failed color; a recovery event =
Recovered color; an unresolved check (`passed: null`) = Unknown color. Nothing else is colored.
Diffs are **not** green/red: removed = `−` glyph + strikethrough `text.tertiary`; added = `+` glyph +
`text.primary`. Only a claimed-vs-persisted **disagreement** is colored (Failed).

### 1.2 Type

Families (self-hosted woff2, subset Latin, no CDN): **Inter Variable** (UI) with `cv11 ss01 tnum`;
**JetBrains Mono Variable** (state/data) with `zero tnum`.

| Token | Family | Size/Line | Weight | Use |
|---|---|---|---|---|
| `micro` | sans, UPPERCASE, +0.02em | 11/16 | 500 | Section labels ("CLAIMED", "PERSISTED") |
| `small` | sans | 12/16 | 400 | Secondary metadata, tooltips |
| `body` | sans | 13/20 | 400 | Default UI text |
| `bodyStrong` | sans | 13/20 | 550 | Row titles, button labels |
| `title` | sans | 15/20 | 600 | Task line in Verdict Bar, panel titles |
| `verdict` | sans | 24/28 | 650 | The verdict word. Only place this size exists. |
| `data` | mono | 12/18 | 400 | Values, IDs, actions, predicates, JSON |
| `dataStrong` | mono | 12/18 | 600 | Disagreeing value, step index |
| `dataSmall` | mono | 11/16 | 400 | Timestamps, line refs (`trace.jsonl:42`) |

Rule: anything a machine produced (values, IDs, predicates, timestamps, counts) is mono. Anything a
human wrote for the UI is sans. No other sizes, no other weights.

### 1.3 Space, size, shape

- Spacing scale (px): `0 2 4 8 12 16 24 32 48`. Nothing else. Panel padding 12; row horizontal padding 12; gap between label and value 8.
- Row height: 32 (default), 28 (compact density toggle, `Mod+Shift+D`). Control height 28.
- Radius: controls 4; thumbnails 2; panels **0** (panels butt against each other separated by 1px `border.default`); status dots full.
- Borders: 1px everywhere; selection bar 2px left edge `text.primary`; Verdict Bar bottom rule 2px verdict `fg`.
- Elevation: **none.** No `box-shadow` anywhere. Popovers/menus = `bg.surface3` + 1px `border.strong`.
- Icons: Lucide, 16px (12px inside `small`/`dataSmall` contexts), stroke 1.5, color inherits a text token.
- Focus ring: 1px solid `text.primary`, 1px offset, on `:focus-visible` only.

### 1.4 Layout grid (design viewport 1440×900, minimum 1280×800)

```
┌──────────────────────────────────────────────────────────────────────────────┐ 40  App bar
├──────────┬───────────────────────────────────────────────┬───────────────────┤
│          │ VERDICT BAR                                    (spans center+insp) │ 72
│  Runs    ├───────────────────────────────────────────────┬───────────────────┤
│  sidebar │ Center (mode content: Proof / Why / Now)      │ Inspector         │
│  264     │ fluid, min 560                                │ 384 (Mod+D)       │
│  (Mod+B) │                                               │ tabs: Detail│Raw  │
│          ├───────────────────────────────────────────────┴───────────────────┤
│          │ SCRUBBER (filmstrip + ruler + playhead)                            │ 112
└──────────┴───────────────────────────────────────────────────────────────────┘
```

- App bar 40: left `myco` wordmark (bodyStrong, text.primary, no logo art) + open file name (data). Right: `Open` (Mod+O), `?` shortcuts sheet.
- Sidebar 264, resizable 200–360, collapsible. Inspector 384, resizable 320–560, collapsible. Scrubber fixed 112. Verdict Bar fixed 72, never scrolls.
- Below 1280 wide: Inspector becomes an overlay sheet from the right (same width, `border.strong` left edge); sidebar auto-collapses. No mobile layout in v0/v1.
- Only the Center and the Inspector body scroll. Nothing else scrolls.

### 1.5 Motion

| Event | Duration | Easing | Property |
|---|---|---|---|
| Hover bg | 100ms | `out` | background-color |
| Button press | 120ms | `out` | transform scale(0.98) |
| Popover/menu open | 150ms | `out` | opacity + translateY(4px→0); close 0ms |
| Panel collapse/expand, Inspector sheet | 200ms | `out` | width / transform |
| Verdict change (live run settles) | 240ms | `out` | rule color + word crossfade, once |
| Live indicator | 1600ms loop | `linear` | opacity 1→0.4→1 on a 6px dot |
| Keyboard-triggered anything (mode switch, step move, scrub) | **0ms** | — | — |

`out` = `cubic-bezier(0.23, 1, 0.32, 1)`. Animate only `opacity`, `transform`, `background-color`,
`width` (panels). No stagger, ever (high-frequency tool UI). `prefers-reduced-motion`: all to 0ms, live dot static.

---

## 2. Component anatomy

Every component below is the only implementation of its job. New primitives need sign-off.
States column: I = idle, H = hover, F = focus-visible, A = active/pressed, S = selected, D = disabled, L = loading, E = error.

### 2.1 VerdictBadge
- Purpose: the one way a verdict is shown, at every size.
- Anatomy: `[glyph][word]`; optional `[subtype]` (e.g. `False success`, `Not scored`).
- Variants: `xl` (Verdict Bar: glyph 20, word `verdict`), `md` (rows: glyph 16, word `bodyStrong`), `sm` (scrubber/sidebar: glyph 12 only, word in tooltip + aria-label).
- States: static, no hover. `L` (live, no verdict yet) renders the neutral **Running** badge: live dot + `Running` in text.primary. Never green while running.

### 2.2 VerdictBar (72px)
- Anatomy, left→right: VerdictBadge xl · task line (`title`, one line, ellipsis; full in tooltip) under it the run line (`dataSmall`, text.tertiary: `runId · taskId · started HH:MM:SS ET · 41.2s · 12 steps · 2 checks`) · spacer · counts (`data`: `checks 1/2 · guard failures 1 · recoveries 1`, each count clickable → filters) · ModeTabs · `Replay` (v1, hidden in v0).
- Background `bg.canvas`, bottom rule 2px verdict fg. No tinted background (tint is for rows).
- States: I; L (live) shows Running badge and live elapsed time ticking in mono.

### 2.3 ModeTabs
- Anatomy: segmented control, 3 segments `1 Now` `2 Why` `3 Proof`, height 28, the digit in `dataSmall` text.tertiary as a shortcut hint.
- States: I text.secondary; H bg.surface2; S bg.surface3 + text.primary; F ring; D (`Now` on a finished run: D with tooltip "Run finished; see Why").
- Input: click, `1`/`2`/`3` (when no text field focused), arrow keys inside the group. One Tab stop.

### 2.4 RunsSidebar (264)
- Purpose: T3-style list of opened runs (v0: files opened this session, persisted in IndexedDB as references only).
- Anatomy per row (32): VerdictBadge sm · task line (bodyStrong, ellipsis) · relative time (`dataSmall`, right) · second line none. While `Mod` is held, rows 1–9 show a `⌘1`…`⌘9` hint chip replacing the time.
- States: I, H bg.surface2, S bg.surface3 + 2px selection bar, F ring, L (parsing: live dot in place of badge), E (unreadable file: `file-warning` icon in text.secondary + `Can't read file`; never a verdict color).
- Input: WAI-ARIA tree, one Tab stop; ↑/↓, Home/End, Enter opens, `Mod+1..9`, `Mod+Shift+[`/`]`, `Delete` removes from list (not from disk), `F2` none (runs aren't renamable).

### 2.5 Comparator (Claimed vs Persisted) — the core component
- Purpose: show what the agent/UI claimed next to what the independent verifier read from persisted state.
- Anatomy: header row with two `micro` labels `CLAIMED (UI / agent)` | `PERSISTED (verifier)`, equal columns, 1px divider. One row per compared field: field name (`data`, text.secondary, left gutter 160) · claimed value (`data`) · persisted value (`data`) · source refs under each value (`dataSmall` links: `trace.jsonl:14`, `result.json#/verdict/checks/0`).
- Row states: **agree** (no color, `=` glyph text.tertiary in the gutter); **disagree** (row bg `verdict.failed.tint`, both values `dataStrong`, persisted value in Failed fg, `≠` glyph Failed fg, 2px Failed left bar); **unknown** (persisted value replaced by `could not look` in Unknown fg + the verifier's reason in `small`); **not recorded** (the literal text `not recorded` in text.tertiary, italic forbidden, just tertiary).
- Disagreeing rows sort to the top. Max height 50% of Center; scrolls internally.
- Input: rows are focusable (↑/↓); Enter opens the source in Inspector › Raw.

### 2.6 CheckRow
- Anatomy (32): VerdictBadge md for the check (`passed: true` → Verified, `false` → Failed, `null` → Unknown) · check name (`data`) · weight `w=1.00` (`dataSmall`) · score `0.00` · reason (`small`, one line, ellipsis) · source ref.
- States: I, H, S, F. Never collapse `null` into false.

### 2.7 StepRow (Why mode list, 32)
- Anatomy: index `#03` (`dataStrong`, width 40) · thumbnail 48×30 radius 2 (or a `image-off` 12px icon in text.tertiary when absent) · action (`data`: `setValue B39 = "REVISED-SESSION1"`) · guard summary (`dataSmall`: `pre 3/3 · post 1/1`) · state version `v5→v6` (`dataSmall`) · time offset `+34.26s` (`dataSmall`, right).
- Left 2px mark: none / Failed (guard failed at this step) / Recovered (recovery event belongs here) / Unknown (unresolved check).
- States: I, H bg.surface2, S bg.surface3 + selection bar, F ring, L (in-flight step on a live run: dashed 1px `text.tertiary` bottom border + live dot instead of time).
- Recovery steps render indented 16px under the step they recover, with a 1px `border.strong` elbow connector (Temporal-style lane), so the recovery branch is visible in the list.

### 2.8 Scrubber (112)
- Anatomy, top→bottom: ruler 16 (ticks + `dataSmall` labels, elapsed seconds) · filmstrip 60 (thumbnails 96×60 at step positions, clipped to visible range) · marker lane 12 (2×8 verdict-colored ticks for guard failures/recoveries/unresolved; nothing for normal steps) · range brush 24 (DevTools overview: whole-run minimap with draggable window).
- Playhead: 1px `text.primary` full height + 8px triangle cap. Hover line: 1px `border.strong` + time tooltip.
- States: I; dragging (cursor `ew-resize`, no easing, playhead follows pointer within one frame); L live: right edge grows, playhead pinned to "now" until the user scrubs (then a `Follow live` button appears at the right, `Mod+L`).

### 2.9 Inspector (384)
- Tabs: `Detail` | `Raw` (28px tab row, same visual as ModeTabs without digits).
- Detail for a step, fixed section order: **Screenshot** (full width, aspect kept, click → 1:1 lightbox) · **Observed state** (pre: stateVersion, nodeCount, focused element) · **Decision** (agent rationale + alternatives considered; `not recorded` until the trace carries it) · **Preconditions** (PredicateResult list: glyph · predicateName · observed) · **Action** (ActionRecord, mono key/value) · **Postconditions** · **Effects** (external effects; `not recorded` until present).
- Detail for a check: reason, partial score, the readback evidence, links.
- Raw: the exact source JSON (pretty-printed, `data`, keys text.secondary, values text.primary, **no syntax colors**), header `trace.jsonl:42` + `Copy` + `Copy path`. `Mod+F` finds within Raw.

### 2.10 Buttons and inputs
- Button: height 28, padding 0 12, radius 4, `bodyStrong`. Variants: `default` (bg.surface2, 1px border.default), `ghost` (transparent; H bg.surface2). **No primary/filled-accent variant** — accents are verdict-only.
- Kbd chip: `dataSmall`, 1px border.default, radius 4, padding 0 4, text.tertiary.
- Tooltip: bg.surface3, 1px border.strong, `small`, 400ms open delay, 0ms on subsequent hovers within 500ms.
- Min hit target 28×28 (desktop pointer tool). All icon-only buttons have aria-label and a tooltip with the shortcut.

### 2.11 Status surfaces (shared)
| State | Rendering |
|---|---|
| Empty (no file) | Open screen: centered 480px column: `Open a Myco run` (title), one line `Drop a .mycotrace file or a run folder, or press ⌘O.` (body, text.secondary), `Open…` button. Nothing else. No illustration. |
| Loading | Verdict Bar shows Running-style neutral badge `Loading` + progress `1,240 / 10,000 events` (mono). Rows render progressively; no spinners on rows, no skeleton shimmer. |
| Parse error | Center: `Can't read this run` (title), the validator issue (`data`: path + keyword + message), `Open another…`. Partial data already parsed stays visible and is labeled `incomplete trace`. |
| Unknown verdict | VerdictBadge Unknown + the first `unresolvedState` / reason, verbatim. Never softened. |
| Field missing | `not recorded` (text.tertiary). Same words everywhere. |

---

## 3. Interaction sequences (shot lists)

Global keys: `Mod+O` open · `Mod+B` sidebar · `Mod+D` inspector · `F6`/`Shift+F6` cycle regions (sidebar → verdict bar → center → inspector → scrubber; restores last focus per region) · `1`/`2`/`3` modes · `J`/`K` or `↓`/`↑` next/prev step · `[`/`]` prev/next *flagged* step (failure/recovery/unknown) · `←`/`→` in scrubber = ±1 step, `Shift` = ±10 · `Enter` open selection in Inspector · `R` toggle Detail/Raw · `Mod+F` find (center list or Raw) · `Esc` closes topmost overlay, then clears selection · `?` shortcuts sheet · `Mod+1..9` / `Mod+Shift+[` `]` runs. Single-letter keys are ignored while an editable has focus.
Selection is one global value (`?run=&step=&check=` in the URL hash) shared by every mode, the list, the scrubber, and the Inspector.

### J1 — Open a finished run (v0)
1. User drags `run.mycotrace` onto the window (or `Mod+O`). Drop target: whole window, 1px dashed `border.strong` inset 8 while dragging; no other effect.
2. ≤150ms: Verdict Bar appears with the verdict (result.json is parsed first), task line, counts. Mode = Proof.
3. Center shows Comparator (disagreements first), then Checks, then State changes, then Failures & recovery. Focus lands on the first Comparator row.
4. Scrubber fills in as trace.jsonl streams; thumbnails lazy-load for the visible range.
5. Run is added to the top of RunsSidebar, selected.

### J2 — Investigate a false success (v0)
1. Verdict Bar: `✕ Failed · False success`. Counts show `checks 0/1`.
2. Comparator top row is red: `B39  claimed "REVISED-SESSION1"  ≠  persisted "Enzo Nakamura"`, refs under each.
3. User presses `Enter` on the row → Inspector › Raw opens the verifier check JSON at `result.json#/verdict/checks/0`.
4. User clicks the claimed ref `trace.jsonl:14` → mode switches to Why (0ms), step `#02` selected, StepRow scrolled into view, playhead jumps, Inspector › Detail shows the step's screenshot (UI showed the new value) and postconditions.
5. `]` jumps to the next flagged step. `Esc` clears selection; `3` returns to Proof with the Comparator row still focused.

### J3 — Step through why (v0)
1. `2` → Why. Step list, all rows; no step selected → Inspector shows run summary.
2. `J` selects `#00`; Inspector › Detail updates within one frame (≤50ms); playhead moves; no animation.
3. Holding `J` auto-repeats at OS key-repeat rate; screenshots that aren't decoded yet show the 96×60 thumbnail scaled up until the full image is ready (no blank flash).
4. Dragging the playhead scrubs: selection follows the nearest step under the playhead each frame.

### J4 — Watch a live run with a branch (v1)
1. Run opens on Now: Center = live desktop frame (latest screenshot or stream, 16:10, letterboxed on canvas), beneath it the current intent (`title`) and the in-flight action (`data`) with a live dot.
2. Verdict Bar shows `Running`. Scrubber right edge grows; playhead pinned to now.
3. A `branch` event arrives: a second lane appears in the Scrubber marker area labeled `b1 ← #07` (mono); StepRows for b1 are indented under `#07` with the elbow connector. No animation besides the row appearing.
4. User scrubs back → follow pauses, `Follow live ⌘L` button appears. `Mod+L` re-pins.
5. Run ends: verdict settles (240ms crossfade, once), mode stays where the user is; if they were on Now, Now switches to disabled and focus moves to Proof's first row only if focus was inside the live frame.

### J5 — Compare branches (v1)
1. In Why, select two branch heads with `Mod+click` (or `C` on a branch lane) → `Compare` view replaces Center.
2. Two columns, one per branch, each a VerdictBadge md + Comparator of its persisted state; rows aligned by field; differences between branches marked with `≠` in text.primary (not red — red is only claimed-vs-persisted disagreement).
3. `Enter` on a branch column → `Continue from b1` action (v1, gated by runtime support).

### J6 — Replay from snapshot (v1)
`Replay` in Verdict Bar → confirm popover listing the snapshot id and task params (mono) → new run opens in RunsSidebar linked `replay of <runId>`. Never auto-runs.

---

## 4. Hard continuity rules

1. A verdict is always `glyph + word + color`, rendered only by VerdictBadge, identical in Verdict Bar, sidebar, rows, compare.
2. Verdict colors never mean anything else (no green "connected", no red "delete", no amber "warning"). Non-verdict errors use text tokens + an icon.
3. The four verdict words are fixed: `Verified`, `Recovered`, `Failed`, `Unknown`. Running runs say `Running`. Subtypes: `False success`, `Not scored`. No synonyms (no "Passed", "Success", "Error", "Uncertain" in the UI).
4. Selection (run, step, check) is a single URL-backed value; switching modes, toggling panels, or resizing never loses it.
5. Step index format `#03` (zero-padded to the run's digit count), mono, everywhere. State versions `v5→v6`. Timestamps: absolute `HH:MM:SS.mmm ET` (viewer's local zone with label) in tooltips/Raw, relative `+34.26s` in rows.
6. Missing data reads `not recorded`; unverifiable data reads `could not look`. Identical strings everywhere.
7. Every value derived from evidence carries a source ref (`file:line` or JSON pointer) that opens Inspector › Raw. No orphan claims.
8. Verdict Bar, App bar, Scrubber never move, resize, or scroll between modes. Inspector width persists per user.
9. Mode layouts reuse the same components; no mode gets a bespoke row, badge, or button.
10. Keyboard behavior is identical across modes for the same key.

## 5. Negatives (never)

- Never show green, `Verified`, or a check mark unless `verdict.status == "verified"` and every check `passed == true`. Unverified = Unknown. Running ≠ success.
- Never collapse `passed: null` into fail or pass.
- No gradients, glassmorphism, blur, glow, noise, shadows, neumorphism, or colored panel backgrounds.
- No emoji, mascots, illustrations, hero copy, marketing taglines, "AI sparkle" icons, or exclamation marks.
- No chat bubbles, no card grid dashboards, no KPI tiles, no donut charts.
- No new colors, sizes, radii, weights, or durations outside `tokens.json`. No platform-default blue links or focus rings.
- No syntax highlighting colors in Raw (they'd compete with verdict color).
- No stagger, bounce, spring overshoot, skeleton shimmer, or animation on keyboard actions. No spinners on rows.
- No modal for anything reachable by the Inspector. No toasts in v0.
- No network requests at runtime: no CDN fonts, analytics, telemetry, or remote images. The viewer works with Wi-Fi off.
- No truncation of verifier reasons in Raw or Detail (ellipsis only in rows, with full text in tooltip).
- No hiding the Unknown state behind a softer label ("Pending review", "Partial").

---

## 6. Data contract

The viewer reads the artifacts already defined in [`docs/architecture/evidence-schema.md`](../architecture/evidence-schema.md)
(`schemas/trace-events.ts`, `schemas/result-record.ts`, `schemas/ledger-row.ts`) and validates them with
the existing `schemas/validate.ts` (imported, not copied). It never calls a private runtime path.

### 6.1 Input forms (all offline)
1. **`.mycotrace`** — a zip (store or deflate) of one run directory: `trace.jsonl`, `result.json`, optional `ledger.jsonl` (rows for this run), optional `artifacts/` (screenshots `*.png|*.webp` + `*-meta.json`), optional `manifest.json` `{ format: "mycotrace/1", runId, files: {path: sha256} }`.
2. A run **folder** dropped or picked (`runs/<runId>/`), same layout.
3. A bare `result.json` + `trace.jsonl` pair.
Producer: the evidence writer gains `myco pack <runDir>` → `<runId>.mycotrace` (Runtime/M1 owners).

### 6.2 Verdict mapping (display ← data)
| Display | Condition |
|---|---|
| **Verified** | `recordKind != "session"`, `verdict.status == "verified"`, all checks `passed == true`, no `recovery` event other than none. |
| **Recovered** | same as Verified **and** ≥1 `recovery` event (≠ `aborted-uncertain`) or a `guard-failure` followed by completion. |
| **Failed** | `verdict.status == "refuted"`. Subtype **False success** when the ledger row `oracle == "ground-truth:false"` or a claimed value disagrees with a persisted value. |
| **Unknown** | `verdict.status == "uncertain"`, or any check `passed == null`, or record is a `session` record (subtype **Not scored**), or result.json missing. |
| **Running** | live source, no terminal record yet. |

### 6.3 Field → UI map (exists today)
| UI | Source |
|---|---|
| Verdict Bar | `result.json`: `runId`, `taskId`, `taskParams`, `startedAt`, `verdict.{status,score,reasons}`, `unresolvedState`; counts from `verdict.checks`, `guard-failure` and `recovery` events. |
| Comparator · Persisted | `verdict.checks[].{name,passed,reason}` (verifier readback). |
| Comparator · Claimed | v0 derivation: the intended value (`taskParams` / last `setValue`/`type` action on the target) + UI-observed postcondition `PredicateResult.observed`. Labeled `claimed (derived)` until a `claim` event exists. |
| Checks | `verdict.checks[]` incl. `partial_score`. |
| Step list / Why | `steps[]` (EvidenceStep) joined with `action`, `guard-evaluation`, `observation` events by `step`. |
| Failures & recovery | `guardFailure`, `guard-failure`, `fault-injection`, `recovery` events. |
| State changes | `stateVersionBefore/After`; full diffs when a `state-diff` artifact exists, else `not recorded`. |
| Screenshots | `artifacts/` files matched by step via `*-meta.json` (today: `mid-typing.png` + meta, e.g. `uiaElements`). |

### 6.4 Additive events the viewer is built to consume (proposals; schema owners land them)
Closed, additive, same `type`-discriminated style; the viewer shows `not recorded` until they exist.
- `screenshot` `{ timestamp, step, path, sha256, width, height }`
- `claim` `{ timestamp, step, source: "agent"|"app-ui", field, value }`
- `decision` `{ timestamp, step, rationale, alternatives: string[] }`
- `branch` `{ timestamp, branchId, parentBranchId, forkStep, forkStateVersion, reason }` (+ `branchId` on step events)
- `external-effect` `{ timestamp, step, kind, target, committed: boolean }`
- `state-diff` artifact `{ step, before, after }` per verifier-readable field.

---

## 7. Stack (decided)

| Layer | Choice | Why |
|---|---|---|
| Language/tooling | TypeScript strict, pnpm workspace, Biome, Vitest | Already the repo's toolchain; schemas and validator are TS and get imported directly. |
| App | **Vite 7 + React 19**, package `viewer/` in the pnpm workspace | Fast dev loop, static output, largest agent-known ecosystem; no server needed. |
| Primitives | **Base UI** (tabs, tooltip, popover, menu, dialog-for-lightbox) | Unstyled + accessible; we own every pixel via tokens (pick-ui-library). |
| Styling | **Tailwind v4** with a theme generated from `tokens.json` (`@theme` CSS vars; build fails on unknown tokens) + `cva`/`clsx` for variants | Tokens become the only available utilities, enforcing §1 mechanically. |
| State | **zustand** (one store: runs, selection, view prefs); selection mirrored to URL hash | Small, no provider tree, selector-level re-render control for 60fps scrub. |
| Lists | **react-virtuoso** for step list, checks, Raw lines | Variable-height virtualization, keyboard-friendly. |
| Timeline/scrubber | Custom: **Canvas 2D** for ruler + marker lane + brush; DOM `<img>` only for the ≤ ~20 visible filmstrip thumbnails | Canvas redraw per frame is cheap at 10k steps; DOM thumbnails keep images simple and lazy. |
| Parsing | Web Worker: stream `trace.jsonl` line by line, validate, index by `step`; zip via **fflate** | Keeps the main thread free; result.json first so the verdict paints before the trace finishes. |
| Images | Worker `createImageBitmap` → 96×60 thumbnails cached as object URLs; full-size decoded on demand, LRU 64 | Lazy, bounded memory. |
| Motion | CSS transitions only. No motion library in v0. | §1.5 needs nothing more. |
| Packaging | Static web app. `pnpm --filter viewer build` → `viewer/dist/` **plus** a single-file `myco-viewer.html` (vite-plugin-singlefile) that opens any `.mycotrace` offline. Later `myco view <run>` serves it on localhost. | **No Electron/Tauri** in v0/v1: nothing needs native APIs. Revisit only if live desktop streaming needs it. |

## 8. Make it fast (budgets, enforced in CI with a 1,000-step and a 10,000-step fixture)

| Metric | Budget (M-series Mac, Chrome stable) |
|---|---|
| JS (gzipped, excl. fonts) | ≤ 200 KB initial; fonts ≤ 120 KB (2 variable woff2, Latin subset) |
| Open screen first paint | ≤ 300 ms from navigation |
| Verdict visible after drop | ≤ 150 ms for any trace (result.json parsed first) |
| 1,000 steps (~10k events, ~5 MB) fully interactive | ≤ 800 ms |
| 10,000 steps (~100k events, ~50 MB) | Verdict ≤ 150 ms, first rows ≤ 500 ms, fully indexed ≤ 4 s, UI responsive throughout |
| Scrub / step move → playhead + selection updated | ≤ 16 ms (one frame); Inspector text ≤ 50 ms |
| Full screenshot shown on select | ≤ 100 ms cached, ≤ 250 ms cold (thumbnail shown instantly meanwhile) |
| Keyboard input → visible response | ≤ 50 ms |
| Memory with 1,000 screenshots | ≤ 400 MB (LRU 64 full bitmaps; thumbnails only for visible ±20) |
| Rules | Any list > 50 rows virtualized. No layout reads in scroll/scrub handlers. Zustand selectors per component. |

## 9. MVP cut line

**v0 — ship first (the smallest viewer that proves the product):**
- Open screen; open one `.mycotrace` / folder / pair offline.
- Verdict Bar with exact verdict mapping (§6.2).
- **Proof** mode: Comparator (claimed derived vs persisted), Checks, Failures & recovery.
- **Why** mode: virtualized step list + Inspector (Detail/Raw) + Scrubber with filmstrip.
- Source refs on every value; keyboard map §3 (minus v1 keys); RunsSidebar for files opened this session.
- Single-file HTML build. Journeys J1–J3 pass.

**v1+ — explicitly deferred:** Now mode and live desktops · live streaming/follow · branches lanes and Compare (J4, J5) · Replay (J6) · command palette (cmdk, `Mod+K`) · external effects panel · state-diff view · fleet "Desk" overview · `myco view` local server · compact density. Nothing from this list is built until v0 is merged and reviewed.

## 10. Developer surfaces (same data, thin layers)

One core, four doors. The **core API** is the operation contract (`desktop.create`, `observe`, `act`, `verify`, `fork`, `replay`, `close`) plus the evidence artifacts in §6. Every surface is a thin adapter with no logic of its own:
- **CLI** (`myco …`): human/CI door; `myco run`, `myco pack`, `myco view`.
- **TypeScript SDK** (`@myco/sdk`): typed wrapper over the core for agent developers.
- **MCP server**: the SDK's operations exposed as tools for any coding agent.
- **GUI**: reads only the artifacts (§6); never a private path. If the GUI needs a field, it goes in the schema first.
The Rust runtime's existing `myco-rt-cli` / `myco-rt-mcp` must stay thin over `myco-rt-core` under this rule.

## 11. Acceptance checklist (every UI PR)

- [ ] Screenshots at 1440×900 of each changed screen/state (and 1280×800 if layout changed), attached in the PR body. Live/motion changes: a short screen recording.
- [ ] Journeys touched (J1–J6) walked by keyboard only; listed in the PR.
- [ ] No value outside `tokens.json` (lint: no raw hex/px in components; Tailwind theme restricted).
- [ ] Verdict mapping unit-tested against the M1 sample runs in `docs/research/experiments/m1-013-session1/` (normal → as recorded, kill → Unknown, refuted → Failed).
- [ ] Contrast unchanged or re-computed in `tokens.json`.
- [ ] Perf budgets (§8) pass on the fixtures.
- [ ] Works with network disabled.
- [ ] Negatives (§5) self-reviewed line by line.
- [ ] Outer-loop review: Grok Bot reviews screenshots against this spec before merge; deviations require written sign-off in the PR.

## 12. Open questions (only these)

1. Who lands the §6.4 events and `myco pack`: Runtime Owner (Rust writer) or M1 (TS evidence writer)? Proposed: TS evidence schema first, Rust mirrors.
2. Live transport for Now mode (v1): tail the trace file vs. a local WebSocket from the runtime. Decide when v1 starts.
3. Whether the TS SDK wraps the Rust runtime over MCP/stdio or a native binding. Decide in MVP Discovery.
