import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  destinationPoint,
  destinationUserPoint,
  destinationY,
  rectFractions,
  safeLinkUrl,
  viewAspect,
} from '../src/pdfLinks';
import type { ViewportLike } from '../src/pdfLinkCore';

/** The same unrotated 200x400 viewport mapping pdf.js uses for /Rotate 0. */
const viewport: ViewportLike = {
  width: 200,
  height: 400,
  convertToViewportPoint(x, y) {
    return [x, 400 - y];
  },
  convertToViewportRectangle(rect) {
    return [rect[0], 400 - rect[1], rect[2], 400 - rect[3]];
  },
  convertToPdfPoint(x, y) {
    return [x, 400 - y];
  },
};

const ref = { num: 1, gen: 0 };

test('only web and mail links are opened', () => {
  assert.equal(safeLinkUrl('https://example.com/a?b=1&c=2'), 'https://example.com/a?b=1&c=2');
  assert.equal(safeLinkUrl('http://example.com/'), 'http://example.com/');
  assert.equal(safeLinkUrl('mailto:clemens@example.com'), 'mailto:clemens@example.com');
  // a PDF can name any action; these never reach the browser or the shell
  assert.equal(safeLinkUrl('javascript:alert(1)'), undefined);
  assert.equal(safeLinkUrl('file:///C:/Windows/System32/calc.exe'), undefined);
  assert.equal(safeLinkUrl('data:text/html,hi'), undefined);
  assert.equal(safeLinkUrl('ftp://example.com/file'), undefined);
  assert.equal(safeLinkUrl('/relative/path'), undefined);
  assert.equal(safeLinkUrl('not a url'), undefined);
});

test('annotation rectangles become page fractions', () => {
  // the fractions are computed as right-left, so expect the same floating-point expression
  const expected = { x: 100 / 600, y: 200 / 800, w: 300 / 600 - 100 / 600, h: 250 / 800 - 200 / 800 };
  assert.deepEqual(rectFractions(100, 200, 300, 250, 600, 800), expected);
  // corners in any order, and anything outside the page is clipped
  assert.deepEqual(rectFractions(300, 250, 100, 200, 600, 800), expected);
  assert.deepEqual(rectFractions(-100, -100, 700, 900, 600, 800), { x: 0, y: 0, w: 1, h: 1 });
  assert.equal(rectFractions(10, 10, 10, 20, 600, 800), undefined);
  assert.equal(rectFractions(10, 10, 20, 20, 0, 800), undefined);
  assert.equal(rectFractions(Number.NaN, 10, 20, 20, 600, 800), undefined);
});

test('the legacy destinationY helper still reports the vertical fraction', () => {
  assert.equal(destinationY([ref, { name: 'XYZ' }, 0, 667.198, null], 792), 1 - 667.198 / 792);
  assert.equal(destinationY([ref, { name: 'FitH' }, 400], 800), 0.5);
  assert.equal(destinationY([ref, { name: 'FitR' }, 0, 0, 600, 200], 800), 0.75);
  assert.equal(destinationY([ref, { name: 'Fit' }], 800), 0);
  assert.equal(destinationY([ref, { name: 'XYZ' }, 0, null, null], 800), 0);
});

test('destinationPoint handles every destination kind, including null and unknown', () => {
  const point = (dest: unknown[]) => destinationPoint(dest, viewport);
  assert.deepEqual(point([ref, { name: 'XYZ' }, 20, 150, null]), { x: 0.1, y: 0.625 });
  assert.deepEqual(point([ref, { name: 'XYZ' }, null, 100, null]), { x: 0, y: 0.75 });
  assert.deepEqual(point([ref, { name: 'XYZ' }, 20, null, null]), { x: 0.1, y: 0 });
  assert.deepEqual(point([ref, { name: 'XYZ' }, null, null, null]), { x: 0, y: 0 });
  assert.deepEqual(point([ref, { name: 'FitH' }, 150]), { x: 0, y: 0.625 });
  assert.deepEqual(point([ref, { name: 'FitBH' }, 200]), { x: 0, y: 0.5 });
  assert.deepEqual(point([ref, { name: 'FitV' }, 20]), { x: 0.1, y: 0 });
  assert.deepEqual(point([ref, { name: 'FitBV' }, 100]), { x: 0.5, y: 0 });
  assert.deepEqual(point([ref, { name: 'FitR' }, 10, 50, 100, 150]), { x: 0.05, y: 0.625 });
  assert.deepEqual(point([ref, { name: 'Fit' }]), { x: 0, y: 0 });
  assert.deepEqual(point([ref, { name: 'FitB' }]), { x: 0, y: 0 });
  assert.deepEqual(point([ref, { name: 'UnknownKind' }]), { x: 0, y: 0 });
  assert.equal(point([]), undefined);
  assert.equal(destinationPoint([ref, { name: 'XYZ' }, 0, 0, null], { ...viewport, width: 0 }), undefined);
});

test('destinationUserPoint keeps raw PDF coordinates for display-list mapping', () => {
  assert.deepEqual(destinationUserPoint([ref, { name: 'XYZ' }, 20, 150, null]), { x: 20, y: 150 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'XYZ' }, null, 100, null]), { y: 100 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'XYZ' }, 20, null, null]), { x: 20 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'FitH' }, 150]), { y: 150 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'FitBH' }, 200]), { y: 200 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'FitV' }, 20]), { x: 20 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'FitBV' }, 100]), { x: 100 });
  assert.deepEqual(destinationUserPoint([ref, { name: 'FitR' }, 100, 50, 10, 150]), { x: 10, y: 150 });
  assert.equal(destinationUserPoint([ref, { name: 'Fit' }]), undefined);
  assert.equal(destinationUserPoint([ref, { name: 'FitB' }]), undefined);
  assert.equal(destinationUserPoint([ref, { name: 'UnknownKind' }]), undefined);
  assert.equal(destinationUserPoint([]), undefined);
});

test('viewAspect rejects unusable page boxes', () => {
  assert.equal(viewAspect({ width: 200, height: 400 }), 0.5);
  assert.equal(viewAspect({ width: 0, height: 400 }), undefined);
  assert.equal(viewAspect({ width: 200, height: Number.NaN }), undefined);
});
