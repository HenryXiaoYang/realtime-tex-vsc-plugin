import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ShadowText, utf8Length } from '../src/edits';

/** Reference: apply UTF-8 byte edits to a byte buffer. */
function applyBytes(text: string, edits: { start: number; end: number; text: string }[]): string {
  let buf = Buffer.from(text, 'utf8');
  for (const e of edits) buf = Buffer.concat([buf.subarray(0, e.start), Buffer.from(e.text, 'utf8'), buf.subarray(e.end)]);
  return buf.toString('utf8');
}

test('utf8Length counts multi-byte characters', () => {
  assert.equal(utf8Length('abc'), 3);
  assert.equal(utf8Length('ü'), 2);
  assert.equal(utf8Length('—'), 3);
  assert.equal(utf8Length('𝔸'), 4);
  assert.equal(utf8Length('a𝔸b', 0, 2), 3); // a split surrogate pair counts 2 per half
});

test('byte offsets of ASCII, umlauts, CJK, astral and CRLF text', () => {
  const s = 'Grüße\r\n— 数学 𝔸 x';
  const sh = new ShadowText(s);
  for (let i = 0; i <= s.length; i++) {
    const hi = s.charCodeAt(i - 1);
    if (hi >= 0xd800 && hi <= 0xdbff) continue; // inside a pair
    assert.equal(sh.byteOffset(i), Buffer.byteLength(s.slice(0, i)), `offset ${i}`);
    assert.equal(sh.utf16Offset(Buffer.byteLength(s.slice(0, i))), i, `back ${i}`);
  }
});

test('single edits produce the same text as VS Code', () => {
  const before = 'Hallo Wörld\n$\\alpha$ ünd mehr\n';
  const sh = new ShadowText(before);
  const at = before.indexOf('ünd');
  const edits = sh.apply([{ rangeOffset: at, rangeLength: 3, text: 'and ∑' }]);
  const after = before.slice(0, at) + 'and ∑' + before.slice(at + 3);
  assert.equal(sh.text, after);
  assert.equal(applyBytes(before, edits), after);
  assert.deepEqual(edits[0], { start: Buffer.byteLength(before.slice(0, at)), end: Buffer.byteLength(before.slice(0, at + 3)), text: 'and ∑' });
});

test('multi-cursor changes are applied in order', () => {
  const before = 'é one\né two\né three\n';
  const sh = new ShadowText(before);
  // VS Code reports multi-cursor edits bottom-up, each relative to the text left by the previous
  const changes = [
    { rangeOffset: before.indexOf('é three'), rangeLength: 1, text: 'E' },
    { rangeOffset: before.indexOf('é two'), rangeLength: 1, text: 'E' },
    { rangeOffset: 0, rangeLength: 1, text: 'E' },
  ];
  const edits = sh.apply(changes);
  assert.equal(sh.text, 'E one\nE two\nE three\n');
  assert.equal(applyBytes(before, edits), sh.text);
});

test('checkpoints stay correct across many edits in a long document', () => {
  let text = '';
  for (let i = 0; i < 3000; i++) text += i % 7 === 0 ? `Zeile ${i} — ü𝔸\n` : `line ${i} plain text\n`;
  const sh = new ShadowText(text);
  let model = text;
  let seed = 7;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let k = 0; k < 400; k++) {
    let off = rnd(model.length);
    const c = model.charCodeAt(off);
    if (c >= 0xdc00 && c <= 0xdfff) off--; // not inside a pair
    let len = Math.min(rnd(4), model.length - off);
    const e = model.charCodeAt(off + len);
    if (e >= 0xdc00 && e <= 0xdfff) len++;
    const ins = ['x', 'ö', '∑', '𝔹', '', '\n'][rnd(6)];
    const before = model;
    const edits = sh.apply([{ rangeOffset: off, rangeLength: len, text: ins }]);
    model = model.slice(0, off) + ins + model.slice(off + len);
    assert.equal(applyBytes(before, edits), model);
  }
  assert.equal(sh.text, model);
  assert.equal(sh.byteOffset(model.length), Buffer.byteLength(model));
});
