import type { StepRow } from "./steps.ts";

export type Span = readonly [start: number, end: number];
export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function lowerBound(values: readonly number[], value: number) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (values[middle]! < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function toX(position: number, [start, end]: Span, width: number) {
  return end > start ? ((position - start) * width) / (end - start) : width / 2;
}

export function fromX(x: number, [start, end]: Span, width: number) {
  return start + clamp(width ? x / width : 0, 0, 1) * (end - start);
}

export function nearestStep(positions: readonly number[], value: number) {
  if (!positions.length) return -1;
  const right = Math.min(lowerBound(positions, value), positions.length - 1);
  const left = Math.max(right - 1, 0);
  return value - positions[left]! <= positions[right]! - value ? left : right;
}

export function fitSpan(start: number, length: number, domain: Span) {
  length = clamp(length, 0, domain[1] - domain[0]);
  start = clamp(start, domain[0], domain[1] - length);
  return [start, start + length] as const;
}

export function brushSpan(a: number, b: number, domain: Span, minLength: number) {
  return fitSpan(Math.min(a, b), Math.max(Math.abs(b - a), minLength), domain);
}

export function zoomSpan(span: Span, domain: Span, at: number, factor: number, minLength: number) {
  const length = span[1] - span[0];
  const nextLength = clamp(length * factor, minLength, domain[1] - domain[0]);
  const fraction = length ? clamp((at - span[0]) / length, 0, 1) : 0;
  return fitSpan(at - nextLength * fraction, nextLength, domain);
}

export function timelinePositions(rows: StepRow[]) {
  const times = rows.map(({ offset }) => offset ?? NaN);
  const timed =
    times.length > 1 &&
    times.every((time, index) => Number.isFinite(time) && (!index || time > times[index - 1]!));
  return { timed, positions: timed ? times : rows.map((_, index) => index) };
}

export function filmstripIndices(
  positions: number[],
  span: Span,
  width: number,
  thumbWidth: number,
) {
  if (!positions.length || !width) return [];
  const first = lowerBound(positions, span[0]);
  const last = lowerBound(positions, span[1]);
  if (first > last || first === positions.length || positions[first]! > span[1]) return [];
  const indices = [];
  let index = first;
  for (
    let slot = 0;
    slot < 20 && index <= last && positions[index] !== undefined && positions[index]! <= span[1];
    slot++
  ) {
    indices.push(index);
    const next = positions[index]! + ((span[1] - span[0]) * thumbWidth) / width;
    index = Math.max(index + 1, lowerBound(positions, next));
  }
  return indices;
}
