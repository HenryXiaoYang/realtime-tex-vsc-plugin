import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { PdfLinkError, PdfLinkExtractor, extractPdfLinks, type PdfLinkExtractorOptions, type PdfLinkExtractorStats } from '../src/pdfLinks';
import type { PdfLink } from '../src/protocol';
import {
  buildPdf,
  manyLinksPdf,
  minimalLinksPdf,
  pdfWithoutLinks,
  truncatePdf,
  type FixturePage,
  type FixtureRect,
} from './pdfFixtures';

const workDir = mkdtempSync(path.join(tmpdir(), 'rtex-pdf-links-'));
after(() => rmSync(workDir, { recursive: true, force: true }));

function pdfFile(name: string, data: Buffer): string {
  const file = path.join(workDir, name);
  writeFileSync(file, data);
  return file;
}

function near(actual: number | undefined, expected: number, label: string): void {
  assert.equal(typeof actual, 'number', `${label} is missing`);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${label}: ${String(actual)} != ${expected}`);
}

function nearMaybe(actual: number | undefined, expected: number | undefined, label: string): void {
  if (expected === undefined) {
    assert.equal(actual, undefined, `${label} should be omitted`);
    return;
  }
  near(actual, expected, label);
}

function linkOn(links: readonly PdfLink[], page: number, kind: 'url' | 'page'): PdfLink {
  const link = links.find((candidate) => candidate.page === page && candidate.target.kind === kind);
  assert.ok(link, `missing ${kind} link on page ${page}`);
  return link;
}

async function withExtractor<T>(fn: (extractor: PdfLinkExtractor) => Promise<T>, options: PdfLinkExtractorOptions = {}): Promise<T> {
  const extractor = new PdfLinkExtractor(options);
  try {
    return await fn(extractor);
  } finally {
    extractor.dispose();
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for the worker to start');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function abortName(error: unknown): boolean {
  assert.ok(error instanceof Error, 'expected an Error');
  assert.equal(error.name, 'AbortError');
  return true;
}

function errorCode(code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PdfLinkError, `expected PdfLinkError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

test('pdf.js turns annotations into URL and page links with a page aspect', async () => {
  const file = pdfFile('minimal.pdf', minimalLinksPdf());
  await withExtractor(async (extractor) => {
    const links = await extractor.extract(file);
    assert.equal(links.length, 2);

    const url = linkOn(links, 1, 'url');
    if (url.target.kind !== 'url') assert.fail('the URI annotation is missing');
    near(url.x, 0.05, 'url x');
    near(url.y, 0.8, 'url y');
    near(url.w, 0.45, 'url w');
    near(url.h, 0.1, 'url h');
    near(url.pageAspect, 1, 'url pageAspect');
    assert.deepEqual(url.userRect, [10, 20, 100, 40]);
    assert.equal(url.target.url, 'https://example.com/');

    const page = linkOn(links, 1, 'page');
    if (page.target.kind !== 'page') assert.fail('the destination annotation is missing');
    assert.equal(page.target.page, 1);
    near(page.target.x, 0, 'destination x');
    near(page.target.y, 0.5, 'destination y');
    near(page.target.pageAspect, 1, 'destination pageAspect');
    near(page.target.userX, 0, 'destination userX');
    near(page.target.userY, 100, 'destination userY');
  });
});

test('rotation is applied to link rectangles and XYZ destinations through the page viewport', async () => {
  const pages: FixturePage[] = [90, 180, 270].map((rotate, index) => ({
    mediaBox: [0, 0, 200, 400] as FixtureRect,
    rotate,
    links: [
      { rect: [10, 20, 100, 40] as FixtureRect, url: `https://example.com/rot${rotate}` },
      { rect: [120, 220, 180, 260] as FixtureRect, dest: [index + 1, 'XYZ', 20, 150, null] },
    ],
  }));
  const file = pdfFile('rotated.pdf', buildPdf({ pages }));

  await withExtractor(async (extractor) => {
    const links = await extractor.extract(file);
    assert.equal(links.length, 6);

    const rot90Url = linkOn(links, 1, 'url');
    near(rot90Url.x, 0.05, 'rot90 url x');
    near(rot90Url.y, 0.05, 'rot90 url y');
    near(rot90Url.w, 0.05, 'rot90 url w');
    near(rot90Url.h, 0.45, 'rot90 url h');
    near(rot90Url.pageAspect, 2, 'rot90 pageAspect');
    assert.deepEqual(rot90Url.userRect, [10, 20, 100, 40]);
    const rot90Target = linkOn(links, 1, 'page').target;
    if (rot90Target.kind !== 'page') assert.fail('rot90 destination missing');
    near(rot90Target.x, 0.375, 'rot90 destination x');
    near(rot90Target.y, 0.1, 'rot90 destination y');
    near(rot90Target.pageAspect, 2, 'rot90 destination pageAspect');
    near(rot90Target.userX, 20, 'rot90 destination userX');
    near(rot90Target.userY, 150, 'rot90 destination userY');

    const rot180Url = linkOn(links, 2, 'url');
    near(rot180Url.x, 0.5, 'rot180 url x');
    near(rot180Url.y, 0.05, 'rot180 url y');
    near(rot180Url.w, 0.45, 'rot180 url w');
    near(rot180Url.h, 0.05, 'rot180 url h');
    near(rot180Url.pageAspect, 0.5, 'rot180 pageAspect');
    const rot180Target = linkOn(links, 2, 'page').target;
    if (rot180Target.kind !== 'page') assert.fail('rot180 destination missing');
    near(rot180Target.x, 0.9, 'rot180 destination x');
    near(rot180Target.y, 0.375, 'rot180 destination y');
    near(rot180Target.userX, 20, 'rot180 destination userX');
    near(rot180Target.userY, 150, 'rot180 destination userY');

    const rot270Url = linkOn(links, 3, 'url');
    near(rot270Url.x, 0.9, 'rot270 url x');
    near(rot270Url.y, 0.5, 'rot270 url y');
    near(rot270Url.w, 0.05, 'rot270 url w');
    near(rot270Url.h, 0.45, 'rot270 url h');
    near(rot270Url.pageAspect, 2, 'rot270 pageAspect');
    const rot270Target = linkOn(links, 3, 'page').target;
    if (rot270Target.kind !== 'page') assert.fail('rot270 destination missing');
    near(rot270Target.x, 0.625, 'rot270 destination x');
    near(rot270Target.y, 0.9, 'rot270 destination y');
    near(rot270Target.userX, 20, 'rot270 destination userX');
    near(rot270Target.userY, 150, 'rot270 destination userY');
  });
});

test('XYZ destinations use the crop box and the rotated target viewport', async () => {
  const pages: FixturePage[] = [
    {
      mediaBox: [0, 0, 200, 400],
      cropBox: [0, 100, 200, 300],
      links: [{ rect: [10, 120, 100, 140], dest: [1, 'XYZ', 20, 250, null] }],
    },
    {
      mediaBox: [0, 0, 200, 400],
      rotate: 90,
      links: [{ rect: [10, 20, 100, 40], dest: [2, 'XYZ', 20, 150, null] }],
    },
  ];
  const file = pdfFile('crop.pdf', buildPdf({ pages }));

  await withExtractor(async (extractor) => {
    const links = await extractor.extract(file);
    assert.equal(links.length, 2);

    const cropped = links[0];
    near(cropped.x, 0.05, 'crop source x');
    near(cropped.y, 0.8, 'crop source y');
    near(cropped.w, 0.45, 'crop source w');
    near(cropped.h, 0.1, 'crop source h');
    near(cropped.pageAspect, 1, 'crop pageAspect');
    assert.deepEqual(cropped.userRect, [10, 120, 100, 140]);
    if (cropped.target.kind !== 'page') assert.fail('crop destination missing');
    near(cropped.target.x, 0.1, 'crop destination x');
    near(cropped.target.y, 0.25, 'crop destination y');
    near(cropped.target.pageAspect, 1, 'crop destination pageAspect');
    near(cropped.target.userX, 20, 'crop destination userX');
    near(cropped.target.userY, 250, 'crop destination userY');

    const rotated = links[1];
    near(rotated.pageAspect, 2, 'rotated target pageAspect');
    assert.deepEqual(rotated.userRect, [10, 20, 100, 40]);
    if (rotated.target.kind !== 'page') assert.fail('rotated destination missing');
    near(rotated.target.x, 0.375, 'rotated destination x');
    near(rotated.target.y, 0.1, 'rotated destination y');
    near(rotated.target.pageAspect, 2, 'rotated destination aspect');
    near(rotated.target.userX, 20, 'rotated destination userX');
    near(rotated.target.userY, 150, 'rotated destination userY');
  });
});

test('named destinations and every destination kind keep finite page fractions', async () => {
  const pages: FixturePage[] = [
    {
      mediaBox: [0, 0, 200, 400],
      links: [
        { rect: [10, 10, 50, 30], dest: 'intro' },
        { rect: [10, 40, 50, 60], dest: [1, 'FitH', 150] },
        { rect: [10, 70, 50, 90], dest: [1, 'FitBH', 200] },
        { rect: [10, 100, 50, 120], dest: [1, 'FitR', 10, 50, 100, 150] },
        { rect: [10, 130, 50, 150], dest: [1, 'Fit'] },
        { rect: [10, 160, 50, 180], dest: [1, 'FitB'] },
        { rect: [10, 190, 50, 210], dest: [1, 'XYZ', null, 100, null] },
        { rect: [10, 220, 50, 240], dest: [1, 'XYZ', 20, null, null] },
        { rect: [10, 250, 50, 270], dest: [1, 'XYZ', null, null, null] },
        { rect: [10, 280, 50, 300], dest: [1, 'FitV', 20] },
        { rect: [10, 310, 50, 330], dest: [1, 'FitBV', 100] },
      ],
    },
  ];
  const file = pdfFile('destinations.pdf', buildPdf({ pages, namedDests: { intro: [1, 'XYZ', 0, 100, null] } }));

  await withExtractor(async (extractor) => {
    const links = await extractor.extract(file);
    assert.equal(links.length, 11);
    const expected: [number, number, string, number | undefined, number | undefined][] = [
      [0, 0.75, 'named XYZ', 0, 100],
      [0, 0.625, 'FitH', undefined, 150],
      [0, 0.5, 'FitBH', undefined, 200],
      [0.05, 0.625, 'FitR top-left', 10, 150],
      [0, 0, 'Fit', undefined, undefined],
      [0, 0, 'FitB', undefined, undefined],
      [0, 0.75, 'XYZ null left', undefined, 100],
      [0.1, 0, 'XYZ null top', 20, undefined],
      [0, 0, 'XYZ all null', undefined, undefined],
      [0.1, 0, 'FitV', 20, undefined],
      [0.5, 0, 'FitBV', 100, undefined],
    ];
    links.forEach((link, index) => {
      if (link.target.kind !== 'page') assert.fail(`${expected[index][2]} is not a page target`);
      near(link.target.x, expected[index][0], `${expected[index][2]} x`);
      near(link.target.y, expected[index][1], `${expected[index][2]} y`);
      near(link.target.pageAspect, 0.5, `${expected[index][2]} pageAspect`);
      nearMaybe(link.target.userX, expected[index][3], `${expected[index][2]} userX`);
      nearMaybe(link.target.userY, expected[index][4], `${expected[index][2]} userY`);
      assert.equal(link.target.page, 1);
    });
  });
});

test('broken destinations and unsafe URLs are skipped without losing the other links', async () => {
  const pages: FixturePage[] = [
    {
      mediaBox: [0, 0, 200, 400],
      links: [
        { rect: [10, 10, 50, 30], url: 'https://example.com/good' },
        { rect: [10, 40, 50, 60], url: 'javascript:alert(1)' },
        { rect: [10, 70, 50, 90], url: 'ftp://example.com/file' },
        { rect: [10, 100, 50, 120], url: 'tel:+15555550100' },
        { rect: [10, 130, 50, 150], url: 'data:text/html,hi' },
        { rect: [10, 160, 50, 180], url: 'mailto:reader@example.com' },
        { rect: [10, 190, 50, 210], dest: [999, 'XYZ', 0, 0, null] },
        { rect: [10, 220, 50, 240], dest: 'missing' },
      ],
    },
  ];
  const file = pdfFile('bad-targets.pdf', buildPdf({ pages }));

  await withExtractor(async (extractor) => {
    const links = await extractor.extract(file);
    assert.equal(links.length, 2);
    assert.deepEqual(
      links.map((link) => (link.target.kind === 'url' ? link.target.url : 'page')),
      ['https://example.com/good', 'mailto:reader@example.com'],
    );
  });
});

test('truncated and invalid PDFs reject, and a fixed file is parsed by the same extractor', async () => {
  const file = pdfFile('incomplete.pdf', truncatePdf(minimalLinksPdf()));
  const extractor = new PdfLinkExtractor();
  try {
    await assert.rejects(extractor.extract(file), errorCode('incomplete'));
    writeFileSync(file, minimalLinksPdf());
    const links = await extractor.extract(file);
    assert.equal(links.length, 2);
    assert.ok(extractor.stats.workerStarts >= 2, 'a failed worker must be replaced');

    const invalid = pdfFile('invalid.pdf', Buffer.from('%PDF-1.4\n%%EOF\n', 'latin1'));
    await assert.rejects(extractor.extract(invalid), errorCode('invalid'));
  } finally {
    extractor.dispose();
  }
});

test('a page-count mismatch rejects while a complete PDF without links returns []', async () => {
  const file = pdfFile('page-count.pdf', minimalLinksPdf());
  const empty = pdfFile('no-links.pdf', pdfWithoutLinks(3));
  await withExtractor(async (extractor) => {
    await assert.rejects(extractor.extract(file, 2), errorCode('pages'));
    assert.equal((await extractor.extract(file)).length, 2);
    assert.deepEqual(await extractor.extract(empty, 3), []);
    await assert.rejects(extractor.extract(empty, 2), errorCode('pages'));
  });
});

test('A/B/A snapshots are cached, concurrent requests share one promise, and a rewrite is reparsed', async () => {
  const fileA = pdfFile('cache-a.pdf', minimalLinksPdf());
  const fileB = pdfFile('cache-b.pdf', pdfWithoutLinks(2));
  await withExtractor(async (extractor) => {
    const first = extractor.extract(fileA);
    const second = extractor.extract(fileA);
    assert.equal(first, second, 'the same in-flight snapshot must share one promise');
    const [linksA, linksA2] = await Promise.all([first, second]);
    assert.equal(linksA.length, 2);
    assert.equal(linksA2.length, 2);
    let stats: PdfLinkExtractorStats = extractor.stats;
    assert.equal(stats.requests, 2);
    assert.equal(stats.workerStarts, 1);

    assert.deepEqual(await extractor.extract(fileB), []);
    assert.equal((await extractor.extract(fileA)).length, 2);
    stats = extractor.stats;
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.workerStarts, 1, 'an idle worker is reused');

    writeFileSync(
      fileA,
      buildPdf({
        pages: [{ mediaBox: [0, 0, 200, 200], links: [{ rect: [10, 20, 100, 40], url: 'https://changed.example/' }] }],
      }),
    );
    const changed = await extractor.extract(fileA);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].target.kind === 'url' ? changed[0].target.url : 'page', 'https://changed.example/');
    assert.equal(extractor.stats.cacheHits, 1, 'a changed mtime/size must not hit the cache');
  });
});

