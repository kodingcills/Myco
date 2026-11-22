/** Small-sample statistics. Nothing here may be presented as a reliability claim below 30 trials. */

export interface Wilson {
  k: number;
  n: number;
  point: number;
  low: number;
  high: number;
}

/** Wilson score interval, 95% (z = 1.96). Returns NaN bounds when n is 0. */
export function wilson(k: number, n: number, z = 1.96): Wilson {
  if (n <= 0) return { k, n, point: Number.NaN, low: Number.NaN, high: Number.NaN };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, point: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

export function formatWilson(w: Wilson): string {
  if (w.n === 0) return "n/a (N=0)";
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  return `${w.k}/${w.n} (${pct(w.point)}, Wilson 95% ${pct(w.low)}–${pct(w.high)})`;
}

/** Fixed sentence used wherever a rate appears. */
export function underpoweredNote(n: number): string {
  return n < 30
    ? `N=${n} is underpowered: this is a descriptive count, not a reliability estimate (docs/foundry/contract.md §7a requires ~30+ trials to report a rate).`
    : `N=${n}: still descriptive on a hosted environment; not decision-eligible.`;
}

export interface LatencySummary {
  n: number;
  minMs: number;
  medianMs: number;
  p90Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Linear-interpolated percentile on a sorted copy. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

export function latencySummary(values: readonly number[]): LatencySummary {
  if (values.length === 0) {
    return { n: 0, minMs: NaN, medianMs: NaN, p90Ms: NaN, maxMs: NaN, meanMs: NaN };
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    n: values.length,
    minMs: Math.min(...values),
    medianMs: percentile(values, 0.5),
    p90Ms: percentile(values, 0.9),
    maxMs: Math.max(...values),
    meanMs: sum / values.length,
  };
}
