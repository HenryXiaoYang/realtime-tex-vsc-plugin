// Mapping between source byte offsets and preview positions through rtex spans and placements.
// Pure module.
import type { Fragment, Span } from './protocol';

/** The span containing byte `b` (the last span starting at or before `b`). */
export function spanAt(spans: readonly Span[], b: number): Span | undefined {
  let best: Span | undefined;
  for (const s of spans) {
    if (s.range.start <= b && (best === undefined || s.range.start >= best.range.start)) best = s;
  }
  return best;
}

export interface PreviewTarget {
  page: number;
  /** Baseline of the target row, sp from the page top. */
  y: number;
  x: number;
}

function rowCount(frags: readonly Fragment[]): number {
  return frags.reduce((n, f) => n + f.baselines.length, 0);
}

/** The row `fraction` (0..1) of the way through a unit placed at `frags`. */
export function targetInFragments(frags: readonly Fragment[], fraction: number): PreviewTarget | undefined {
  const n = rowCount(frags);
  if (n === 0) return undefined;
  let k = Math.min(n - 1, Math.max(0, Math.floor(fraction * n)));
  for (const f of frags) {
    if (k < f.baselines.length) return { page: f.page, y: f.baselines[k], x: f.xs[k] ?? f.x };
    k -= f.baselines.length;
  }
  return undefined;
}

export interface Hit {
  parId: number;
  /** Position of the hit row within the unit, 0..1. */
  fraction: number;
}

/** The unit row nearest to (page, y) among `placed` units (rows within `maxDist` sp). */
export function hitTest(
  placed: ReadonlyMap<number, readonly Fragment[]>,
  page: number,
  y: number,
  maxDist = 40 * 65536,
): Hit | undefined {
  let best: { parId: number; row: number; rows: number; dist: number } | undefined;
  for (const [parId, frags] of placed) {
    const rows = rowCount(frags);
    let row = 0;
    for (const f of frags) {
      for (let i = 0; i < f.baselines.length; i++, row++) {
        if (f.page !== page) continue;
        // a row's ink is mostly above its baseline: measure from 0.3 em above it
        const dist = Math.abs(y - (f.baselines[i] - 3 * 65536));
        if (dist <= maxDist && (best === undefined || dist < best.dist)) best = { parId, row, rows, dist };
      }
    }
  }
  if (!best) return undefined;
  return { parId: best.parId, fraction: best.rows > 1 ? best.row / best.rows : 0 };
}
