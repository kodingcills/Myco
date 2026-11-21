# UI prompt template (Myco)

Use this to brief any agent on UI work. Fill every slot; "n/a" is allowed, blank is not.
Binding spec: [`gui-spec.md`](./gui-spec.md). Tokens: [`tokens.json`](./tokens.json).

```
TASK
  Surface / component: <name from gui-spec §2, or "NEW (needs sign-off)">
  Question it answers: <Now | Why | Proof>
  Journey(s): <J1..J6 from gui-spec §3>
  Cut line: <v0 | v1+>

VISUAL SYSTEM (non-negotiable)
  Tokens: tokens.json only, by name (bg.*, border.*, text.*, verdict.*, font.size.*, space.*, radius.*, motion.*).
  Icons: Lucide 16/12, stroke 1.5.
  Never: new colors/sizes/radii/durations, platform defaults, gradients, shadows, blur, emoji.

COMPONENT / CONTROL
  Name and purpose:
  Anatomy (parts, slots, labels, exact sizes):
  Variants (size, style, intent):
  States: idle, hover, focus-visible, pressed, selected, disabled, loading, error, unknown:
  Input: mouse, keyboard (keys from gui-spec §3), focus order, Tab stops:
  Hit target ≥ 28×28; aria labels; verdict = glyph + word + color.

LAYOUT / STRUCTURE
  Regions (role, size, resize behavior), in order:
  Adapts at < 1280 wide:
  Continuity: reuse existing components by name (gui-spec §2). No new primitives.

INTERACTION MODEL
  State transitions and feedback:
  Keyboard and shortcuts:
  Focus management (where focus lands, what restores it):
  Empty / loading / error / unknown / not recorded:
  Motion: only from gui-spec §1.5; keyboard actions 0ms.

DATA
  Fields consumed (gui-spec §6, with source refs shown in UI):
  Missing-data behavior:

ENGINEERING
  Stack: gui-spec §7 (Vite + React + Base UI + Tailwind-from-tokens + zustand + virtuoso).
  Perf budget: gui-spec §8 rows that apply:
  Output: working code + Storybook-free screenshots at 1440×900.

REFERENCES
  <T3 Code / Temporal / DevTools / Linear pattern being borrowed, and exactly what>

NEGATIVES (task-specific, in addition to gui-spec §5)
  -

ACCEPTANCE
  gui-spec §11 checklist + screenshots in PR + outer-loop review.
```