test('the snapshot cache is bounded and evicts the oldest file', async () => {
  const files = [1, 2, 3].map((pages) => pdfFile(`bounded-${pages}.pdf`, pdfWithoutLinks(pages)));
  await withExtractor(
    async (extractor) => {
      for (const file of files) await extractor.extract(file);
      assert.equal(extractor.stats.cacheHits, 0);
      await extractor.extract(files[0]);
      assert.equal(extractor.stats.cacheHits, 0, 'the oldest snapshot was evicted');
      await extractor.extract(files[2]);
      assert.equal(extractor.stats.cacheHits, 1);
    },
    { cacheLimit: 2 },
  );
});

test('cancel rejects an in-flight parse with AbortError and a new request still succeeds', async () => {
  const file = pdfFile('cancel.pdf', manyLinksPdf(300, 2));
  const extractor = new PdfLinkExtractor();
  try {
    const pending = extractor.extract(file, 300);
    await waitFor(() => extractor.stats.workerStarts >= 1);
    extractor.cancel();
    await assert.rejects(pending, abortName);
    assert.ok(extractor.stats.aborts >= 1);

    const links = await extractor.extract(file, 300);
    assert.equal(links.length, 600);
    assert.ok(extractor.stats.workerStarts >= 2, 'cancelling terminates the old worker');
  } finally {
    extractor.dispose();
  }
});

