import { expect, test } from "vitest";
import {
  brushSpan,
  filmstripIndices,
  fitSpan,
  fromX,
  nearestStep,
  toX,
  zoomSpan,
} from "../src/data/timeline.ts";

test("coordinates round-trip across an irregular timeline and snap to the nearest step", () => {
  const positions = [2, 5, 11, 42];
  const span = [2, 42] as const;
  for (const [index, position] of positions.entries()) {
    expect(nearestStep(positions, fromX(toX(position, span, 500), span, 500))).toBe(index);
  }
  expect(fromX(-20, span, 500)).toBe(2);
  expect(fromX(600, span, 500)).toBe(42);
  expect(nearestStep(positions, 9)).toBe(2);
  expect(toX(2, [2, 2], 500)).toBe(250);
  expect(nearestStep([], 9)).toBe(-1);
});

test("cursor-anchored zoom and a reversed brush produce bounded ranges", () => {
  expect(zoomSpan([20, 60], [0, 100], 30, 0.5, 1)).toEqual([25, 45]);
  expect(zoomSpan([20, 60], [0, 100], 30, 10, 1)).toEqual([0, 100]);
  expect(brushSpan(70, 40, [0, 100], 1)).toEqual([40, 70]);
  expect(brushSpan(100, 100, [0, 100], 2)).toEqual([98, 100]);
  expect(fitSpan(-10, 30, [0, 100])).toEqual([0, 30]);
});

test("filmstrip picks a bounded window at zoom and caps its DOM slots", () => {
  const positions = Array.from({ length: 10_000 }, (_, index) => index);
  expect(filmstripIndices(positions, [100, 200], 960, 96)).toEqual([
    100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200,
  ]);
  expect(filmstripIndices(positions, [0, 9999], 4000, 96)).toHaveLength(20);
});
