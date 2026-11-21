import { FileJson } from "lucide-react";
import type { SourceRef } from "../data/types.ts";
import { useViewer } from "../store.ts";

export function sourceLabel(source: SourceRef) {
  return "line" in source
    ? `${source.file}:${source.line}`
    : `${source.file}${source.path ? `#${source.path}` : ""}`;
}

export function SourceChip({
  source,
  compact = false,
  subject,
}: {
  source: SourceRef;
  compact?: boolean;
  /** Names what the source backs, so an icon-only chip never reads as an orphan control. */
  subject?: string;
}) {
  const inspect = useViewer((state) => state.inspect);
  const label = sourceLabel(source);
  const selected = useViewer(
    (state) =>
      state.inspectorOpen &&
      !!state.selection.source &&
      sourceLabel(state.selection.source) === label,
  );
  return (
    <button
      type="button"
      data-source
      aria-current={selected || undefined}
      data-compact={compact || undefined}
      title={subject ? `${subject} · ${label}` : label}
      aria-label={subject ? `Open source ${label} for ${subject}` : `Open source ${label}`}
      onClick={() => inspect(source)}
    >
      {compact ? <FileJson aria-hidden="true" /> : label}
    </button>
  );
}

export function Missing() {
  return <span className="text-text-tertiary">not recorded</span>;
}

export function formatValue(value: unknown) {
  return typeof value === "string" ? value : JSON.stringify(value);
}
