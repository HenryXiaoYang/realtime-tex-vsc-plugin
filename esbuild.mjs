// Bundles the extension (node, CommonJS), the preview webview (browser, ESM), the PDF link
// worker and the tests. PDF.js must stay inside dist/pdf-links.worker.js: the extension bundle
// only contains the host service and the webview keeps its own copy for fallback drawing.
import * as esbuild from 'esbuild';
import { copyFile, mkdir, readdir } from 'fs/promises';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };
const PDFJS_WORKER = 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs';

/** pdf.js is an ES module; the worker is CommonJS, so give third-party `import.meta.url` a real
 * file URL instead of esbuild's empty placeholder. `__filename` points at the worker bundle at
 * runtime (dist/ or out/test/), so no development-machine path is baked in. */
const pdfLinksWorker = (outfile) => ({
  ...common,
  entryPoints: ['src/pdfLinksWorker.ts'],
  outfile,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  banner: { js: "var __pdfLinksWorkerUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__pdfLinksWorkerUrl' },
});

const builds = [
  { ...common, entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] },
  { ...common, entryPoints: ['webview/main.ts'], outfile: 'dist/webview.js', platform: 'browser', format: 'esm', target: 'chrome114' },
  pdfLinksWorker('dist/pdf-links.worker.js'),
];

async function copyPdfjsWorker(outDir) {
  await mkdir(outDir, { recursive: true });
  await copyFile(PDFJS_WORKER, `${outDir}/pdf.worker.mjs`);
}

async function buildTests() {
  const tests = (await readdir('test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
  await mkdir('out/test', { recursive: true });
  await esbuild.build({ ...common, logLevel: 'warning', entryPoints: tests, outdir: 'out/test', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode'] });
  // The link tests spawn the real worker; it must sit next to the test bundle, with pdf.js's
  // own parser module beside it.
  await esbuild.build({ ...pdfLinksWorker('out/test/pdf-links.worker.js'), logLevel: 'warning' });
  await copyPdfjsWorker('out/test');
}

if (args.has('--e2e')) {
  await esbuild.build({ ...common, logLevel: 'warning', entryPoints: ['test/e2e/runTest.ts', 'test/e2e/suite.ts'], outdir: 'out/e2e', platform: 'node', format: 'cjs', target: 'node18', external: ['vscode', '@vscode/test-electron'] });
} else if (args.has('--tests')) {
  await buildTests();
} else if (watch) {
  await copyPdfjsWorker('dist');
  for (const b of builds) await (await esbuild.context(b)).watch();
} else {
  await copyPdfjsWorker('dist');
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
