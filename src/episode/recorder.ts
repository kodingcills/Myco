/**
 * What a transport hands the episode writer while an attempt runs: ordered actions and
 * observations, bounded, redacted as they arrive. Blobs (screenshots, structured state) are
 * content-addressed (`blobs/<sha256>.<ext>`), so the same frame twice is one file.
 *
 * Screenshots only pass through a `FrameRedactor`: the same rules the live watch view serves
 * frames under (#513, `src/watch/sanitize-frame.ts`: `sanitizePng` re-encodes from pixels and
 * `frameLeaks` is the byte backstop). That module has not landed, so this is the interface
 * (lands with #513); with no redactor every screenshot is WITHHELD, counted, never stored.
 */
import { MAX_ACTIONS, MAX_OBSERVATIONS } from "../../schemas/episode.ts";
import { blobIssues, currentHost, type HostFacts, redactText } from "./clean.ts";
import type { ActionInput, EpisodeAction, EpisodeObservation } from "./types.ts";
import { sha256Hex } from "./validate.ts";

export interface FrameRedactor {
  /** The servable PNG for these bytes, or null to refuse the frame. */
  redact(png: Uint8Array): Uint8Array | null;
}

export interface RecordedAttempt {
  readonly actions: {
    readonly capture: "recorded";
    readonly truncated: boolean;
    readonly items: readonly EpisodeAction[];
  };
  readonly observations: {
    readonly capture: "recorded";
    readonly withheld: number;
    readonly items: readonly EpisodeObservation[];
  };
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export class EpisodeRecorder {
  readonly #actions: EpisodeAction[] = [];
  readonly #observations: EpisodeObservation[] = [];
  readonly #blobs = new Map<string, Uint8Array>();
  #truncated = false;
  #withheld = 0;
  readonly #redactor: FrameRedactor | undefined;
  readonly #host: HostFacts;

  constructor(options: { readonly frameRedactor?: FrameRedactor; readonly host?: HostFacts } = {}) {
    this.#redactor = options.frameRedactor;
    this.#host = options.host ?? currentHost();
  }

  /** Index of the last recorded action, or null before the first. */
  get lastAction(): number | null {
    return this.#actions.length === 0 ? null : this.#actions.length - 1;
  }

  action(input: ActionInput): void {
    if (this.#actions.length >= MAX_ACTIONS) {
      this.#truncated = true;
      return;
    }
    const seq = this.#actions.length;
    const atMs = input.atMs ?? null;
    const r = (s: string) => redactText(s, this.#host).slice(0, 4000);
    let action: EpisodeAction;
    switch (input.kind) {
      case "type":
        action = { seq, atMs, kind: "type", text: r(input.text) || "<redacted>" };
        break;
      case "shell":
        action = { seq, atMs, kind: "shell", command: r(input.command) || "<redacted>" };
        break;
      default:
        action = { ...input, seq, atMs } as EpisodeAction;
    }
    this.#actions.push(action);
  }

  #observe(o: DistributiveOmit<EpisodeObservation, "seq">): void {
    if (this.#observations.length >= MAX_OBSERVATIONS) {
      this.#withheld += 1;
      return;
    }
    this.#observations.push({ ...o, seq: this.#observations.length } as EpisodeObservation);
  }

  screenshot(png: Uint8Array, afterAction: number | null = this.lastAction): void {
    const servable = this.#redactor?.redact(png) ?? null;
    if (
      servable === null ||
      servable.length < 8 ||
      PNG_SIGNATURE.some((b, i) => servable[i] !== b) ||
      blobIssues(servable, "png", this.#host).length > 0
    ) {
      this.#withheld += 1;
      return;
    }
    const sha256 = sha256Hex(servable);
    const file = `blobs/${sha256}.png`;
    this.#blobs.set(file, Uint8Array.from(servable));
    this.#observe({
      afterAction,
      kind: "screenshot",
      mediaType: "image/png",
      sha256,
      bytes: servable.length,
      file,
    });
  }

  /**
   * Structured state (never scrubbed: an unclean document is withheld, not altered). Returns
   * whether it was kept: a caller grading a withheld document must not bind the grade to it.
   */
  state(
    label: "persisted" | "ui-tree" | "app-state",
    mediaType: "text/csv" | "application/json",
    bytes: Uint8Array,
    afterAction: number | null = this.lastAction,
  ): boolean {
    if (blobIssues(bytes, "text", this.#host).length > 0) {
      this.#withheld += 1;
      return false;
    }
    const sha256 = sha256Hex(bytes);
    const file = `blobs/${sha256}.${mediaType === "text/csv" ? "csv" : "json"}`;
    this.#blobs.set(file, Uint8Array.from(bytes));
    this.#observe({
      afterAction,
      kind: "state",
      label,
      mediaType,
      sha256,
      bytes: bytes.length,
      file,
    });
    return this.#observations.some((o) => o.kind === "state" && o.sha256 === sha256);
  }

  uiStatus(text: string, afterAction: number | null = this.lastAction): void {
    this.#observe({
      afterAction,
      kind: "ui-status",
      text: redactText(text, this.#host).slice(0, 200),
    });
  }

  snapshot(): RecordedAttempt {
    return {
      actions: { capture: "recorded", truncated: this.#truncated, items: [...this.#actions] },
      observations: {
        capture: "recorded",
        withheld: this.#withheld,
        items: [...this.#observations],
      },
      blobs: new Map(this.#blobs),
    };
  }
}
