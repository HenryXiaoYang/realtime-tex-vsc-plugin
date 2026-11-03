import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DisplayList, PdfLink, Placement } from '../src/protocol';
import {
  captureSnapshot,
  LayoutLinkController,
  layoutPdfPath,
  readCompletePdf,
  SerialQueue,
  type LayoutMessage,
  type LayoutSnapshot,
  type LinkExtractorLike,
} from '../src/preview/layoutLinks';
import { PreviewModel } from '../webview/model';

const U = 65536;

function deferred<T>() {
  const d: { promise: Promise<T>; settled: boolean; resolve: (value: T) => void; reject: (error: unknown) => void } = {
    promise: Promise.resolve() as Promise<T>,
    settled: false,
    resolve: () => undefined,
    reject: () => undefined,
  };
  d.promise = new Promise<T>((resolve, reject) => {
    d.resolve = (value) => {
      d.settled = true;
      resolve(value);
    };
    d.reject = (error) => {
      d.settled = true;
      reject(error);
    };
  });
  return d;
}

function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

interface ExtractCall {
  file: string;
  expectedPages: number | undefined;
  deferred: ReturnType<typeof deferred<PdfLink[]>>;
}

class FakeExtractor implements LinkExtractorLike {
  readonly calls: ExtractCall[] = [];
  cancelled = 0;
  disposed = 0;
  private current: ExtractCall['deferred'] | undefined;

  extract(file: string, expectedPages?: number): Promise<PdfLink[]> {
    const d = deferred<PdfLink[]>();
    this.calls.push({ file, expectedPages, deferred: d });
    this.current = d;
    return d.promise;
  }

  cancel(): void {
    this.cancelled++;
    const current = this.current;
    if (current && !current.settled) {
      current.reject(abortError());
      this.current = undefined;
    }
  }

  dispose(): void {
    this.disposed++;
    this.cancel();
  }
}

function dl(page: number, exact = true): DisplayList {
  return {
    kind: 'page',
    fonts: {},
    lines: [],
    other: [],
    flags: [],
    width: 0,
    height: 0,
    depth: 0,
    page,
    page_width: 200 * 65781.76,
    page_height: 400 * 65781.76,
  };
}

function page(pageNumber: number, exact = true) {
  return { page: pageNumber, exact, hash: pageNumber, dl: dl(pageNumber, exact) };
}

const placement = (parId: number, pageNumber: number): Placement => ({
  par_id: parId,
  fragments: [{ page: pageNumber, first_line: 1, last_line: 1, x: 10, xs: [10], baselines: [100], approximate: false }],
  lines: 1,
  kind: '',
});

function snapshot(engineVersion: number, buildDir: string, context: string, pageNumber = 1): LayoutSnapshot<string> {
  return {
    context,
    engineVersion,
    pdfPath: layoutPdfPath(buildDir, engineVersion),
    pages: [page(pageNumber)],
    pagesTotal: Math.max(pageNumber, 1),
    placements: [placement(1, pageNumber)],
    overlays: [],
    keepFromRevision: null,
    full: false,
    pdfFallback: false,
  };
}

interface Recorder {
  layouts: LayoutMessage[];
  links: { links: PdfLink[]; version: number }[];
  prepared: string[];
  overlays: number[];
  logs: string[];
  events: string[];
}

function hostFor(gates: Map<number, ReturnType<typeof deferred<void>>> = new Map(), recorder: Recorder = emptyRecorder()) {
  return {
    recorder,
    host: {
      async prepare(snap: LayoutSnapshot<string>): Promise<Uint8Array | null> {
        recorder.events.push(`prepare:${snap.engineVersion}`);
        const gate = gates.get(snap.engineVersion);
        if (gate) await gate.promise;
        recorder.prepared.push(snap.pdfPath);
        return null;
      },
      layout(message: LayoutMessage): void {
        recorder.layouts.push(message);
        recorder.events.push(`layout:${message.layoutVersion}`);
      },
      overlays(snap: LayoutSnapshot<string>): void {
        recorder.overlays.push(snap.overlays.length);
      },
      links(links: PdfLink[], version: number): void {
        recorder.links.push({ links, version });
        recorder.events.push(`links:${version}`);
      },
      log(message: string): void {
        recorder.logs.push(message);
      },
    },
  };
}