test('a newer request replaces an in-flight extraction and the old result never leaks', async () => {
  const big = pdfFile('replace-big.pdf', manyLinksPdf(300, 2));
  const small = pdfFile('replace-small.pdf', minimalLinksPdf());
  const extractor = new PdfLinkExtractor();
  try {
    const old = extractor.extract(big, 300);
    await waitFor(() => extractor.stats.workerStarts >= 1);
    const fresh = extractor.extract(small);
    await assert.rejects(old, abortName);
    const links = await fresh;
    assert.equal(links.length, 2);
    assert.ok(extractor.stats.workerStarts >= 2);
  } finally {
    extractor.dispose();
  }
});

test('cancel with no in-flight request does not restart the idle worker', async () => {
  const file = pdfFile('idle-cancel.pdf', minimalLinksPdf());
  await withExtractor(async (extractor) => {
    assert.equal((await extractor.extract(file)).length, 2);
    const starts = extractor.stats.workerStarts;
    extractor.cancel();
    extractor.cancel();
    assert.equal((await extractor.extract(file)).length, 2);
    assert.equal(extractor.stats.workerStarts, starts, 'an idle worker must survive a no-op cancel');
  });
});

test('annotation workers cannot load native addons', async () => {
  const file = pdfFile('no-native-addons.pdf', minimalLinksPdf());
  const worker = path.join(workDir, 'no-native-addons.worker.cjs');
  writeFileSync(worker, `
    const { parentPort } = require('node:worker_threads');
    const { statSync } = require('node:fs');
    parentPort.on('message', ({ id, file }) => {
      let code;
      try { process.dlopen({ exports: {} }, __filename); }
      catch (error) { code = error.code; }
      if (code !== 'ERR_DLOPEN_DISABLED') throw new Error('Native addon loading was not disabled');
      const { mtimeMs, size } = statSync(file);
      parentPort.postMessage({ type: 'result', id, links: [], snapshot: { mtimeMs, size } });
    });
  `);
  await withExtractor(async (extractor) => {
    assert.deepEqual(await extractor.extract(file), []);
  }, { workerFile: worker });
});

