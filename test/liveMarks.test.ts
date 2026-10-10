import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LiveState, trimRange } from '../src/liveMarks';
import type { Span } from '../src/protocol';

const span = (id: number, kind: Span['kind'] = 'Body'): Span => ({ id, range: { start: id * 10, end: id * 10 + 9 }, kind, hash: 0, last_revision: 0 });
const kinds = (s: LiveState, spans: Span[]) => s.marks(spans).map((m) => `${m.span.id}:${m.kind}`);

test('no marks before the first layout', () => {
  assert.deepEqual(new LiveState().marks([span(1, 'Preamble'), span(2)]), []);
});

test('the layout decides: eligible parts are live, other placed parts and the preamble wait', () => {
  const s = new LiveState();
  s.layout([2], [2, 3]);
  // 4 is unknown (new text), 5 is after \end{document}
  assert.deepEqual(kinds(s, [span(1, 'Preamble'), span(2), span(3, 'Env'), span(4), span(5, 'Trailer')]), ['1:full', '2:live', '3:full']);
});

test('what edits did overrides the layout until the next one', () => {
  const s = new LiveState();
  s.layout([2], [2, 3]);
  s.observed([2], false, ['OverBudget(12)']);
  s.observed([4], true);
  assert.deepEqual(kinds(s, [span(2), span(3), span(4)]), ['2:full', '3:full', '4:live']);
  assert.deepEqual(s.marks([span(2)])[0].reasons, ['OverBudget(12)']);
  s.layout([2, 4], [2, 3, 4]);
  assert.deepEqual(kinds(s, [span(2), span(3), span(4)]), ['2:live', '3:full', '4:live']);
});

test('a part the live engine failed on stays on the full compile until the engine restarts', () => {
  const s = new LiveState();
  s.layout([2], [2]);
  s.observed([2], false, ['EngineFailed: the live engine hung or crashed on this paragraph']);
  s.layout([2], [2]);
  assert.deepEqual(kinds(s, [span(2)]), ['2:full']);
  s.restarted();
  assert.deepEqual(kinds(s, [span(2)]), ['2:live']);
});

test('trimRange drops the blank lines around a part', () => {
  const text = '\n\nHello world.\n\n';
  assert.deepEqual(trimRange(text, 0, text.length), [2, 14]);
  assert.equal(trimRange('  \n ', 0, 4), undefined);
});
