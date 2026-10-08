import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, explainReasons } from '../src/status';
import { parseEncFile, parseMapFile } from '../src/type1';

test('status texts', () => {
  const base = { pending: false, errorCount: 0, pagesTotal: 3 };
  assert.equal(describe({ ...base, phase: 'starting' }).kind, 'busy');
  assert.equal(describe({ ...base, phase: 'live', lastFastMs: 0.84 }).text, 'Live · 0.8 ms');
  assert.equal(describe({ ...base, phase: 'live', pending: true }).text, 'Updating layout…');
  assert.equal(describe({ ...base, phase: 'live', errorCount: 2 }).text, '2 errors');
  assert.equal(describe({ ...base, phase: 'live', convergence: { state: 'PassLimitReached', passes: 5, reasons: [] } }).kind, 'warn');
  assert.equal(describe({ ...base, phase: 'live', convergence: { state: 'Converged' } }).text, 'Up to date');
  assert.match(explainReasons(['paragraph boundaries changed']), /split or merged/);
});

test('map and encoding files', () => {
  const map = parseMapFile('% comment\ncmmi10 CMMI10 <cmmi10.pfb\nec-lmr10 LMRoman10-Regular " enclmec ReEncodeFont " <lm-ec.enc <lmr10.pfb\nptmro8r Times-Roman " .167 SlantFont TeXBase1Encoding ReEncodeFont " <8r.enc <utmr8a.pfb\n');
  assert.deepEqual(map.get('cmmi10'), { tfm: 'cmmi10', psname: 'CMMI10', fontFile: 'cmmi10.pfb' });
  assert.equal(map.get('ec-lmr10')?.encFile, 'lm-ec.enc');
  assert.equal(map.get('ptmro8r')?.slant, 0.167);
  const enc = parseEncFile('% x\n/enc [\n/grave /acute % c\n/circumflex\n] def\n');
  assert.deepEqual(enc, ['grave', 'acute', 'circumflex']);
});