function emptyRecorder(): Recorder {
  return { layouts: [], links: [], prepared: [], overlays: [], logs: [], events: [] };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function settle(queue: SerialQueue): Promise<void> {
  await queue.idle();
  await tick();
  await tick();
}

test('delayed pages are posted in order and only the newest layout extracts links', async () => {
  const build = path.join('C:', 'build');
  const gates = new Map([[1, deferred<void>()], [2, deferred<void>()]]);
  const rec = emptyRecorder();
  const { host } = hostFor(gates, rec);
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController(queue, extractor, host);

  const v1 = controller.submit(snapshot(1, build, 'A', 1));
  const v2 = controller.submit(snapshot(2, build, 'A', 2));
  assert.equal(rec.prepared.length, 0, 'nothing runs before the serial queue reaches the job');
  gates.get(1)!.resolve();
  await tick();
  await tick();
  assert.deepEqual(rec.layouts.map((l) => l.pages[0].page), [1], 'the intermediate layout is not dropped');
  assert.deepEqual(rec.prepared, [layoutPdfPath(build, 1)], 'the delayed layout reads its own version PDF');
  gates.get(2)!.resolve();
  await settle(queue);
  assert.deepEqual(rec.layouts.map((l) => l.pages[0].page), [1, 2]);
  assert.deepEqual(rec.prepared, [layoutPdfPath(build, 1), layoutPdfPath(build, 2)]);
  assert.ok(rec.prepared.every((p) => /layout-\d+\.pdf$/.test(p)), 'never the moving bg/<jobname>.pdf alias');
  assert.equal(extractor.calls.length, 1, 'the superseded layout does not extract links');
  assert.equal(extractor.calls[0].file, layoutPdfPath(build, 2));
  assert.equal(extractor.calls[0].expectedPages, 2);
  extractor.calls[0].deferred.resolve([]);
  await tick();
  assert.deepEqual(rec.links.map((l) => l.version), [v2]);
  assert.notEqual(v1, v2, 'display versions are distinct');
  assert.ok(rec.events.indexOf(`layout:${v2}`) < rec.events.indexOf(`links:${v2}`), 'links follow their layout');
});

test('a new layout cancels an in-flight extraction and never posts its result', async () => {
  const build = 'build';
  const rec = emptyRecorder();
  const { host } = hostFor(new Map(), rec);
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController(queue, extractor, host);

  const v1 = controller.submit(snapshot(1, build, 'A'));
  await settle(queue);
  assert.equal(extractor.calls.length, 1);
  const first = extractor.calls[0].deferred;

  const v2 = controller.submit(snapshot(2, build, 'A', 2));
  assert.equal(first.settled, true, 'the old request is cancelled immediately, before its resources');
  await settle(queue);
  assert.equal(extractor.calls.length, 2);
  extractor.calls[1].deferred.resolve([{ page: 1, x: 0.1, y: 0.1, w: 0.2, h: 0.02, target: { kind: 'url', url: 'https://example.com/' } }]);
  await tick();
  assert.deepEqual(rec.links.map((l) => l.version), [v2]);
  assert.notEqual(v1, v2);
});

test('rejected extraction sends no links, legal empty sets clear, distinct errors are logged', async () => {
  const build = 'build';
  const rec = emptyRecorder();
  const { host } = hostFor(new Map(), rec);
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController(queue, extractor, host);

  const v1 = controller.submit(snapshot(1, build, 'A'));
  await settle(queue);
  extractor.calls[0].deferred.reject(new Error('truncated PDF'));
  await tick();
  assert.equal(rec.links.length, 0, 'an incomplete PDF is not an empty link set');
  assert.equal(rec.logs.length, 1);
  assert.match(rec.logs[0], /truncated PDF/);

  controller.submit(snapshot(2, build, 'A', 2));
  await settle(queue);
  extractor.calls[1].deferred.reject(new Error('page count mismatch'));
  await tick();
  assert.equal(rec.links.length, 0);
  assert.equal(rec.logs.length, 2, 'a later, different failure is not swallowed');
  assert.match(rec.logs[1], /page count mismatch/);

  const v3 = controller.submit(snapshot(3, build, 'A', 2));
  await settle(queue);
  extractor.calls[2].deferred.resolve([]);
  await tick();
  assert.deepEqual(rec.links, [{ links: [], version: v3 }], 'a complete PDF without links clears the set');
  assert.notEqual(v1, v3);

  const v4 = controller.submit(snapshot(4, build, 'A', 3));
  await settle(queue);
  controller.submit(snapshot(5, build, 'A', 3));
  await settle(queue);
  extractor.calls[4].deferred.resolve([]);
  await tick();
  assert.deepEqual(rec.links.map((l) => l.version), [v3, 5], 'AbortError is not a user-visible failure');
  assert.equal(rec.logs.length, 2);
  assert.notEqual(v4, 5);
});

test('a resource failure does not drop the incremental page set', async () => {
  const rec = emptyRecorder();
  const errors: string[] = [];
  const layouts: LayoutMessage[] = [];
  const host = {
    async prepare(snap: LayoutSnapshot<string>): Promise<Uint8Array | null> {
      if (snap.engineVersion === 2) throw new Error('font stream failed');
      return null;
    },
    layout(message: LayoutMessage): void {
      layouts.push(message);
      rec.events.push(`layout:${message.layoutVersion}`);
    },
    overlays(): void {},
    links(links: PdfLink[], version: number): void {
      rec.links.push({ links, version });
    },
    log(message: string): void {
      rec.logs.push(message);
    },
    error(message: string): void {
      errors.push(message);
    },
  };
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController<string>(queue, extractor, host);

  controller.submit(snapshot(1, 'build', 'A', 1));
  controller.submit(snapshot(2, 'build', 'A', 2));
  controller.submit(snapshot(3, 'build', 'A', 3));
  await settle(queue);
  assert.deepEqual(layouts.map((l) => l.pages[0].page), [1, 2, 3], 'every pages_changed set reaches the webview');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /font stream failed/);
  assert.equal(extractor.calls.length, 1, 'only the newest layout extracts links');
  assert.equal(extractor.calls[0].file, layoutPdfPath('build', 3));
});

