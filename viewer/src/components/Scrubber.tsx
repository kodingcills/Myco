import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import tokens from "../../../docs/design/tokens.json";
import { type Marker, markerTypes, type StepRow, stepLabel } from "../data/steps.ts";
import {
  brushSpan,
  clamp,
  filmstripIndices,
  fitSpan,
  fromX,
  lowerBound,
  nearestStep,
  type Span,
  timelinePositions,
  toX,
  zoomSpan,
} from "../data/timeline.ts";
import { useViewer } from "../store.ts";
import { useScreenshot } from "./Screenshots.tsx";
import { Missing } from "./SourceRef.tsx";

const { ruler, filmstrip, marker, brush, markerWidth, markerHeight, playheadCap } =
  tokens.layout.scrubberLanes;
const brushTop = ruler + filmstrip + marker;
const { color, layout, border, font } = tokens;
const height = layout.scrubber;
const thumbWidth = layout.filmstripThumb.width;
const markColor: Record<Marker, string> = {
  failed: color.verdict.failed.fg,
  recovered: color.verdict.recovered.fg,
  unknown: color.verdict.unknown.fg,
  fault: color.text.secondary,
};

function canvasContext(canvas: HTMLCanvasElement | null, width: number, scale: number) {
  if (!canvas || !width) return;
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const context = canvas.getContext("2d");
  context?.setTransform(scale, 0, 0, scale, 0, 0);
  context?.clearRect(0, 0, width, height);
  return context ?? undefined;
}

function Thumbnail({ row, x, label }: { row: StepRow; x: number; label: string }) {
  const url = useScreenshot(row.screenshot?.value);
  return (
    <div data-film-thumb style={{ transform: `translateX(${x}px)` }} title={label}>
      {url ? <img src={url} alt={`Screenshot for ${label}`} /> : <Missing />}
    </div>
  );
}

interface Drag {
  left: number;
  mode: "seek" | "brush" | "pan" | "start" | "end";
  anchor: number;
  initial: Span;
}

