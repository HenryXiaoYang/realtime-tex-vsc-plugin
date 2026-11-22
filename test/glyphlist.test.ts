import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGlyphList } from '../src/glyphlist';

const SAMPLE = `# comment line
arrowright;2192
element;2208
alpha;03B1
minus;2212
fi;FB01
f_f_i;0066 0066 0069
Omega;2126,03A9
broken;
zerooldstyle;F730
lscript;2113
acute;00B4
`;

test('glyph list: one name per line, hex code points', () => {
  const list = parseGlyphList(SAMPLE);
  assert.equal(list.get('arrowright'), '→');
  assert.equal(list.get('element'), '∈');
  assert.equal(list.get('alpha'), 'α');
  assert.equal(list.get('minus'), '−');
});

test('glyph list: sequences, alternatives and compatibility forms', () => {
  const list = parseGlyphList(SAMPLE);
  assert.equal(list.get('fi'), 'fi');
  assert.equal(list.get('f_f_i'), 'ffi');
  assert.equal(list.get('Omega'), 'Ω');
});

test('glyph list: a broken entry is skipped, not fatal', () => {
  const list = parseGlyphList(SAMPLE);
  assert.equal(list.has('broken'), false);
  assert.equal(parseGlyphList('').size, 0);
  assert.equal(parseGlyphList('no separator here').size, 0);
});

test('glyph list: private-use values are dropped, other glyphs keep their form', () => {
  const list = parseGlyphList(SAMPLE);
  assert.equal(list.has('zerooldstyle'), false);
  assert.equal(list.get('lscript'), 'ℓ');
  assert.equal(list.get('acute'), '´');
});
