import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as path from 'node:path';
import { findMainFile, includes, isMainFile, magicRoot, previewWrapper } from '../src/root';

test('magic root comment', () => {
  assert.equal(magicRoot('% !TEX root = ../main.tex\n\\section{A}'), '../main.tex');
  assert.equal(magicRoot('%!TeX root=thesis.tex\n'), 'thesis.tex');
  assert.equal(magicRoot('\\section{A}\n'), undefined);
});

test('documentclass detection ignores comments', () => {
  assert.ok(isMainFile('\\documentclass{article}\n'));
  assert.ok(!isMainFile('% \\documentclass{article}\n'));
});

test('include detection', () => {
  const main = '\\documentclass{book}\n\\begin{document}\n\\include{chapters/intro}\n% \\input{old}\n\\input{appendix.tex}\n\\end{document}';
  assert.ok(includes(main, 'chapters/intro.tex'));
  assert.ok(includes(main, 'appendix.tex'));
  assert.ok(!includes(main, 'old.tex'));
});

// Platform-consistent absolute paths: a POSIX `/p/...` fixture is not absolute on Windows and
// path.resolve() (used by the magic-root hop) would put it on the current drive.
const fixtureRoot = path.join(path.parse(process.cwd()).root, 'rtex-root-fixture');
const at = (rel: string) => path.join(fixtureRoot, ...rel.split('/'));
const files: Record<string, string> = {
  [at('main.tex')]: '\\documentclass{book}\n\\begin{document}\n\\include{ch/one}\n\\end{document}\n',
  [at('ch/one.tex')]: '\\chapter{One}\n',
  [at('ch/two.tex')]: '% !TEX root = ../main.tex\n\\chapter{Two}\n',
  [at('other.tex')]: '\\documentclass{article}\n',
};
const readFile = async (f: string) => files[f];
const candidates = Object.keys(files);

test('main file resolution', async () => {
  assert.equal(await findMainFile({ activeFile: at('main.tex'), candidates, readFile }), at('main.tex'));
  assert.equal(await findMainFile({ activeFile: at('ch/two.tex'), candidates, readFile }), at('main.tex'));
  assert.equal(await findMainFile({ activeFile: at('ch/one.tex'), candidates, readFile }), at('main.tex'));
  assert.equal(await findMainFile({ activeFile: at('ch/one.tex'), candidates, readFile, configured: at('other.tex') }), at('other.tex'));
  // not included anywhere and two candidates: ambiguous
  assert.equal(await findMainFile({ activeFile: at('loose.tex'), candidates, readFile }), undefined);
});

test('preview wrapper', () => {
  const t = '\\documentclass{article}\n\\begin{document}\n\\input{${file}}\n\\end{document}\n';
  assert.equal(previewWrapper(t, ['section', 'a.tex'].join(path.sep)), '\\documentclass{article}\n\\begin{document}\n\\input{section/a.tex}\n\\end{document}\n');
});
