/**
 * Thrown by a family's `decide` when the persisted bytes do not parse as the family's format.
 * The message reaches the agent ("could not look: <message>"), so it must not carry a host
 * path or a raw error message; put the underlying error in `cause`, which the gate hands
 * to the operator only (`GateConfig.onDiagnostic`).
 *
 * Lives in its own module so a family module can throw it without importing `families.ts`
 * (which imports every family): no import cycle. `families.ts` re-exports it.
 */
export class StateCorruptError extends Error {
  override readonly name = "StateCorruptError";
}
