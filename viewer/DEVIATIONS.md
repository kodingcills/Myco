# Viewer Stage 2 decisions

- Now is omitted per §9. Why can be selected with its tab or `2` and shows a short unavailable state until Stage 3. Source chips open Raw in Proof, including trace references that will navigate to Why in Stage 3.
- Open opens a two-option picker menu. This gives `Mod+O` a keyboard path to both native picker types while preserving the single empty-state button.
- Stored sidebar references contain only names, run IDs, and open times. A reload requires choosing the local files again, and restores hash selection when the matching run is reopened.
- A fixed-height sidebar allows overflow scrolling when runs exceed the viewport so the entire ARIA tree remains reachable. The fixed Verdict Bar keeps its rule transition, while verdict words update immediately so provisional evidence never lingers during a fade.
- Input artifacts have a start time and event timestamps, but no terminal elapsed-duration field. The header shows the recorded start in the viewer's time zone. It does not label the last trace event as run completion.
- Before a trace finishes, absent trace counts read `not recorded` rather than zero. A witnessed absence in the persisted store reads `absent`; `not recorded` is reserved for missing evidence. The two were distinguishable in the Stage 1 data model.
