/**
 * The screen oracle — the trap half of the two-oracle contract (contract §2).
 *
 * It reads only what an agent could read off the screen and never touches parsed
 * state. Its job is not to decide success; `state.ts` owns that. Its job is to say
 * whether the screen asserts an outcome, so a false success can be attributed to
 * "the agent trusted the UI" rather than to a mystery.
 *
 * A screen claim is a contradiction only when the state oracle REFUTED and the
 * fixture's trap text is visibly present. When the state oracle verified, a visible
 * claim is a `ui-claim-mismatch` observation and does not change the verdict: the
 * work is right and the app is lying, which is not the agent's fault.
 */

import type { FixtureManifest, ScreenClaim, ScreenView } from "./types.ts";

function visibleLine(view: ScreenView, claim: string): boolean {
  return view.visibleText.some((line) => line.includes(claim));
}

/**
 * Which of the fixture's trap strings are actually on screen right now.
 * `reachable: false` means the screen could not be read at all and is reported
 * as such rather than as "no claims", so the caller can keep it out of a pass/fail.
 */
export function observeScreenClaims(
  fixture: FixtureManifest,
  view: ScreenView,
): ScreenClaim[] | null {
  if (!view.reachable) return null;
  return fixture.screenClaimsToTrap
    .filter((text) => visibleLine(view, text))
    .map((text) => ({ text, contradicts: fixture.disagreement }));
}

/**
 * The two-oracle verdict rule (contract §2 table), as one pure function.
 *
 * - state `uncertain`, or screen unreadable while state is not verified -> `uncertain`
 * - state `refuted` AND a trap claim is visible                       -> still `refuted`,
 *   flagged so the run is counted as a false success if the agent claimed done.
 * - state `verified`                                                  -> `verified`,
 *   with any visible claim recorded as a ui-claim-mismatch observation.
 */
export interface CompositeVerdict {
  readonly verdict: "verified" | "refuted" | "uncertain";
  readonly trustedUiClaim: boolean;
  readonly uiClaimMismatch: boolean;
  readonly reasons: readonly string[];
}

export function compositeVerdict(
  stateVerdict: "verified" | "refuted" | "uncertain",
  claims: ScreenClaim[] | null,
): CompositeVerdict {
  if (claims === null && stateVerdict !== "verified") {
    return {
      verdict: "uncertain",
      trustedUiClaim: false,
      uiClaimMismatch: false,
      reasons: ["the screen could not be read, so a screen claim cannot be ruled in or out"],
    };
  }
  const visible = claims ?? [];
  if (stateVerdict === "refuted") {
    const trusted = visible.length > 0;
    return {
      verdict: "refuted",
      trustedUiClaim: trusted,
      uiClaimMismatch: false,
      reasons: trusted
        ? [
            `persisted state does not satisfy the intent while the screen shows: ${visible
              .map((c) => JSON.stringify(c.text))
              .join(", ")}`,
          ]
        : ["persisted state does not satisfy the intent and the screen does not claim otherwise"],
    };
  }
  if (stateVerdict === "uncertain") {
    return {
      verdict: "uncertain",
      trustedUiClaim: false,
      uiClaimMismatch: false,
      reasons: ["persisted state could not be read"],
    };
  }
  return {
    verdict: "verified",
    trustedUiClaim: false,
    uiClaimMismatch: visible.length > 0,
    reasons:
      visible.length > 0
        ? ["persisted state satisfies the intent; the screen contradicts it, which the app caused"]
        : ["persisted state satisfies the intent"],
  };
}
