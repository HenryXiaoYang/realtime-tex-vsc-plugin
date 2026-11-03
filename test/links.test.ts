import assert from 'node:assert/strict';
import { mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { PdfLinkExtractor } from '../src/pdfLinks';
import { SP_PER_BP } from '../src/protocol';
import { buildPdf, type FixtureDest } from './pdfFixtures';
import type { Rect } from '../webview/model';
import {
  LinkOverlay,
  linkIsCovered,
  linkRect,
  pdfContentBox,
  targetPoint,
  type LinkDatasetLike,
  type LinkDocumentLike,
  type LinkElementLike,
  type LinkLayerLike,
  type LinkPageState,
  type LinkStyleLike,
  type PdfLinkGeometry,
} from '../webview/links';

const BP = SP_PER_BP;
// A 200 bp × 400 bp TeX page in sp: the display list lives in this full, unrotated box.
const W = 200 * BP;
const H = 400 * BP;

function near(actual: number | undefined, expected: number, what: string): void {
  const tolerance = 1e-9 * Math.max(1, Math.abs(expected));
  assert.ok(actual !== undefined && Math.abs(actual - expected) <= tolerance, `${what}: ${actual} != ${expected}`);
}

function nearRect(actual: Rect | undefined, expected: Rect, what: string): void {
  if (!actual) assert.fail(`${what}: no rectangle`);
  near(actual.x, expected.x, `${what}.x`);
  near(actual.y, expected.y, `${what}.y`);
  near(actual.w, expected.w, `${what}.w`);
  near(actual.h, expected.h, `${what}.h`);
}

const urlLink = (extra: Partial<PdfLinkGeometry> = {}): PdfLinkGeometry => ({
  page: 1,
  x: 0.1,
  y: 0.1,
  w: 0.2,
  h: 0.02,
  target: { kind: 'url', url: 'https://example.com/' },
  ...extra,
});

test('a PDF viewport is fit into the page and anchored top-left, like renderPdfPage', () => {
  // Normal PDF page: the viewport has the page's aspect and fills it.
  nearRect(pdfContentBox(W, H, 0.5), { x: 0, y: 0, w: W, h: H }, 'full page');
  // Rotate90: viewport 2:1 on a 1:2 page -> full width, half height, top-left.
  nearRect(pdfContentBox(W, H, 2), { x: 0, y: 0, w: W, h: W / 2 }, 'wide viewport');
  // CropBox 200×200 on a 200×400 page -> half-width content at the top.
  nearRect(pdfContentBox(W, H, 1), { x: 0, y: 0, w: W, h: W }, 'square viewport');
  // A tall viewport is height-limited.
  nearRect(pdfContentBox(W, H, 0.25), { x: 0, y: 0, w: H / 4, h: H }, 'tall viewport');
  // Missing aspect (old messages) keeps the old full-page geometry.
  nearRect(pdfContentBox(W, H, undefined), { x: 0, y: 0, w: W, h: H }, 'unknown aspect');
  // The scale renderPdfPage uses must be the min(width/vpWidth, height/vpHeight) fit.
  const largeViewport = { w: 400, h: 200 };
  const fit = pdfContentBox(W, H, largeViewport.w / largeViewport.h)!;
  near(fit.w / largeViewport.w, Math.min(W / largeViewport.w, H / largeViewport.h), 'render fit scale');
  const tallViewport = { w: 100, h: 400 };
  const tallFit = pdfContentBox(W, H, tallViewport.w / tallViewport.h)!;
  near(tallFit.w / tallViewport.w, Math.min(W / tallViewport.w, H / tallViewport.h), 'height-limited render fit scale');
});

test('viewport rectangles map through the PDF fit, not over the whole page', () => {
  // CropBox [0 100 200 300] on MediaBox [0 0 200 400]: viewport 200×200.
  // link (0.1, 0.65, 0.5, 0.1) of the viewport lands in the top 200 bp content box.
  nearRect(linkRect(urlLink({ x: 0.1, y: 0.65, w: 0.5, h: 0.1, pageAspect: 1 }), W, H, 'pdf'), { x: 20 * BP, y: 130 * BP, w: 100 * BP, h: 20 * BP }, 'crop viewport');
  // Rotate90 viewport 400×200 on the 200×400 page: full width, 100 bp tall.
  nearRect(linkRect(urlLink({ x: 0.375, y: 0.1, w: 0.05, h: 0.5, pageAspect: 2 }), W, H, 'pdf'), { x: 75 * BP, y: 10 * BP, w: 10 * BP, h: 50 * BP }, 'rotated viewport');
  // The legacy fixture (no pageAspect) is unchanged.
  nearRect(linkRect(urlLink(), W, H), { x: 0.1 * W, y: 0.1 * H, w: 0.2 * W, h: 0.02 * H }, 'legacy');
});

test('display-list pages use raw PDF user space for crop and rotation', () => {
  // CropBox [0 100 200 300], annotation [20 150 120 170] in the unrotated MediaBox.
  const crop = urlLink({ x: 0.1, y: 0.65, w: 0.5, h: 0.1, pageAspect: 1, userRect: [20, 150, 120, 170] });
  nearRect(linkRect(crop, W, H, 'displayList'), { x: 20 * BP, y: 230 * BP, w: 100 * BP, h: 20 * BP }, 'crop display list');
  // Rotate90 changes the viewport but not the user-space rectangle.
  const rot = urlLink({ x: 0.375, y: 0.1, w: 0.05, h: 0.5, pageAspect: 2, userRect: [20, 150, 120, 170] });
  nearRect(linkRect(rot, W, H, 'displayList'), { x: 20 * BP, y: 230 * BP, w: 100 * BP, h: 20 * BP }, 'rotate display list');
  // Without raw geometry, a non-default viewport cannot be placed on the uncropped DL page.
  assert.equal(linkRect(urlLink({ pageAspect: 1 }), W, H, 'displayList'), undefined);
  // ... but a full-page PDF still maps by its viewport fractions.
  nearRect(linkRect(urlLink({ pageAspect: 0.5 }), W, H, 'displayList'), { x: 0.1 * W, y: 0.1 * H, w: 0.2 * W, h: 0.02 * H }, 'default display list');
});

test('occlusion uses the same mapped rectangle as the hotspot', () => {
  // y 0.25 of a 400×200 viewport is 25 bp high in the top-left 200×100 content box, while the
  // old whole-page multiplication would place it at 100 bp.
  const link = urlLink({ x: 0.5, y: 0.25, w: 0.1, h: 0.05, pageAspect: 2 });
  const naive: Rect = { x: 0.5 * W, y: 0.25 * H, w: 0.1 * W, h: 0.05 * H };
  const aroundNaive: Rect = { x: 0.4 * W, y: 0.22 * H, w: 0.3 * W, h: 0.1 * H };
  assert.equal(linkIsCovered(link, W, H, [aroundNaive], 'pdf'), false, 'a stale row over the old geometry does not cover the link');
  const aroundMapped: Rect = { x: 0.4 * W, y: 15 * BP, w: 0.3 * W, h: 30 * BP };
  assert.equal(linkIsCovered(link, W, H, [aroundMapped], 'pdf'), true);
  assert.ok(naive.y > aroundMapped.y + aroundMapped.h, 'the fixture distinguishes the two mappings');
});

test('internal destinations share the PDF fit and prefer raw user space on display lists', () => {
  // CropBox XYZ [20 250] is y=0.25 of a 200 high viewport.
  const crop = { kind: 'page' as const, page: 1, x: 0.1, y: 0.25, pageAspect: 1 };
  const pdfPoint = targetPoint(crop, W, H, 'pdf');
  near(pdfPoint?.x, 20 * BP, 'pdf target x');
  near(pdfPoint?.y, 50 * BP, 'pdf target y');
  const user = { ...crop, userX: 20, userY: 250 };
  const dlPoint = targetPoint(user, W, H, 'displayList');
  near(dlPoint?.x, 20 * BP, 'display-list target x');
  near(dlPoint?.y, 150 * BP, 'display-list target y');
  // FitH names only the top; the missing x follows the PDF convention (left edge).
  const fitH = targetPoint({ kind: 'page', page: 1, x: 0.9, y: 0.25, pageAspect: 1, userY: 250 }, W, H, 'displayList');
  near(fitH?.x, 0, 'FitH target x');
  near(fitH?.y, 150 * BP, 'FitH target y');
  // Rotate90 XYZ [20 150] viewport proportions x=0.375, y=0.1.
  const rot = targetPoint({ kind: 'page', page: 1, x: 0.375, y: 0.1, pageAspect: 2 }, W, H, 'pdf');
  near(rot?.x, 75 * BP, 'rotated target x');
  near(rot?.y, 10 * BP, 'rotated target y');
  // Legacy destination without x or aspect keeps x=0 and the full page height.
  const legacy = targetPoint({ kind: 'page', page: 1, y: 0.5 }, W, H, 'displayList');
  near(legacy?.x, 0, 'legacy target x');
  near(legacy?.y, 0.5 * H, 'legacy target y');
  assert.equal(targetPoint(crop, W, H, 'displayList'), undefined, 'no raw destination for a cropped DL page');
});

// ---------------------------------------------------------------------------------------------
// LinkOverlay with a tiny fake DOM

class FakeStyle implements LinkStyleLike {
  left = '';
  top = '';
  width = '';
  height = '';
}

class FakeLayer implements LinkLayerLike {
  readonly children: FakeNode[] = [];
  appendChild(node: LinkElementLike): void {
    const n = node as FakeNode;
    this.children.push(n);
    n.parent = this;
  }
  remove(node: FakeNode): void {
    const i = this.children.indexOf(node);
    if (i >= 0) this.children.splice(i, 1);
    node.parent = undefined;
  }
}

class FakeNode implements LinkElementLike {
  hidden = true;
  tabIndex = -1;
  className = '';
  title = '';
  readonly style = new FakeStyle();
  readonly dataset: LinkDatasetLike = {};
  readonly attrs = new Map<string, string>();
  parent: FakeLayer | undefined;
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  remove(): void {
    this.parent?.remove(this);
  }
}

class FakeDocument implements LinkDocumentLike {
  created = 0;
  createElement(tag: 'a'): LinkElementLike {
    assert.equal(tag, 'a');
    this.created++;
    return new FakeNode();
  }
}

function overlayFixture(pages: number[] = [1]) {
  const doc = new FakeDocument();
  const layers = new Map<number, FakeLayer>();
  const states = new Map<number, LinkPageState>();
  const stateCalls: number[] = [];
  const frames: (() => void)[] = [];
  for (const n of pages) {
    layers.set(n, new FakeLayer());
    states.set(n, { widthSp: 600, heightSp: 800, fromPdf: false, covered: [] });
  }
  const overlay = new LinkOverlay(
    doc,
    (n) => {
      stateCalls.push(n);
      return states.get(n);
    },
    (n) => layers.get(n),
    (cb) => frames.push(cb),
  );
  const flush = () => {
    while (frames.length) frames.shift()!();
  };
  return { doc, layers, states, stateCalls, frames, overlay, flush };
}

function linksOf(...links: PdfLinkGeometry[]): PdfLinkGeometry[] {
  return links;
}

test('links exist only for visible pages and are created when a page scrolls in', () => {
  const f = overlayFixture([1, 2]);
  f.overlay.beginLayout(1);
  f.overlay.setLinks(linksOf(urlLink({ page: 1 }), urlLink({ page: 2, x: 0.2 })), 1);
  f.overlay.setVisible(1, true);
  f.flush();
  assert.equal(f.layers.get(1)!.children.length, 1);
  assert.equal(f.layers.get(2)!.children.length, 0);
  f.overlay.setVisible(2, true);
  f.flush();
  assert.equal(f.layers.get(2)!.children.length, 1);
  // Drawing one page never asks for the other pages' state or layer.
  f.stateCalls.length = 0;
  f.overlay.invalidate(2);
  f.flush();
  assert.deepEqual(f.stateCalls, [2]);
});

test('paragraph updates keep node identity and only toggle stale links', () => {
  const f = overlayFixture([1]);
  const first = urlLink({ page: 1, x: 0.05, y: 0.1, w: 0.2, h: 0.02 });
  const second = urlLink({ page: 1, x: 0.5, y: 0.6, w: 0.2, h: 0.02 });
  f.overlay.beginLayout(1);
  f.overlay.setLinks(linksOf(first, second), 1);
  f.overlay.setVisible(1, true);
  f.flush();
  const nodes = [...f.layers.get(1)!.children];
  assert.equal(nodes.length, 2);
  assert.equal(f.doc.created, 2);

  const covered: Rect = { x: 0.02 * 600, y: 0.08 * 800, w: 0.3 * 600, h: 0.06 * 800 };
  f.states.set(1, { widthSp: 600, heightSp: 800, fromPdf: false, covered: [covered] });
  f.overlay.invalidate(1);
  f.flush();
  assert.deepEqual(f.layers.get(1)!.children, nodes, 'nodes are reused');
  assert.equal(nodes[0].hidden, true);
  assert.equal(nodes[0].tabIndex, -1);
  assert.equal(nodes[0].attrs.get('aria-hidden'), 'true');
  assert.equal(nodes[1].hidden, false);
  assert.equal(nodes[1].tabIndex, 0);

  f.states.set(1, { widthSp: 600, heightSp: 800, fromPdf: false, covered: [] });
  f.overlay.invalidate(1);
  f.flush();
  assert.deepEqual(f.layers.get(1)!.children, nodes);
  assert.equal(nodes[0].hidden, false);
  assert.equal(nodes[0].tabIndex, 0);
  assert.equal(f.doc.created, 2, 'unrelated updates never recreate links');
});

test('a new layout clears old links and links of another version are ignored', () => {
  const f = overlayFixture([1]);
  f.overlay.beginLayout(1);
  f.overlay.setLinks(linksOf(urlLink()), 1);
  f.overlay.setVisible(1, true);
  f.flush();
  assert.equal(f.layers.get(1)!.children.length, 1);

  f.overlay.beginLayout(2);
  assert.equal(f.layers.get(1)!.children.length, 0, 'old hotspots disappear with the new layout');
  assert.equal(f.overlay.setLinks(linksOf(urlLink()), 1), false);
  f.flush();
  assert.equal(f.layers.get(1)!.children.length, 0);
  assert.equal(f.overlay.setLinks(linksOf(urlLink({ x: 0.3 })), 2), true);
  f.flush();
  assert.equal(f.layers.get(1)!.children.length, 1);
});

test('a valid empty link set clears the same layout; zoom reuses nodes', () => {
  const f = overlayFixture([1]);
  f.overlay.beginLayout(3);
  f.overlay.setLinks(linksOf(urlLink()), 3);
  f.overlay.setVisible(1, true);
  f.flush();
  const node = f.layers.get(1)!.children[0];
  near(parseFloat(node.style.left), 10, 'initial left percentage');

  // Zoom/resize keeps the page's aspect and only changes its pixel size.
  f.states.set(1, { widthSp: 300, heightSp: 400, fromPdf: false, covered: [] });
  f.overlay.invalidate(1);
  f.flush();
  assert.equal(f.layers.get(1)!.children[0], node, 'zoom does not rebuild the node');
  assert.equal(f.doc.created, 1);
  near(parseFloat(node.style.left), 10, 'hotspots stay percentages of the page');

  f.overlay.setLinks([], 3);
  f.flush();
  assert.equal(f.layers.get(1)!.children.length, 0);
});

test('dirty link updates coalesce into one frame', () => {
  const f = overlayFixture([1]);
  f.overlay.beginLayout(1);
  f.overlay.setLinks(linksOf(urlLink()), 1);
  f.overlay.setVisible(1, true);
  f.flush();
  assert.equal(f.frames.length, 0);
  f.overlay.invalidate(1);
  f.overlay.invalidate(1);
  f.overlay.invalidate(1);
  assert.equal(f.frames.length, 1);
  f.flush();
  assert.equal(f.frames.length, 0);
});

test('page links expose x, aspect and raw user coordinates', () => {
  const f = overlayFixture([1]);
  const link: PdfLinkGeometry = {
    page: 1,
    x: 0.1,
    y: 0.2,
    w: 0.2,
    h: 0.05,
    pageAspect: 2,
    target: { kind: 'page', page: 2, x: 0.25, y: 0.5, pageAspect: 1, userX: 20, userY: 250 },
  };
  f.overlay.beginLayout(1);
  f.overlay.setLinks([link], 1);
  f.overlay.setVisible(1, true);
  f.flush();
  const node = f.layers.get(1)!.children[0];
  assert.equal(node.dataset.page, '2');
  assert.equal(node.dataset.x, '0.25');
  assert.equal(node.dataset.y, '0.5');
  assert.equal(node.dataset.aspect, '1');
  assert.equal(node.dataset.userX, '20');
  assert.equal(node.dataset.userY, '250');
  assert.equal(node.attrs.get('aria-label'), 'Go to page 2');
});

test('single-axis PDF destinations survive DOM updates and map to display-list coordinates', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rtex-link-axis-'));
  const file = path.join(dir, 'destinations.pdf');
  const extractor = new PdfLinkExtractor();
  const destinations: FixtureDest[] = [
    [2, 'XYZ', 20, 250, null],
    [2, 'FitH', 250],
    [2, 'FitBH', 250],
    [2, 'FitV', 20],
    [2, 'FitBV', 20],
    [2, 'XYZ', null, 250, null],
    [2, 'XYZ', 20, null, null],
    [2, 'Fit'],
  ];
  try {
    for (const rotate of [0, 90]) {
      writeFileSync(file, buildPdf({ pages: [
        { links: destinations.map((dest, i) => ({ rect: [10, 20 + i * 30, 100, 40 + i * 30], dest })) },
        { mediaBox: [0, 0, 200, 400], cropBox: [0, 100, 200, 300], rotate },
      ] }));
      const links = await extractor.extract(file, 2);
      assert.equal(links.length, destinations.length);
      const f = overlayFixture();
      f.overlay.beginLayout(1);
      f.overlay.setVisible(1, true);
      // Reuse one node through both-axis, single-axis and no-axis targets, so obsolete
      // dataset coordinates must be removed as well as current coordinates preserved.
      for (const link of links) {
        if (link.target.kind !== 'page') assert.fail('expected a page destination');
        f.overlay.setLinks([link], 1);
        f.flush();
        const { dataset } = f.layers.get(1)!.children[0];
        assert.equal(dataset.userX, link.target.userX === undefined ? undefined : String(link.target.userX));
        assert.equal(dataset.userY, link.target.userY === undefined ? undefined : String(link.target.userY));
        if (link.target.userX === undefined && link.target.userY === undefined) continue;
        const point = targetPoint({
          kind: 'page', page: Number(dataset.page), x: Number(dataset.x), y: Number(dataset.y),
          pageAspect: Number(dataset.aspect),
          userX: dataset.userX === undefined ? undefined : Number(dataset.userX),
          userY: dataset.userY === undefined ? undefined : Number(dataset.userY),
        }, W, H, 'displayList');
        near(point?.x, link.target.userX === undefined ? 0 : 20 * BP, 'clicked target x');
        near(point?.y, link.target.userY === undefined ? 0 : 150 * BP, 'clicked target y');
      }
    }
  } finally {
    extractor.dispose();
    unlinkSync(file);
    rmdirSync(dir);
  }
});

test('external links keep the URL in the dataset and stay keyboard reachable', () => {
  const f = overlayFixture([1]);
  f.overlay.beginLayout(1);
  f.overlay.setLinks(linksOf(urlLink()), 1);
  f.overlay.setVisible(1, true);
  f.flush();
  const node = f.layers.get(1)!.children[0];
  assert.equal(node.dataset.url, 'https://example.com/');
  assert.equal(node.dataset.page, undefined);
  assert.equal(node.tabIndex, 0);
  assert.equal(node.attrs.get('role'), 'link');
  assert.equal(node.attrs.get('aria-label'), 'Open https://example.com/');
  assert.equal(node.hidden, false);
});

test('legacy full-page fixtures keep the old rectangles', () => {
  const link = urlLink();
  nearRect(linkRect(link, 600, 800), { x: 60, y: 80, w: 120, h: 16 }, 'legacy geometry');
});
