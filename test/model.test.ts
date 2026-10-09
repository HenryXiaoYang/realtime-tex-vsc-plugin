import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, Fragment, Line, PageUpdate } from '../src/protocol';
import { cachedPicture, cachedPictureMoves, PreviewModel, reanchor } from '../webview/model';
import { hitTest, spanAt, targetInFragments } from '../src/sourceMap';

// coordinates in points, stored in sp
const U = 65536;
const line = (x: number, y: number, extra: Partial<Line> = {}): Line => ({ x: x * U, y: y * U, w: 100 * U, h: 7 * U, d: 2 * U, items: [], ...extra });
const dl = (lines: Line[], kind = 'page'): DisplayList => ({ kind, fonts: {}, lines, other: [], flags: [], width: 0, height: 0, depth: 0, page_width: 600, page_height: 800 });
const page = (n: number, lines: Line[]): PageUpdate => ({ page: n, exact: true, hash: n, dl: dl(lines) });
const frag = (page: number, xs: number[], baselines: number[], first = 1): Fragment => ({
  page,
  first_line: first,
  last_line: first + baselines.length - 1,
  x: xs[0] * U,
  xs: xs.map((v) => v * U),
  baselines: baselines.map((v) => v * U),
  approximate: false,
});

function setup() {
  const m = new PreviewModel();
  m.applyLayout({
    pages: [page(1, [line(10, 100), line(10, 112), line(10, 124)]), page(2, [line(10, 100), line(10, 112)])],
    pagesTotal: 2,
    placements: [
      { par_id: 5, fragments: [frag(1, [10, 10], [112, 124]), frag(2, [10], [100])], lines: 3, kind: 'par' },
      { par_id: 6, fragments: [frag(1, [10], [100])], lines: 1, kind: 'heading:section' },
    ],
    keepFromRevision: null,
  });
  return m;
}

test('a fast update hides the unit rows and places its own rows', () => {
  const m = setup();
  const fast = dl([line(0, 7), line(0, 19), line(0, 31), line(0, 43)], 'paragraph');
  const dirty = m.applyParagraph(5, fast, [frag(1, [10, 10], [112, 124]), frag(2, [10, 10], [100, 112], 3)], 3);
  assert.deepEqual([...dirty].sort(), [1, 2]);
  assert.deepEqual([...m.hiddenLines(1)].sort(), [1, 2]);
  assert.deepEqual([...m.hiddenLines(2)], [0]);
  const rows = m.overlaysOn(2)[0].rows;
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].dx, rows[0].dy], [10 * U, (100 - 31) * U]);
});

test('a converged layout drops overlays; a stale one keeps newer ones, re-anchored', () => {
  const m = setup();
  m.applyParagraph(5, dl([line(0, 7)], 'paragraph'), [frag(1, [10], [112])], 3);
  m.applyParagraph(6, dl([line(0, 9)], 'paragraph'), [frag(1, [10], [100])], 5);
  m.applyLayout({ pages: [], pagesTotal: 2, placements: [{ par_id: 6, fragments: [frag(2, [20], [300])], lines: 1, kind: 'par' }], keepFromRevision: 4 });
  assert.deepEqual([...m.overlays.keys()], [6]);
  assert.deepEqual(m.overlays.get(6)!.fragments[0].baselines, [300 * U]);
  m.applyLayout({ pages: [], pagesTotal: 1, placements: [], keepFromRevision: null });
  assert.equal(m.overlays.size, 0);
  assert.equal(m.pages.size, 1);
});

test('reanchor extends rows past the placement on its last page', () => {
  const rows = [line(0, 10), line(0, 22), line(0, 34)];
  const f = reanchor([frag(3, [50, 50], [200, 212])], rows);
  assert.equal(f.length, 1);
  assert.deepEqual(f[0].baselines, [200 * U, 212 * U, 224 * U]);
  assert.equal(f[0].approximate, true);
});

test('source map lookups', () => {
  const spans = [
    { id: 1, range: { start: 0, end: 50 }, kind: 'Preamble' as const, hash: 0, last_revision: 0 },
    { id: 2, range: { start: 50, end: 90 }, kind: 'Body' as const, hash: 0, last_revision: 0 },
  ];
  assert.equal(spanAt(spans, 10)?.id, 1);
  assert.equal(spanAt(spans, 60)?.id, 2);
  const frags = [frag(1, [10, 10], [100, 112]), frag(2, [10], [50])];
  assert.deepEqual(targetInFragments(frags, 0), { page: 1, y: 100 * U, x: 10 * U });
  assert.deepEqual(targetInFragments(frags, 0.99), { page: 2, y: 50 * U, x: 10 * U });
  const placed = new Map([[7, frags]]);
  const hit = hitTest(placed, 1, 110 * U);
  assert.equal(hit?.fraction, 1 / 3);
  assert.equal(hit?.parId, 7);
  assert.equal(hitTest(placed, 3, 0), undefined);
});

test('a removed span hides its rows and draws nothing', () => {
  const m = setup();
  const empty = dl([], '');
  m.applyParagraph(5, empty, [], 4);
  assert.deepEqual([...m.hiddenLines(1)].sort(), [1, 2]);
  assert.deepEqual([...m.hiddenLines(2)], [0]);
  assert.equal(m.overlaysOn(1).length, 0);
});

test('cached pictures in a live unit move with their row', () => {
  assert.deepEqual(cachedPicture(['u', 'cached_picture', '3 100 200 300 400']), { index: 3, x: 100, y: 200, w: 300, h: 400 });
  assert.equal(cachedPicture(['u', 'pdf_literal', 'x']), undefined);
  assert.equal(cachedPicture(['g', 1, 65, 3, 0, 0, 0, 0]), undefined);
  // page: the picture at (10, 50) pt, 80 × 30 pt; another picture elsewhere of a different size
  const page = dl([
    line(10, 80, { items: [['u', 'cached_picture', `7 ${10 * U} ${50 * U} ${80 * U} ${30 * U}`]] }),
    line(10, 300, { items: [['u', 'cached_picture', `8 ${10 * U} ${270 * U} ${40 * U} ${20 * U}`]] }),
  ]);
  // live unit: the same picture in the unit's frame, its row moved 12 pt down by a longer sentence
  const unitLine = line(0, 30, { items: [['u', 'cached_picture', `7 0 0 ${80 * U} ${30 * U}`]] });
  const moves = cachedPictureMoves(page, [{ line: unitLine, dx: 10 * U, dy: 62 * U }]);
  assert.deepEqual(moves, [{ src: { x: 10 * U, y: 50 * U, w: 80 * U, h: 30 * U }, dst: { x: 10 * U, y: 62 * U, w: 80 * U, h: 30 * U } }]);
  // no counterpart of that size on the page: nothing to carry
  const other = line(0, 30, { items: [['u', 'cached_picture', `9 0 0 ${5 * U} ${5 * U}`]] });
  assert.deepEqual(cachedPictureMoves(page, [{ line: other, dx: 0, dy: 0 }]), []);
});