test('reset drops queued layouts and late link results; display versions never restart', async () => {
  const build = 'build';
  const gate = deferred<void>();
  const gates = new Map([[1, gate]]);
  const rec = emptyRecorder();
  const { host } = hostFor(gates, rec);
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController(queue, extractor, host);

  const first = controller.submit(snapshot(1, build, 'A'));
  await tick(); // the old job has started and is waiting for its version PDF
  controller.reset();
  gate.resolve();
  await settle(queue);
  assert.equal(rec.layouts.length, 0, 'a queued layout from before the reset does not reach the webview');
  assert.equal(rec.prepared.length, 1, 'the prepared snapshot was the old one');

  const second = controller.submit(snapshot(1, build, 'B', 2)); // rtex reuses version 1 after a restart
  assert.ok(second > first, 'the webview display version is monotonic across engine restarts');
  await settle(queue);
  assert.equal(rec.layouts.length, 1);
  assert.equal(rec.layouts[0].pagesTotal, 2);
  assert.equal(extractor.calls.length, 1);
  controller.reset();
  extractor.calls[0].deferred.resolve([{ page: 2, x: 0, y: 0, w: 0.1, h: 0.1, target: { kind: 'url', url: 'https://example.com/' } }]);
  await tick();
  assert.equal(rec.links.length, 0, 'a result that arrives after reset is ignored');

  const third = controller.submit(snapshot(1, build, 'B', 2));
  assert.ok(third > second);
  await settle(queue);
  extractor.calls[1].deferred.resolve([]);
  await tick();
  assert.deepEqual(rec.links.map((l) => l.version), [third]);
});

