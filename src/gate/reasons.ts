/**
 * Agent-facing reason hygiene (TIF-265 follow-up 2).
 *
 * Every string in `GateResult.reasons` reaches the agent (MCP tool result, CLI JSON). A
 * raw error message can carry an absolute host path (Node's fs errors embed the path; an
 * audit-log write failure names the log file) or other operator-side text, so reasons
 * carry only a short, stable code for an error, never its message. The full error goes to
 * the operator through `GateConfig.onDiagnostic` (the CLI writes it to stderr).
 */

/** An errno-style code: upper case, digits and underscores (ENOENT, ERR_FS_FILE_TOO_LARGE). */
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
/** An error class name (TypeError, StateCorruptError). */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * A path-free code for `error`: its errno-style `code` when it has one, else its class
 * `name`, else "error". The message is never used. Anything that does not match the
 * strict code or name alphabet (a custom `code` holding a path, a `name` with spaces or
 * slashes) is ignored, and a throwing getter yields "error", so this never throws.
 */
export function errorCode(error: unknown): string {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) {
    return "error";
  }
  // Each property is read on its own: a throwing getter (or Proxy trap) on one does not
  // hide a usable value on the other.
  try {
    const { code } = error as { code?: unknown };
    if (typeof code === "string" && CODE.test(code)) return code;
  } catch {
    // A throwing getter: try the name.
  }
  try {
    const { name } = error as { name?: unknown };
    if (typeof name === "string" && NAME.test(name)) return name;
  } catch {
    // A throwing getter: fall through.
  }
  return "error";
}
