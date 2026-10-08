// Bundles the extension (node, CommonJS), the preview webview (browser, ESM) and the tests.
import * as esbuild from 'esbuild';
import { copyFile, mkdir, readdir } from 'fs/promises';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'esm', target: 'chrome114' },
];

async function copyWorker() {
  await mkdir('dist', { recursive: true });
  await copyFile('node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs', 'dist/pdf.worker.mjs');
}

if (args.has('--e2e')) {
  await esbuild.build({ ...common, logLevel: 'warning', entryPoints: ['test/e2e/runTest.ts', 'test/e2e/suite.ts'], outdir: 'out/e2e', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode', '@vscode/test-electron'] });
} else if (args.has('--tests')) {
  const tests = (await readdir('test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
  await esbuild.build({ ...common, logLevel: 'warning', entryPoints: tests, outdir: 'out/test', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] });
} else if (watch) {
  await copyWorker();
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await copyWorker();
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