test('dispose releases the extractor and drops everything still in flight', async () => {
  const gate = deferred<void>();
  const gates = new Map([[1, gate]]);
  const rec = emptyRecorder();
  const { host } = hostFor(gates, rec);
  const extractor = new FakeExtractor();
  const queue = new SerialQueue((e) => assert.fail(String(e)));
  const controller = new LayoutLinkController(queue, extractor, host);

  controller.submit(snapshot(1, 'build', 'A'));
  await tick(); // the queued job starts and waits for its resources
  controller.dispose();
  assert.equal(extractor.disposed, 1);
  gate.resolve();
  await settle(queue);
  assert.equal(rec.layouts.length, 0);
  assert.equal(controller.submit(snapshot(2, 'build', 'A', 2)), 0);
  assert.equal(rec.prepared.length, 1);
});

test('replay snapshot is frozen before later model changes', () => {
  const model = new PreviewModel();
  model.applyLayout({
    pages: [page(1), page(2, false)],
    pagesTotal: 2,
    placements: [placement(4, 1)],
    keepFromRevision: null,
  });
  const overlayDl = dl(1);
  const oldFragments = [{ page: 1, first_line: 1, last_line: 1, x: 10, xs: [10], baselines: [100], approximate: false }];
  model.applyParagraph(4, overlayDl, oldFragments, 5);

  const snapshot = captureSnapshot(model, 7, layoutPdfPath('build', 7), 'session-A');
  assert.ok(snapshot);
  assert.equal(snapshot.engineVersion, 7);
  assert.equal(snapshot.pdfPath, layoutPdfPath('build', 7));
  assert.equal(snapshot.pagesTotal, 2);
  assert.deepEqual(snapshot.pages.map((p) => p.page), [1, 2]);
  assert.equal(snapshot.placements.length, 1);
  assert.equal(snapshot.placements[0].lines, 0);
  assert.equal(snapshot.overlays.length, 1);
  assert.deepEqual(snapshot.overlays[0].fragments, oldFragments);
  assert.equal(snapshot.overlays[0].revision, 5);
  assert.equal(snapshot.full, true);
  assert.equal(snapshot.pdfFallback, true);
  assert.equal(snapshot.context, 'session-A');

  // A later layout replaces the model's overlay fragments and page count.
  model.applyLayout({ pages: [page(3)], pagesTotal: 3, placements: [], keepFromRevision: null });
  model.applyParagraph(4, overlayDl, [{ page: 3, first_line: 1, last_line: 1, x: 20, xs: [20], baselines: [200], approximate: false }], 6);
  assert.equal(snapshot.pagesTotal, 2, 'replay still sees the old page count');
  assert.deepEqual(snapshot.pages.map((p) => p.page), [1, 2]);
  assert.deepEqual(snapshot.overlays[0].fragments, oldFragments, 'overlay fragments were copied');
  assert.equal(snapshot.overlays[0].revision, 5);

  const empty = new PreviewModel();
  assert.equal(captureSnapshot(empty, 0, '', null), undefined);
});

test('version PDF paths and complete-file reads are version-bound', async () => {
  const file = layoutPdfPath(path.join('C:', 'build'), 3);
  assert.equal(path.dirname(file), path.join('C:', 'build', 'bg'));
  assert.equal(path.basename(file), 'layout-3.pdf');

  const dir = mkdtempSync(path.join(tmpdir(), 'rtex-layout-links-'));
  try {
    const complete = path.join(dir, 'layout-1.pdf');
    writeFileSync(complete, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
    const data = await readCompletePdf(complete);
    assert.ok(data instanceof Uint8Array && data.length > 0);

    const partial = path.join(dir, 'layout-2.pdf');
    writeFileSync(partial, '%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
    assert.equal(await readCompletePdf(partial), null);

    assert.equal(await readCompletePdf(path.join(dir, 'missing.pdf')), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
