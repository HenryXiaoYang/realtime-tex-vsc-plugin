import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { folderExceeds } from '../src/folderSize';

test('folder size counts what rtex copies', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rtex-size-'));
  mkdirSync(path.join(dir, 'fig'));
  mkdirSync(path.join(dir, '.git'));
  mkdirSync(path.join(dir, 'build'));
  writeFileSync(path.join(dir, 'main.tex'), 'x'.repeat(10));
  writeFileSync(path.join(dir, 'fig', 'a.png'), 'x'.repeat(10));
  writeFileSync(path.join(dir, '.git', 'pack'), 'x'.repeat(100));
  writeFileSync(path.join(dir, 'build', 'out.pdf'), 'x'.repeat(100));
  assert.equal(await folderExceeds(dir, 19), true);
  assert.equal(await folderExceeds(dir, 20), false);
  assert.equal(await folderExceeds(dir, 19, path.join(dir, 'fig')), false);
});
