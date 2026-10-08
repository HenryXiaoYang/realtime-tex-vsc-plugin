import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findMainFile, includes, isMainFile, magicRoot } from '../src/root';

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

const files: Record<string, string> = {
  '/p/main.tex': '\\documentclass{book}\n\\begin{document}\n\\include{ch/one}\n\\end{document}\n',
  '/p/ch/one.tex': '\\chapter{One}\n',
  '/p/ch/two.tex': '% !TEX root = ../main.tex\n\\chapter{Two}\n',
  '/p/other.tex': '\\documentclass{article}\n',
};
const readFile = async (f: string) => files[f];
const candidates = Object.keys(files);

test('main file resolution', async () => {
  assert.equal(await findMainFile({ activeFile: '/p/main.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/two.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/one.tex', candidates, readFile }), '/p/main.tex');
  assert.equal(await findMainFile({ activeFile: '/p/ch/one.tex', candidates, readFile, configured: '/p/other.tex' }), '/p/other.tex');
  // not included anywhere and two candidates: ambiguous
  assert.equal(await findMainFile({ activeFile: '/p/loose.tex', candidates, readFile }), undefined);
});
