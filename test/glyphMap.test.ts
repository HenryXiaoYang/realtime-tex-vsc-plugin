import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, Line } from '../src/protocol';
import { clickedChar, glyphTextOf, sourceOffset, visibleSource } from '../src/glyphMap';
import { PreviewModel } from '../webview/model';
import { pdfWords } from '../webview/pdfText';

const PT = 65536;
const size = 10 * PT;
const dl = { kind: 'page', fonts: { '1': { id: 1, size } }, lines: [], other: [], flags: [] } as unknown as DisplayList;

/** A line of `text` at baseline y (pt); a space is a 3.3pt gap, every glyph 5pt wide. `codes`
 * overrides a character with a TFM slot (no glyph index). */
function line(text: string, y: number, codes: Record<string, number> = {}): Line {
  const items: Line['items'] = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') {
      x += 3.3 * PT;
      continue;
    }
    items.push(ch in codes ? ['g', 1, codes[ch], null, x, y * PT, 5 * PT, 0] : ['g', 1, ch.codePointAt(0)!, 1, x, y * PT, 5 * PT, 0]);
    x += 5 * PT;
  }
  return { x: 0, y: y * PT, w: x, h: 7 * PT, d: 2 * PT, items };
}

const rows = (...ls: Line[]) => ls.map((l) => ({ dl, line: l, dx: 0, dy: 0 }));

/** Source offset of the click on character `index` of the unit's glyph text. */
function offsetAt(src: string, ls: Line[], index: number, after = false): number | undefined {
  return sourceOffset(glyphTextOf(rows(...ls)), index, after, src);
}

test('visible source drops markup that prints nothing', () => {
  const v = visibleSource('Hello \\textbf{world} see~\\ref{sec:x} % note\nnext \\& \\cite[p.~2]{k} ``q\'\' a--b');
  assert.equal(v.text, 'Hello world see next & "q" a-b');
  // the dash is one character covering both hyphens of the source
  const dash = v.text.indexOf('-');
  assert.equal(v.end[dash] - v.start[dash], 2);
  assert.equal(visibleSource('\\multicolumn{2}{c}{Total} & 5 \\\\ \\hline').text, 'Total 5 ');
});

test('a click lands on the character in the source, across rows and markup', () => {
  const src = 'Hello \\textbf{world}\nsee  \\emph{next} line';
  const ls = [line('Hello world', 100), line('see next line', 112)];
  const gt = glyphTextOf(rows(...ls));
  assert.equal(gt.text, 'Hello world see next line');
  assert.equal(offsetAt(src, ls, gt.text.indexOf('w')), src.indexOf('world'));
  assert.equal(offsetAt(src, ls, gt.text.indexOf('d'), true), src.indexOf('world') + 5);
  assert.equal(offsetAt(src, ls, gt.text.indexOf('next') + 1), src.indexOf('next') + 1);
});

test('text a macro printed maps to just after the text before it', () => {
  const src = 'see Section~\\ref{sec:intro} for more';
  const ls = [line('see Section 3 for more', 100)];
  const gt = glyphTextOf(rows(...ls));
  assert.equal(offsetAt(src, ls, gt.text.indexOf('3')), src.indexOf('~\\ref'));
  assert.equal(offsetAt(src, ls, gt.text.indexOf('for')), src.indexOf('for'));
});

test('ligatures, curly quotes and dashes match their source spelling', () => {
  // TFM slots: 12 = fi, 92 = “, 34 = ”, 123 = –
  const src = "``fine''---a--b";
  const ls = [line('LFneR_a-b', 100, { L: 92, F: 12, R: 34, _: 22, '-': 123 })];
  const gt = glyphTextOf(rows(...ls));
  assert.equal(gt.text, '“fine”—a–b');
  // right half of the fi glyph is the i
  const g = gt.glyphs[1];
  const at = clickedAt(ls, g.x + g.adv * 0.6, 100 * PT);
  assert.deepEqual([at?.index, at?.after], [2, false]);
  assert.equal(offsetAt(src, ls, 2), src.indexOf('i'));
  assert.equal(offsetAt(src, ls, gt.text.indexOf('a')), src.indexOf('a'));
  assert.equal(offsetAt(src, ls, gt.text.indexOf('b')), src.indexOf('b'));
});

function clickedAt(ls: Line[], x: number, y: number) {
  const m = new PreviewModel();
  m.applyLayout({
    pages: [{ page: 1, exact: true, hash: 1, dl: { ...dl, lines: ls } }],
    pagesTotal: 1,
    placements: [{ par_id: 7, fragments: [{ page: 1, first_line: 1, last_line: ls.length, x: 0, xs: ls.map(() => 0), baselines: ls.map((l) => l.y), approximate: false }], lines: ls.length, kind: 'par' }],
    keepFromRevision: null,
  });
  return clickedChar(m, 1, x, y);
}

