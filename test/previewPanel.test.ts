import assert from 'node:assert/strict';
import Module from 'node:module';
import { test } from 'node:test';
import type { FontResource, ImageResource } from '../src/fontKey';
import type { HostToWebview } from '../src/messages';
import { LayoutLinkController, SerialQueue, type LayoutSnapshot } from '../src/preview/layoutLinks';
import type { DisplayList } from '../src/protocol';
import type { Session, SessionOutput } from '../src/session';

// The bundled production panel requires vscode, which is only available in the extension
// host. Stub that import synchronously and restore Node's loader before running any tests.
const loader = Module as unknown as { _load(request: string, ...args: unknown[]): unknown };
const originalLoad = loader._load;
let PreviewPanel: typeof import('../src/preview/panel').PreviewPanel;
try {
  loader._load = function (request, ...args) {
    return request === 'vscode' ? {} : originalLoad.call(this, request, ...args);
  };
  PreviewPanel = (require('../src/preview/panel') as typeof import('../src/preview/panel')).PreviewPanel;
} finally {
  loader._load = originalLoad;
}

interface PanelProbe {
  queue: SerialQueue;
  sentFonts: Set<string>;
  sentImages: Set<string>;
  missing: Set<string>;
  onOutput(s: Session, output: SessionOutput): void;
  resetPreview(): void;
  prepareLayout(snapshot: LayoutSnapshot<Session>): Promise<Uint8Array | null>;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

const dl: DisplayList = { kind: 'paragraph', fonts: {}, lines: [], other: [], flags: [], width: 0, height: 0, depth: 0 };
const versions = { source_revision: 1, context_revision: 1, engine_generation: 1, layout_version: 1 };
const paragraph: SessionOutput = { kind: 'paragraph', ev: {
  event: 'ParagraphUpdate', par_id: 123, edit_id: 1, versions, status: 'ok', reasons: [], fragments: [],
  pagination_stale: false, context_stale: false, dl, diagnostics: [],
  timing: { total_us: 0, tex_us: 0, traverse_us: 0, pack_us: 0 },
} };
const layout: SessionOutput = { kind: 'layout', pdfPath: 'unused.pdf', keepFromRevision: null, ev: {
  event: 'LayoutUpdate', versions, compile: { state: 'Ok' }, convergence: { state: 'Converged' }, passes: 1,
  pages_changed: [{ page: 1, exact: true, hash: 1, dl }], pages_total: 1, placements: [],
  eligible_paragraphs: [], pdf_fallback: null, wall_ms: 0,
} };

for (const output of [paragraph, layout]) {
  test(`reset during ${output.kind} resource loading discards old messages and resource bookkeeping`, async () => {
    const entered = deferred();
    const release = deferred();
    const messages: HostToWebview[] = [];
    const logs: string[] = [];
    const session = { projectRoot: '' } as Session;
    const queue = new SerialQueue((e) => { throw e; });
    // Skip UI construction, but use the production panel methods, serial queue and layout
    // controller. Only the resource IO, webview transport and link extractor are fake.
    const panel = Object.create(PreviewPanel.prototype) as PanelProbe;
    let oldRequest = true;
    const links = new LayoutLinkController(queue, {
      async extract() { assert.fail('the reset layout must never extract links'); },
      cancel() {}, dispose() {},
    }, {
      prepare: (snapshot: LayoutSnapshot<Session>) => panel.prepareLayout(snapshot),
      layout: (message) => messages.push({ type: 'layout', ...message }),
      overlays() {}, links() { assert.fail('unexpected links'); }, log: (m) => logs.push(m),
    });
    Object.assign(panel, {
      session, queue, links, disposed: false, ready: true, attachmentEpoch: 0,
      sentFonts: new Set<string>(), sentImages: new Set<string>(), missing: new Set<string>(),
      panel: { webview: { postMessage(message: HostToWebview) { messages.push(message); } } },
      host: {
        log: { appendLine(message: string) { logs.push(message); } },
        resources() {
          return {
            async fontsFor(): Promise<Map<string, FontResource>> {
              if (!oldRequest) return new Map([['new-font', { kind: 'sfnt', data: new Uint8Array() }]]);
              entered.resolve();
              await release.promise;
              return new Map([['old-font', { kind: 'missing', reason: 'old font' }]]);
            },
            async imagesFor(): Promise<Map<string, ImageResource>> {
              return oldRequest ? new Map([['old-image', { kind: 'missing', reason: 'old image' }]]) : new Map();
            },
          };
        },
      },
    });
    try {
      panel.onOutput(session, output);
      await entered.promise;
      panel.resetPreview();
      release.resolve();
      await queue.idle();
      assert.deepEqual(messages.map((m) => m.type), ['reset']);
      assert.equal(panel.sentFonts.size, 0);
      assert.equal(panel.sentImages.size, 0);
      assert.equal(panel.missing.size, 0);
      assert.deepEqual(logs, []);

      // The same Session remains attached; fresh work after reset must still be delivered.
      oldRequest = false;
      panel.onOutput(session, paragraph);
      await queue.idle();
      assert.deepEqual(messages.map((m) => m.type), ['reset', 'resources', 'paragraph']);
      assert.deepEqual([...panel.sentFonts], ['new-font']);
    } finally {
      release.resolve();
      links.dispose();
    }
  });
}