export function Scrubber({
  rows,
  index,
  digits,
}: {
  rows: StepRow[];
  index: Map<number, number>;
  digits: number;
}) {
  const selected = useViewer((state) => state.selection.step);
  const root = useRef<HTMLElement>(null);
  const rulerCanvas = useRef<HTMLCanvasElement>(null);
  const playheadCanvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, scale: 1, left: 0 });
  const { width, scale } = size;
  const drag = useRef<Drag>(null);
  const [hover, setHover] = useState<number>();
  const [range, setRange] = useState<Span>();
  const frame = useRef<number>(undefined);
  const queued = useRef<{ eventX: number; drag: Drag }>(undefined);

  const { timed, positions } = useMemo(() => timelinePositions(rows), [rows]);
  const start = positions[0] ?? 0;
  const end = positions.at(-1) ?? start;
  const domain = useMemo<Span>(() => [start, end], [start, end]);
  const span = range ? fitSpan(range[0], range[1] - range[0], domain) : domain;
  const [from, to] = span;
  const minimum = rows.length > 1 ? (end - start) / (rows.length - 1) : 0;
  const selectedIndex = selected === undefined ? undefined : index.get(selected);
  const position = selectedIndex === undefined ? undefined : positions[selectedIndex];
  const marks = useMemo(
    () =>
      markerTypes.map((type) => ({
        type,
        positions: positions.filter((_, i) => rows[i]!.markers.includes(type)),
      })),
    [positions, rows],
  );
  const thumbs = useMemo(
    () => filmstripIndices(positions, [from, to], width, thumbWidth),
    [positions, from, to, width],
  );

  useLayoutEffect(() => {
    const node = root.current;
    if (!node) return;
    const update = () => {
      const { width, left } = node.getBoundingClientRect();
      setSize({ width, left, scale: devicePixelRatio || 1 });
    };
    const observer = new ResizeObserver(update);
    observer.observe(node);
    const workspace = node.closest("[data-workspace]");
    if (workspace?.firstElementChild) observer.observe(workspace.firstElementChild);
    window.addEventListener("resize", update);
    update();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  // Reveal new selections without undoing an explicit brush or zoom.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Range changes must not recenter the selected step.
  useLayoutEffect(() => {
    if (position === undefined || (position >= from && position <= to)) return;
    setRange(fitSpan(position - (to - from) / 2, to - from, domain));
  }, [position, domain]);

  useLayoutEffect(() => {
    const context = canvasContext(rulerCanvas.current, width, scale);
    if (!context || !positions.length) return;
    const visible: Span = [from, to];
    context.font = `${font.size.dataSmall.size}px ${font.family.mono}`;
    context.textBaseline = "top";
    context.fillStyle = color.text.tertiary;
    const labelWidth =
      context.measureText(timed ? "0000.00s" : `#${"0".repeat(digits)}`).width + tokens.space["2"];
    const ticks = Math.max(1, Math.floor(width / labelWidth));
    const decimals = to - from < 10 ? 2 : 0;
    for (let i = 0; i <= ticks; i++) {
      const x = (i * width) / ticks;
      const value = fromX(x, visible, width);
      const row = rows[nearestStep(positions, value)];
      if (!row) continue;
      const label = timed ? `${value.toFixed(decimals)}s` : stepLabel(row.step, digits);
      if (x + labelWidth <= width) context.fillText(label, x + tokens.space["1"], 0);
      context.fillRect(x, ruler - tokens.space["1"], border.width, tokens.space["1"]);
    }
    context.fillStyle = color.border.subtle;
    context.fillRect(0, ruler + filmstrip, width, border.width);
    context.fillRect(0, brushTop, width, border.width);
    const brushX = toX(from, domain, width);
    const brushWidth = toX(to, domain, width) - brushX;
    context.fillStyle = color.bg.surface3;
    context.fillRect(brushX, brushTop, Math.max(brushWidth, border.width), brush);
    context.fillStyle = color.border.strong;
    context.fillRect(clamp(brushX, 0, width - markerWidth), brushTop, markerWidth, brush);
    context.fillRect(
      clamp(brushX + brushWidth - markerWidth, 0, width - markerWidth),
      brushTop,
      markerWidth,
      brush,
    );
    function drawMarks(positions: number[], window: Span, y: number) {
      let i = lowerBound(positions, window[0]);
      const stride = ((window[1] - window[0]) * markerWidth) / width;
      while (i < positions.length && positions[i]! <= window[1]) {
        const point = positions[i]!;
        const x = clamp(toX(point, window, width), 0, width - markerWidth);
        context?.fillRect(x, y, markerWidth, markerHeight);
        i = Math.max(i + 1, lowerBound(positions, point + stride));
      }
    }
    // Draw higher-priority marks last where dense markers overlap.
    for (const { type, positions } of marks.toReversed()) {
      context.fillStyle = markColor[type];
      drawMarks(positions, visible, brushTop - markerHeight - tokens.space["0.5"]);
      drawMarks(positions, domain, brushTop + (brush - markerHeight) / 2);
    }
  }, [width, scale, from, to, marks, positions, domain, timed, rows, digits]);

  useLayoutEffect(() => {
    const context = canvasContext(playheadCanvas.current, width, scale);
    if (!context) return;
    if (hover !== undefined) {
      context.fillStyle = color.border.strong;
      context.fillRect(hover, 0, border.width, brushTop);
      const at = fromX(hover, [from, to], width);
      const row = rows[nearestStep(positions, at)];
      if (row) {
        const label = timed ? `${at.toFixed(2)}s` : stepLabel(row.step, digits);
        const pad = tokens.space["1"];
        context.font = `${font.size.dataSmall.size}px ${font.family.mono}`;
        const box = context.measureText(label).width + pad * 2;
        const x = clamp(hover + pad, 0, Math.max(0, width - box));
        context.fillStyle = color.bg.surface3;
        context.fillRect(x, ruler, box, font.size.dataSmall.lineHeight);
        context.fillStyle = color.text.primary;
        context.textBaseline = "top";
        context.fillText(label, x + pad, ruler);
      }
    }
    if (position === undefined || position < from || position > to) return;
    const x = clamp(toX(position, [from, to], width), 0, width - border.width);
    context.fillStyle = color.text.primary;
    context.fillRect(x, 0, border.width, brushTop);
    context.fillRect(
      clamp(toX(position, domain, width), 0, width - border.width),
      brushTop,
      border.width,
      brush,
    );
    context.beginPath();
    context.moveTo(x - playheadCap / 2, 0);
    context.lineTo(x + playheadCap / 2, 0);
    context.lineTo(x, playheadCap);
    context.fill();
  }, [width, scale, hover, from, to, position, domain, rows, positions, timed, digits]);

  useEffect(() => {
    const node = root.current;
    function wheel(event: WheelEvent) {
      if (!width || start === end) return;
      event.preventDefault();
      const visible: Span = [from, to];
      const at = fromX(event.clientX - size.left, visible, width);
      setRange(zoomSpan(visible, domain, at, event.deltaY > 0 ? 1.25 : 0.8, minimum));
    }
    node?.addEventListener("wheel", wheel, { passive: false });
    return () => node?.removeEventListener("wheel", wheel);
  }, [width, size.left, start, end, from, to, domain, minimum]);

  useEffect(
    () => () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    },
    [],
  );

  function seek(i: number) {
    const row = rows[i];
    if (row) useViewer.getState().selectStep(row.step);
  }

  function move(eventX: number, drag: Drag) {
    const x = eventX - drag.left;
    if (drag.mode === "seek") {
      seek(nearestStep(positions, fromX(x, span, width)));
      return;
    }
    const at = fromX(x, domain, width);
    const [a, b] = drag.initial;
    const next =
      drag.mode === "pan"
        ? fitSpan(a + at - drag.anchor, b - a, domain)
        : drag.mode === "start"
          ? brushSpan(Math.min(at, b - minimum), b, domain, minimum)
          : drag.mode === "end"
            ? brushSpan(a, Math.max(at, a + minimum), domain, minimum)
            : brushSpan(at, drag.anchor, domain, minimum);
    setRange(next);
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>, onBrush = false) {
    if (!rows.length || event.button !== 0 || !root.current) return;
    const left = root.current.getBoundingClientRect().left;
    const x = event.clientX - left;
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = fromX(x, domain, width);
    const leftEdge = toX(from, domain, width);
    const rightEdge = toX(to, domain, width);
    const hit = layout.controlHeight / 2;
    const mode = !onBrush
      ? "seek"
      : event.shiftKey
        ? "brush"
        : Math.abs(x - leftEdge) <= hit && Math.abs(x - leftEdge) <= Math.abs(x - rightEdge)
          ? "start"
          : Math.abs(x - rightEdge) <= hit
            ? "end"
            : x > leftEdge && x < rightEdge && (from !== start || to !== end)
              ? "pan"
              : "brush";
    drag.current = { left, mode, anchor: at, initial: span };
    if (mode === "seek") move(event.clientX, drag.current);
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!drag.current) {
      setHover(clamp(event.clientX - size.left, 0, width));
      return;
    }
    const active = drag.current;
    if (active.mode === "seek") {
      // Chromium coalesces pointermove to the render loop. Commit the playhead and selection
      // in that turn so the extra app-side frame used by brush updates cannot delay a seek.
      flushSync(() => move(event.clientX, active));
      return;
    }
    queued.current = { eventX: event.clientX, drag: active };
    frame.current ??= requestAnimationFrame(() => {
      frame.current = undefined;
      const next = queued.current;
      if (next) move(next.eventX, next.drag);
    });
  }

  function pointerEnd(event: PointerEvent<HTMLDivElement>) {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined;
    queued.current = undefined;
    if (event.type === "pointerup" && drag.current) move(event.clientX, drag.current);
    drag.current = null;
  }

  function keys(event: KeyboardEvent<HTMLDivElement>, onBrush = false) {
    if (!rows.length || event.metaKey || event.ctrlKey || event.altKey) return;
    const { key, shiftKey } = event;
    if (key === "+" || key === "=" || key === "-") {
      setRange(
        zoomSpan(span, domain, position ?? (from + to) / 2, key === "-" ? 1.25 : 0.8, minimum),
      );
    } else if (key === "ArrowLeft" || key === "ArrowRight") {
      const delta = (key === "ArrowLeft" ? -1 : 1) * (shiftKey ? 10 : 1);
      if (onBrush) setRange(fitSpan(from + delta * minimum, to - from, domain));
      else
        seek(clamp((selectedIndex ?? (delta > 0 ? -1 : rows.length)) + delta, 0, rows.length - 1));
    } else if (key === "Home" || key === "End") {
      if (onBrush) setRange(fitSpan(key === "Home" ? start : end, to - from, domain));
      else seek(key === "Home" ? 0 : rows.length - 1);
    } else return;
    event.preventDefault();
  }

  const current = selectedIndex ?? 0;
  return (
    <section ref={root} data-scrubber data-region="scrubber" aria-label="Scrubber">
      <canvas ref={rulerCanvas} aria-hidden="true" tabIndex={-1} />
      <div data-filmstrip aria-hidden="true">
        {thumbs.map((i) => (
          <Thumbnail
            key={rows[i]!.step}
            row={rows[i]!}
            x={toX(positions[i]!, span, width) - thumbWidth / 2}
            label={stepLabel(rows[i]!.step, digits)}
          />
        ))}
      </div>
      <canvas ref={playheadCanvas} aria-hidden="true" tabIndex={-1} />
      <div
        data-scrub-seek
        role="slider"
        tabIndex={rows.length ? 0 : -1}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, rows.length - 1)}
        aria-valuenow={current}
        aria-valuetext={selected === undefined ? "No step selected" : stepLabel(selected, digits)}
        onKeyDown={(event) => keys(event)}
        onPointerDown={(event) => pointerDown(event)}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
        onPointerLeave={() => setHover(undefined)}
      />
      <div
        data-scrub-brush
        role="slider"
        tabIndex={rows.length > 1 ? 0 : -1}
        aria-label="Timeline range"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, rows.length - 1)}
        aria-valuenow={Math.max(0, nearestStep(positions, from))}
        aria-valuetext={
          rows.length
            ? stepLabel(rows[nearestStep(positions, from)]!.step, digits) +
              " to " +
              stepLabel(rows[nearestStep(positions, to)]!.step, digits)
            : "No steps"
        }
        onKeyDown={(event) => keys(event, true)}
        onPointerDown={(event) => pointerDown(event, true)}
        onPointerMove={pointerMove}
        onPointerUp={pointerEnd}
        onPointerCancel={pointerEnd}
        onLostPointerCapture={pointerEnd}
        onPointerLeave={() => setHover(undefined)}
      />
    </section>
  );
}