test('a click picks the row under it and the glyph under it', () => {
  const ls = [line('abc def', 100), line('ghi', 112)];
  const second = clickedAt(ls, 6 * PT, 111 * PT);
  assert.equal(second?.parId, 7);
  assert.equal(second?.gt.text[second.index], 'h');
  // past the end of a row: its last character, caret after it
  const end = clickedAt(ls, 80 * PT, 100 * PT);
  assert.deepEqual([end?.gt.text[end.index], end?.after], ['f', true]);
  // far from any text: no unit
  assert.equal(clickedAt(ls, 10 * PT, 400 * PT), undefined);
});

test('a long unit aligns a window around the click', () => {
  const words = Array.from({ length: 900 }, (_, i) => `w${i}`);
  const src = words.map((w, i) => (i % 10 === 0 ? `\\emph{${w}}` : w)).join(' ');
  const ls = [line(words.join(' '), 100)];
  const gt = glyphTextOf(rows(...ls));
  assert.ok(gt.text.length * visibleSource(src).text.length > 8_000_000);
  const k = gt.text.indexOf('w850');
  assert.equal(offsetAt(src, ls, k + 1), src.indexOf('w850') + 1);
});

test('in a table (one row, several baselines) a click picks the cell under it', () => {
  // a tabular is one display-list row: its lines are glyphs on other baselines
  const a = line('Apple banana', 100);
  const b = line('delta echo', 112);
  const table: Line = { ...a, d: 14 * PT, items: [...a.items, ...b.items] };
  const at = clickedAt([table], 34 * PT, 111 * PT);
  assert.equal(at?.gt.text, 'Apple banana delta echo');
  assert.equal(at?.gt.text[at.index], 'c');
  const src = 'Apple & banana \\\\\ndelta & echo';
  assert.equal(offsetAt(src, [table], at!.index), src.indexOf('echo') + 1);
});

test('a click on text only the PDF has (a TikZ label) matches the PDF text', () => {
  // the picture's row has no glyphs; the PDF has the label "y = x/2" at (40pt, 150pt)
  const picture: Line = { x: 0, y: 160 * PT, w: 200 * PT, h: 80 * PT, d: 0, items: [['r', 0, 0, 1, 1] as unknown as Line['items'][number]] };
  const m = new PreviewModel();
  m.applyLayout({
    pages: [{ page: 1, exact: false, hash: 1, dl: { ...dl, lines: [picture] } }],
    pagesTotal: 1,
    placements: [{ par_id: 9, fragments: [{ page: 1, first_line: 1, last_line: 1, x: 0, xs: [0], baselines: [160 * PT], approximate: false }], lines: 1, kind: 'env' }],
    keepFromRevision: null,
  });
  const words = [
    { text: 'Above', x: 0, y: 20 * PT, w: 25 * PT, size },
    // pdf.js splits a formula into runs on one baseline
    { text: 'y', x: 40 * PT, y: 150 * PT, w: 5 * PT, size },
    { text: '=', x: 48 * PT, y: 150 * PT, w: 8 * PT, size },
    { text: 'x/', x: 59 * PT, y: 150 * PT, w: 10 * PT, size },
    { text: '2', x: 70 * PT, y: 150 * PT, w: 5 * PT, size },
  ];
  const at = clickedChar(m, 1, 61 * PT, 148 * PT, words);
  assert.equal(at?.parId, 9);
  assert.equal(at?.gt.text, 'y = x/ 2');
  assert.equal(at?.gt.text[at.index], 'x');
  const src = '\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1) node[right] {$y = x/2$};\n\\end{tikzpicture}';
  assert.equal(sourceOffset(at!.gt, at!.index, at!.after, src), src.indexOf('x/2'));
  // without the PDF text there is nothing to match
  assert.equal(clickedChar(m, 1, 61 * PT, 148 * PT), undefined);
});

test('PDF text items are placed in sp by the viewport transform', () => {
  // a 100×200 PDF page at 2 sp per unit: y flips, the font size scales
  const vt = [2, 0, 0, -2, 0, 400];
  const ws = pdfWords([{ str: 'hi', transform: [10, 0, 0, 10, 5, 150], width: 8 }, { str: ' ', transform: [10, 0, 0, 10, 0, 0], width: 1 }, { str: 'up', transform: [0, 10, -10, 0, 5, 5], width: 8 }], vt, 2);
  assert.deepEqual(ws, [{ text: 'hi', x: 10, y: 100, w: 16, size: 20 }]);
});