test('extractPdfLinks stays a working one-shot API', async () => {
  const file = pdfFile('one-shot.pdf', minimalLinksPdf());
  assert.equal((await extractPdfLinks(file)).length, 2);
});

test('a wedged worker times out instead of leaving a hanging promise', async () => {
  const pdf = pdfFile('timeout.pdf', minimalLinksPdf());
  const worker = path.join(workDir, 'wedged.worker.cjs');
  writeFileSync(
    worker,
    [
      "const { parentPort } = require('node:worker_threads');",
      'parentPort.on("message", () => {',
      '  const cell = new Int32Array(new SharedArrayBuffer(4));',
      '  Atomics.wait(cell, 0, 0, 5000);',
      '});',
      '',
    ].join('\n'),
  );
  const extractor = new PdfLinkExtractor({ workerFile: worker, timeoutMs: 100 });
  try {
    await assert.rejects(extractor.extract(pdf), (error: unknown) => {
      assert.ok(error instanceof PdfLinkError, 'expected a PdfLinkError');
      assert.equal(error.code, 'worker');
      assert.match(error.message, /timed out/);
      return true;
    });
  } finally {
    extractor.dispose();
  }
});

test('dispose rejects in-flight work and all later requests', async () => {
  const file = pdfFile('dispose.pdf', manyLinksPdf(300, 2));
  const extractor = new PdfLinkExtractor();
  const pending = extractor.extract(file, 300);
  await waitFor(() => extractor.stats.workerStarts >= 1);
  extractor.dispose();
  await assert.rejects(pending, abortName);
  await assert.rejects(extractor.extract(file), errorCode('disposed'));
  extractor.dispose();
});

