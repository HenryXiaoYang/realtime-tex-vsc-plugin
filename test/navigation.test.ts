import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  anchorPosition, BackMouseHandler, captureAnchor, clampScroll, NavigationHistory, scrollChanged,
  type BackMouseEvent,
} from '../webview/navigation';

test('departures unwind C -> B -> A without recording back navigation', () => {
  const history = new NavigationHistory();
  history.push({ page: 1, x: 0, y: 0.2 });
  history.push({ page: 3, x: 0.1, y: 0.6 }); // user scrolled on B before leaving it
  assert.deepEqual(history.pop(), { page: 3, x: 0.1, y: 0.6 });
  assert.deepEqual(history.pop(), { page: 1, x: 0, y: 0.2 });
  assert.equal(history.pop(), undefined);
});

test('history retains only the most recent 50 departures', () => {
  const history = new NavigationHistory();
  for (let page = 1; page <= 60; page++) history.push({ page, x: 0, y: 0 });
  assert.equal(history.size, 50);
  for (let page = 60; page >= 11; page--) assert.equal(history.pop()?.page, page);
  assert.equal(history.size, 0);
});

test('adjacent duplicates coalesce, while later revisits remain navigable', () => {
  const history = new NavigationHistory();
  const a = { page: 1, x: 0, y: 0.5 };
  history.push(a);
  history.push({ ...a, y: 0.50000001 });
  a.page = 99; // snapshots must not retain mutable caller objects
  history.push({ page: 2, x: 0, y: 0.5 });
  history.push({ page: 1, x: 0, y: 0.5 });
  assert.equal(history.size, 3);
  assert.equal(history.pop()?.page, 1);
  assert.equal(history.pop()?.page, 2);
  assert.equal(history.pop()?.page, 1);
});

test('invalid positions are rejected and removed pages are pruned without clearing valid history', () => {
  const history = new NavigationHistory();
  for (const page of [0, -1, 1.5, NaN, Infinity]) history.push({ page, x: 0, y: 0 });
  history.push({ page: 1, x: Infinity, y: 0 });
  history.push({ page: 1, x: 0, y: NaN });
  assert.equal(history.size, 0);
  for (const page of [1, 4, 2, 5]) history.push({ page, x: 0, y: 0.3 });
  history.prune(2);
  assert.equal(history.pop()?.page, 2);
  assert.equal(history.pop()?.page, 1);
  history.push({ page: 1, x: 0, y: 0 });
  history.clear();
  assert.equal(history.pop(), undefined);
});

test('anchors preserve horizontal position and negative margins across zoom and page-size changes', () => {
  const anchor = captureAnchor(2, { left: 100, top: 900, width: 600, height: 800 }, { left: 220, top: 884 });
  assert.deepEqual(anchor, { page: 2, x: 0.2, y: -0.02 });
  assert.deepEqual(anchorPosition(anchor!, { left: 16, top: 1800, width: 1200, height: 1600 }), { left: 256, top: 1768 });
  assert.deepEqual(anchorPosition(anchor!, { left: 50, top: 700, width: 300, height: 400 }), { left: 110, top: 692 });
});

test('unusable page boxes and non-finite geometry never enter navigation', () => {
  const box = { left: 0, top: 0, width: 600, height: 800 };
  assert.equal(captureAnchor(0, box, { left: 0, top: 0 }), undefined);
  assert.equal(captureAnchor(1, { ...box, height: 0 }, { left: 0, top: 0 }), undefined);
  assert.equal(captureAnchor(1, box, { left: NaN, top: 0 }), undefined);
  assert.equal(anchorPosition({ page: 1, x: Infinity, y: 0 }, box), undefined);
  assert.equal(anchorPosition({ page: 1, x: 0, y: 0 }, { ...box, width: NaN }), undefined);
});

test('clamped document edges and subpixel movements do not count as new jumps', () => {
  assert.deepEqual(clampScroll({ left: -40, top: -100 }, 0, 1000), { left: 0, top: 0 });
  assert.deepEqual(clampScroll({ left: 500, top: 5000 }, 200, 1000), { left: 200, top: 1000 });
  assert.equal(scrollChanged({ left: 0, top: 0 }, clampScroll({ left: -40, top: -100 }, 0, 1000)), false);
  assert.equal(scrollChanged({ left: 10, top: 10 }, { left: 10.5, top: 11 }), false);
  assert.equal(scrollChanged({ left: 10, top: 10 }, { left: 12, top: 10 }), true);
});

function mouse(type: string, button = 3) {
  return {
    type, button, prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  } satisfies BackMouseEvent & { prevented: boolean; stopped: boolean };
}

test('down/up/auxclick performs exactly one back operation, including a held-button repeat', () => {
  let available = 3;
  const handler = new BackMouseHandler(() => available > 0, () => available--);
  for (const type of ['mousedown', 'mousedown', 'mouseup', 'auxclick']) {
    const event = mouse(type);
    handler.handle(event);
    assert.equal(event.prevented, true);
    assert.equal(event.stopped, true);
  }
  assert.equal(available, 2);
  for (const type of ['mousedown', 'mouseup', 'auxclick']) handler.handle(mouse(type));
  assert.equal(available, 1);
});

test('the release and auxclick of the last history entry are still consumed', () => {
  let available = true;
  let calls = 0;
  const handler = new BackMouseHandler(() => available, () => { available = false; calls++; });
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    const event = mouse(type);
    handler.handle(event);
    assert.equal(event.prevented, true, type);
  }
  assert.equal(calls, 1);
  const empty = mouse('mousedown');
  handler.handle(empty);
  assert.equal(empty.prevented, false);
});

test('empty history, forward button and ordinary mouse buttons keep their default behavior', () => {
  const empty = new BackMouseHandler(() => false, () => assert.fail('empty history'));
  const ready = new BackMouseHandler(() => true, () => assert.fail('wrong button'));
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    const event = mouse(type);
    empty.handle(event);
    assert.equal(event.prevented, false);
    for (const button of [0, 1, 2, 4]) {
      const other = mouse(type, button);
      ready.handle(other);
      assert.equal(other.prevented, false);
    }
  }
});

test('auxclick-only delivery works and blur/reset releases the button state', () => {
  let calls = 0;
  const handler = new BackMouseHandler(() => true, () => calls++);
  handler.handle(mouse('auxclick'));
  assert.equal(calls, 1);
  handler.handle(mouse('mousedown'));
  handler.reset();
  handler.handle(mouse('mousedown'));
  handler.handle(mouse('mouseup'));
  handler.handle(mouse('auxclick'));
  assert.equal(calls, 3);
});
