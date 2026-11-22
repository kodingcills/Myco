import { Check, CircleHelp, Undo2, X } from "lucide-react";
import type { DisplayVerdict } from "../data/verdict.ts";

const glyphs = {
  Verified: [Check, "check"],
  Recovered: [Undo2, "undo-2"],
  Failed: [X, "x"],
  Unknown: [CircleHelp, "circle-help"],
} as const;

type Label = keyof typeof glyphs;

export function VerdictBadge({
  label,
  subtype,
  size = "md",
}: {
  label: Label;
  subtype?: DisplayVerdict["subtype"];
  size?: "xl" | "md" | "sm";
}) {
  const [Icon, glyph] = glyphs[label];
  const description = subtype ? `${label} · ${subtype}` : label;
  return (
    <span
      data-verdict={label}
      data-badge={size}
      {...(size === "sm" ? { role: "img", "aria-label": description, title: description } : {})}
    >
      <Icon aria-hidden="true" data-glyph={glyph} />
      {size !== "sm" && (
        <span className={size === "xl" ? "type-verdict" : "type-body-strong"}>{label}</span>
      )}
      {size !== "sm" && subtype && <span className="type-small">· {subtype}</span>}
    </span>
  );
}