test('the host event loop runs while the worker is synchronously busy', async () => {
  const pdf = pdfFile('liveness.pdf', minimalLinksPdf());
  const worker = path.join(workDir, 'blocking.worker.cjs');
  writeFileSync(
    worker,
    [
      "const { parentPort } = require('node:worker_threads');",
      'parentPort.on("message", (message) => {',
      '  const cell = new Int32Array(new SharedArrayBuffer(4));',
      '  Atomics.wait(cell, 0, 0, 250);',
      '  parentPort.postMessage({ type: "result", id: message.id, links: [], snapshot: { mtimeMs: 0, size: 0 } });',
      '});',
      '',
    ].join('\n'),
  );

  const extractor = new PdfLinkExtractor({ workerFile: worker });
  try {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks++;
    }, 5);
    const started = Date.now();
    const links = await extractor.extract(pdf);
    const elapsed = Date.now() - started;
    clearInterval(timer);
    assert.deepEqual(links, []);
    assert.ok(elapsed >= 200, `the blocking worker should take about 250 ms, took ${elapsed}`);
    assert.ok(ticks >= 5, `the host timer fired only ${ticks} times while the worker was busy`);
  } finally {
    extractor.dispose();
  }
});

test('the worker loads from a path with Chinese characters and spaces', async () => {
  const bundle = __dirname;
  const sourceWorker = path.join(bundle, 'pdf-links.worker.js');
  const sourcePdfWorker = path.join(bundle, 'pdf.worker.mjs');
  assert.ok(existsSync(sourceWorker), 'the test build must put pdf-links.worker.js next to the test bundle');
  assert.ok(existsSync(sourcePdfWorker), 'the test build must put pdf.worker.mjs next to the test bundle');

  const dir = path.join(workDir, '中文 目录');
  mkdirSync(dir, { recursive: true });
  copyFileSync(sourceWorker, path.join(dir, 'pdf-links.worker.js'));
  copyFileSync(sourcePdfWorker, path.join(dir, 'pdf.worker.mjs'));

  const file = pdfFile('unicode-path.pdf', minimalLinksPdf());
  const extractor = new PdfLinkExtractor({ workerFile: path.join(dir, 'pdf-links.worker.js') });
  try {
    assert.equal((await extractor.extract(file)).length, 2);
  } finally {
    extractor.dispose();
  }
});

