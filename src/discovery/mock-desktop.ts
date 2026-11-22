/**
 * A contract double for the Direction A live runner (N8).
 *
 * It models the observable behaviour of `myco-todo`, including the seeded bug:
 * items whose text starts with `BUG` (case-insensitive) appear in the list and
 * are dropped at save, while the status line still says "saved N item(s)".
 *
 * This is a test double, not evidence. It exists so the orchestration, the
 * evidence writer, and the false-success accounting can be exercised without a
 * guest; the live transport is the runtime's MCP server.
 */
import type {
  ActionOutcome,
  DesktopAction,
  DesktopObservation,
  DesktopSession,
  DesktopTransport,
} from "./live-runner.ts";

type Focus = "entry" | "add" | "list" | "save";

export interface MockDesktopOptions {
  /** Fail the Nth action (1-based) with `failed`, to exercise the uncertain path. */
  readonly failAtAction?: number;
  /** Throw instead of returning `failed`, to exercise the transport-error path. */
  readonly throwAtAction?: number;
}

export class MockDesktop implements DesktopTransport {
  private entry = "";
  private rows: string[] = [];
  private persistedRows: string[] = [];
  private status = "";
  private focus: Focus = "entry";
  private version = 0;
  private actions = 0;
  private created = 0;
  private destroyed = 0;
  private readonly options: MockDesktopOptions;

  constructor(options: MockDesktopOptions = {}) {
    this.options = options;
  }

  get createCount(): number {
    return this.created;
  }

  get destroyCount(): number {
    return this.destroyed;
  }

  async create(): Promise<DesktopSession> {
    this.created += 1;
    return { id: `mock-${this.created}` };
  }

  async observe(): Promise<DesktopObservation> {
    return {
      stateVersion: this.version,
      entryText: this.entry,
      listRows: [...this.rows],
      statusText: this.status,
    };
  }

  async act(_session: DesktopSession, action: DesktopAction): Promise<ActionOutcome> {
    this.actions += 1;
    if (this.options.throwAtAction === this.actions) throw new Error("mock transport dropped");
    if (this.options.failAtAction === this.actions) return "failed";
    switch (action.kind) {
      case "launch":
        this.version += 1;
        return "delivered_verified";
      case "typeText":
        this.entry += action.text;
        this.version += 1;
        return "delivered_verified";
      case "keyPress":
        return this.press(action.keys);
    }
  }

  async readFile(_session: DesktopSession, _path: string): Promise<string> {
    return JSON.stringify({ items: this.persistedRows.map((text) => ({ text })) });
  }

  async reset(): Promise<void> {
    this.entry = "";
    this.rows = [];
    this.persistedRows = [];
    this.status = "";
    this.focus = "entry";
    this.version += 1;
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }

  private press(keys: string): ActionOutcome {
    if (keys === "Return") {
      if (this.focus === "entry") {
        if (this.entry.trim().length > 0) {
          this.rows.push(this.entry);
          this.entry = "";
          this.status = `added: ${this.rows[this.rows.length - 1]}`;
        }
      } else if (this.focus === "save") {
        this.save();
      }
      this.version += 1;
      return "delivered_verified";
    }
    if (keys === "Tab") {
      this.focus =
        this.focus === "entry"
          ? "add"
          : this.focus === "add"
            ? "list"
            : this.focus === "list"
              ? "save"
              : "entry";
      this.version += 1;
      return "delivered_verified";
    }
    return "failed";
  }

  private save(): void {
    // SEEDED BUG: BUG-prefixed items are dropped at save, and the status line
    // still reports the on-screen count, exactly like the real app.
    this.persistedRows = this.rows.filter((text) => !text.trim().toUpperCase().startsWith("BUG"));
    this.status = `saved ${this.rows.length} item(s)`;
  }
}
