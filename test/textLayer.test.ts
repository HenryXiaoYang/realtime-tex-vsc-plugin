import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DisplayList, Line } from '../src/protocol';
import { glyphText, readingOrder, words } from '../webview/textLayer';

const PT = 65536;
const size = 10 * PT;
const dl = { fonts: { '1': { id: 1, size } } } as unknown as DisplayList;

/** A line of `text` at baseline y; a space in `text` is a 3.3pt gap, every glyph 5pt wide. */
function line(text: string, y: number, tfm = false): Line {
  const items: Line['items'] = [];
  let x = 0;
  for (const ch of text) {
    if (ch === ' ') {
      x += 3.3 * PT;
      continue;
    }
    items.push(['g', 1, ch.codePointAt(0)!, tfm ? null : 1, x, y, 5 * PT, 0]);
    x += 5 * PT;
  }
  return { x: 0, y, w: x, h: 7 * PT, d: 2 * PT, items };
}

test('glyphs join into words, gaps into spaces, lines into line breaks', () => {
  const ws = words([
    { dl, line: line('Hello world', 100 * PT), dx: 0, dy: 0 },
    { dl, line: line('again', 112 * PT), dx: 0, dy: 0 },
  ]);
  assert.deepEqual(
    ws.map((w) => [w.text, w.eol]),
    [['Hello ', false], ['world', true], ['again', true]],
  );
  assert.equal(ws[0].w, 25 * PT);
});

test('glyph text: TFM ligature slots, Unicode ligatures, private-use variants', () => {
  assert.equal(glyphText(12, null), 'fi');
  assert.equal(glyphText(97, null), 'a');
  assert.equal(glyphText(0xfb01, 5), 'fi');
  assert.equal(glyphText(0xe123, 5), '');
  assert.equal(glyphText(0x4e2d, 5), '中');
});

test('live rows take the place of the lines they replace', () => {
  const a = { dl, line: line('a', 100 * PT), dx: 0, dy: 0 };
  const c = { dl, line: line('c', 124 * PT), dx: 0, dy: 0 };
  const b = { dl, line: line('b', 0), dx: 0, dy: 112 * PT };
  assert.deepEqual(
    words(readingOrder([a, c], [b])).map((w) => w.text),
    ['a', 'b', 'c'],
  );
});