test('worker crashes, exits and missing worker files reject instead of hanging', async () => {
  const pdf = pdfFile('worker-failure.pdf', minimalLinksPdf());

  const crash = path.join(workDir, 'crash.worker.cjs');
  writeFileSync(
    crash,
    "const { parentPort } = require('node:worker_threads');\nparentPort.on('message', () => { throw new Error('boom'); });\n",
  );
  const crashExtractor = new PdfLinkExtractor({ workerFile: crash });
  try {
    await assert.rejects(crashExtractor.extract(pdf), (error: unknown) => {
      assert.ok(error instanceof PdfLinkError, 'expected a PdfLinkError');
      assert.equal(error.code, 'worker');
      assert.match(error.message, /boom/);
      return true;
    });
  } finally {
    crashExtractor.dispose();
  }

  const exit = path.join(workDir, 'exit.worker.cjs');
  writeFileSync(
    exit,
    "const { parentPort } = require('node:worker_threads');\nparentPort.on('message', () => process.exit(7));\n",
  );
  const exitExtractor = new PdfLinkExtractor({ workerFile: exit });
  try {
    await assert.rejects(exitExtractor.extract(pdf), (error: unknown) => {
      assert.ok(error instanceof PdfLinkError, 'expected a PdfLinkError');
      assert.equal(error.code, 'worker');
      assert.match(error.message, /exited with code 7/);
      return true;
    });
  } finally {
    exitExtractor.dispose();
  }

  const missing = new PdfLinkExtractor({ workerFile: path.join(workDir, 'missing.worker.js') });
  try {
    await assert.rejects(missing.extract(pdf), errorCode('worker'));
  } finally {
    missing.dispose();
  }
});
