// The live preview webview: toolbar, guided state screens, lazily rendered pages.
import type { Action, HostToWebview, PillKind, ScreenKind, WebviewToHost } from '../src/messages';
import { SP_PER_BP } from '../src/protocol';
import { cachedPictureMoves, PreviewModel, Rect } from './model';
import { initPdfWorker, openPdf, PdfDoc, rasterizePdfImage, renderPdfPage } from './pdf';
import { FontStore, ImageStore, inexactReason, Mat, Painter } from './render';

interface VsCodeApi {
  postMessage(m: WebviewToHost): void;
  getState(): SavedState | undefined;
  setState(s: SavedState): void;
}
interface SavedState {
  zoom: string;
  scrollTop?: number;
}
interface Boot {
  workerUrl: string;
  zoom: string;
  follow: boolean;
  invert: boolean;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const boot: Boot = JSON.parse(document.getElementById('rtex-boot')!.textContent!);
void initPdfWorker(boot.workerUrl);

const model = new PreviewModel();
const fonts = new FontStore();
const images = new ImageStore(rasterizePdfImage);
let pdfDoc: PdfDoc | undefined;
let pdfPages = 0;
/** Serial of the loaded PDF, and per page the serial of the PDF that matches its current
 * display list (Infinity: no PDF came with the layout that last changed the page). */
let pdfSerialLoaded = 0;
const pagePdfSerial = new Map<number, number>();

// ---------------------------------------------------------------------------------------------
// DOM

const ICONS = {
  refresh:
    '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M12.6 1.5v3.4H9.2" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  export:
    '<svg viewBox="0 0 16 16"><path d="M8 1.5v8.5M4.5 6.8 8 10.3l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M2.5 11v3h11v-3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  minus: '<svg viewBox="0 0 16 16"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5"/></svg>',
  plus: '<svg viewBox="0 0 16 16"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.5"/></svg>',
  fit: '<svg viewBox="0 0 16 16"><path d="M1.5 8h13M4 5.5 1.5 8 4 10.5M12 5.5 14.5 8 12 10.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  follow:
    '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5.2" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5"/></svg>',
};

document.body.innerHTML = `
<header class="toolbar" role="toolbar" aria-label="Preview toolbar">
  <button id="pill" class="pill idle" title="" hidden></button>
  <span id="pageNo" class="page-no" title="Current page"></span>
  <span class="spacer"></span>
  <div class="group" role="group" aria-label="Zoom">
    <button id="zoomOut" class="icon" title="Zoom out (Ctrl+−)" aria-label="Zoom out">${ICONS.minus}</button>
    <button id="zoomLabel" class="zoom-label" title="Reset zoom to 100 % (Ctrl+0)">100 %</button>
    <button id="zoomIn" class="icon" title="Zoom in (Ctrl+=)" aria-label="Zoom in">${ICONS.plus}</button>
    <button id="fit" class="labeled" title="Fit the page width to the panel">${ICONS.fit}<span>Fit width</span></button>
  </div>
  <button id="follow" class="labeled toggle" aria-pressed="false" title="Scroll the preview to the paragraph you are editing">${ICONS.follow}<span>Follow cursor</span></button>
  <button id="recompile" class="labeled" title="Recompile the whole document now (references, page breaks, bibliography)">${ICONS.refresh}<span>Recompile</span></button>
  <button id="export" class="labeled primary" title="Export a PDF of the document (Ctrl+Alt+E)">${ICONS.export}<span>Export PDF</span></button>
</header>
<div id="banner" class="banner" hidden><span class="text"></span><span class="actions"></span><button class="icon close" title="Dismiss" aria-label="Dismiss">${ICONS.close}</button></div>
<main id="viewport" tabindex="0" aria-label="Document pages"><div id="pages"></div></main>
<section id="screen" class="screen" hidden>
  <div class="card">
    <div class="spinner" aria-hidden="true"></div>
    <h2 class="title"></h2>
    <p class="message"></p>
    <pre class="detail" hidden></pre>
    <div class="actions"></div>
  </div>
</section>
<div id="toast" class="toast" hidden role="status"></div>
`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const viewport = $<HTMLElement>('viewport');
const pagesEl = $<HTMLElement>('pages');
const pill = $<HTMLButtonElement>('pill');
const pageNo = $<HTMLElement>('pageNo');
const zoomLabel = $<HTMLButtonElement>('zoomLabel');
const followBtn = $<HTMLButtonElement>('follow');
const screen = $<HTMLElement>('screen');
const banner = $<HTMLElement>('banner');
const toast = $<HTMLElement>('toast');

// Toolbar: drop button labels, then secondary items, when the panel is too narrow for one row
const toolbar = document.querySelector<HTMLElement>('.toolbar')!;
function fitToolbar(): void {
  toolbar.classList.remove('compact', 'tiny');
  const oneRow = () => toolbar.scrollHeight <= 44;
  if (!oneRow()) toolbar.classList.add('compact');
  if (!oneRow()) toolbar.classList.add('tiny');
  document.documentElement.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`);
}
// labels (zoom, page number) change width as well: refit whenever the toolbar resizes; the
// fit is deterministic, so this settles after one round
let fitting = false;
new ResizeObserver(() => {
  if (fitting) return;
  fitting = true;
  fitToolbar();
  requestAnimationFrame(() => (fitting = false));
}).observe(toolbar);
window.addEventListener('resize', fitToolbar);

const post = (m: WebviewToHost) => vscode.postMessage(m);
const runCommand = (command: string, args?: unknown[]) => post({ type: 'command', command, args });

// ---------------------------------------------------------------------------------------------
// Zoom and geometry

const saved = vscode.getState();
let zoom: string = saved?.zoom ?? boot.zoom; // 'fitWidth' or a percentage
const ZOOM_STEPS = [25, 33, 50, 67, 75, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];
const PAGE_GAP = 16;
const PX_PER_BP = 96 / 72;

function maxPageWidth(): number {
  let w = 0;
  for (const p of model.pages.values()) w = Math.max(w, p.dl.page_width ?? 0);
  return w || 597.5 * SP_PER_BP; // A4
}

/** CSS px per sp. */
function cssScale(): number {
  if (zoom === 'fitWidth') {
    const avail = Math.max(120, viewport.clientWidth - 2 * PAGE_GAP);
    return avail / maxPageWidth();
  }
  return ((Number(zoom) || 100) / 100) * (PX_PER_BP / SP_PER_BP);
}

function zoomPercent(): number {
  return Math.round((cssScale() * SP_PER_BP * 100) / PX_PER_BP);
}

function setZoom(z: string): void {
  const anchor = scrollAnchor();
  zoom = z;
  vscode.setState({ zoom });
  layoutPages();
  restoreAnchor(anchor);
}

function stepZoom(dir: 1 | -1): void {
  const cur = zoomPercent();
  const next = dir > 0 ? ZOOM_STEPS.find((s) => s > cur + 0.5) : [...ZOOM_STEPS].reverse().find((s) => s < cur - 0.5);
  setZoom(String(next ?? (dir > 0 ? ZOOM_STEPS[ZOOM_STEPS.length - 1] : ZOOM_STEPS[0])));
}

function scrollAnchor(): { page: number; frac: number } {
  const els = pageEls();
  const top = viewport.scrollTop;
  for (let i = 0; i < els.length; i++) {
    const el = els[i];
    if (el.offsetTop + el.offsetHeight > top) return { page: i, frac: (top - el.offsetTop) / Math.max(1, el.offsetHeight) };
  }
  return { page: 0, frac: 0 };
}

function restoreAnchor(a: { page: number; frac: number }): void {
  const el = pageEls()[a.page];
  if (el) viewport.scrollTop = el.offsetTop + a.frac * el.offsetHeight;
}

// ---------------------------------------------------------------------------------------------
// Pages

const dirty = new Set<number>();
const visible = new Set<number>();
const renderToken = new Map<number, number>();
let renderScheduled = false;

const observer = new IntersectionObserver(
  (entries) => {
    for (const e of entries) {
      const n = Number((e.target as HTMLElement).dataset.page);
      if (e.isIntersecting) visible.add(n);
      else visible.delete(n);
    }
    scheduleRender();
    updatePageNo();
  },
  { root: viewport, rootMargin: '100% 0px' },
);

function pageEls(): HTMLElement[] {
  return Array.from(pagesEl.children) as HTMLElement[];
}

function pageSizeSp(n: number): [number, number] {
  const p = model.pages.get(n) ?? model.pages.get(1) ?? [...model.pages.values()][0];
  return [p?.dl.page_width ?? 597.5 * SP_PER_BP, p?.dl.page_height ?? 845 * SP_PER_BP];
}

/** Create/remove page elements to match the model and size them for the current zoom. */
function layoutPages(): void {
  const els = pageEls();
  for (let i = els.length; i < model.pagesTotal; i++) {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = String(i + 1);
    el.innerHTML = '<canvas></canvas><span class="badge" hidden></span>';
    el.title = '';
    pagesEl.appendChild(el);
    observer.observe(el);
  }
  for (let i = els.length - 1; i >= model.pagesTotal; i--) {
    observer.unobserve(els[i]);
    els[i].remove();
    visible.delete(i + 1);
  }
  const k = cssScale();
  pageEls().forEach((el, i) => {
    const [w, h] = pageSizeSp(i + 1);
    el.style.width = `${Math.round(w * k)}px`;
    el.style.height = `${Math.round(h * k)}px`;
    dirty.add(i + 1);
  });
  zoomLabel.textContent = zoom === 'fitWidth' ? `${zoomPercent()} %` : `${zoom} %`;
  $<HTMLButtonElement>('fit').classList.toggle('active', zoom === 'fitWidth');
  scheduleRender();
}

function markDirty(pages: Iterable<number>): void {
  for (const n of pages) dirty.add(n);
  scheduleRender();
}

function scheduleRender(): void {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    renderScheduled = false;
    for (const n of [...dirty]) {
      if (!visible.has(n)) continue;
      dirty.delete(n);
      void renderPage(n);
    }
  });
}

async function renderPage(n: number): Promise<void> {
  const el = pageEls()[n - 1];
  const pu = model.pages.get(n);
  if (!el || !pu) return;
  const token = (renderToken.get(n) ?? 0) + 1;
  renderToken.set(n, token);
  const k = cssScale();
  const dpr = window.devicePixelRatio || 1;
  const [wSp, hSp] = pageSizeSp(n);
  const w = Math.max(1, Math.round(wSp * k * dpr));
  const h = Math.max(1, Math.round(hSp * k * dpr));
  // draw off-screen, then swap: no flicker while a PDF page renders
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  const base: Mat = [k * dpr, 0, 0, k * dpr, 0, 0];

  const hidden = model.hiddenLines(n);
  const lines = pu.dl.lines.filter((_, i) => !hidden.has(i));
  const reason = pu.exact ? inexactReason(pu.dl, fonts, images, lines) : 'contains material the live renderer cannot draw (e.g. TikZ)';
  const usePdf = reason !== undefined && pdfDoc !== undefined && n <= pdfPages;
  const doc = pdfDoc;
  const drawDisplayList = () => {
    const p = new Painter(ctx, base, fonts, images);
    p.draw(pu.dl, pu.dl.other ?? []);
    for (const line of lines) p.draw(pu.dl, line.items);
  };
  let pdfFailed = false;
  const overlays = model.overlaysOn(n);
  // cached TikZ pictures inside live units: their pixels as the page shows them, taken before
  // anything is cleared and put back where the live rows place them. Only from the PDF of this
  // page's current layout: an older PDF has other content at the picture's rectangle.
  let pictureSnaps: { img: ImageData; dst: Rect }[] = [];
  if (usePdf && doc) {
    try {
      await renderPdfPage(doc, n, ctx, w, h);
    } catch (e) {
      // a PDF problem shows the page's text (approximately) rather than a blank page
      pdfFailed = true;
      post({ type: 'log', message: `pdf page ${n}: ${String(e)}` });
    }
    if (renderToken.get(n) !== token) return;
    if (!pdfFailed && pdfSerialLoaded >= (pagePdfSerial.get(n) ?? 0)) {
      pictureSnaps = overlays.flatMap(({ overlay, rows }) =>
        cachedPictureMoves(pu.dl, rows, model.ownLines(n, overlay.parId)).flatMap(({ src, dst }) => {
          const img = grabRect(ctx, base, src);
          return img ? [{ img, dst }] : [];
        }),
      );
    }
    if (pdfFailed) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      drawDisplayList();
    } else {
      new Painter(ctx, base, fonts, images).clearLines(
        pu.dl.lines.filter((_, i) => hidden.has(i)).map((line) => ({ line, dx: 0, dy: 0 })),
        '#fff',
      );
    }
  } else {
    drawDisplayList();
  }
  // live units: clear the bands their rows occupy now (they may reach into following material
  // until the next layout), put their cached pictures back, then draw their rows, so a picture
  // never covers live text and no clear erases a picture already placed
  const painters = overlays.map(() => new Painter(ctx, base, fonts, images));
  overlays.forEach(({ rows }, i) => painters[i].clearRects(rowBands(rows), '#fff'));
  for (const { img, dst } of pictureSnaps) putRect(ctx, base, img, dst);
  overlays.forEach(({ overlay, rows }, i) => {
    painters[i].draw(overlay.dl, overlay.dl.other ?? []);
    for (const r of rows) painters[i].draw(overlay.dl, r.line.items, r.dx, r.dy);
  });
  if (renderToken.get(n) !== token) return;
  const old = el.querySelector('canvas')!;
  canvas.style.width = el.style.width;
  canvas.style.height = el.style.height;
  el.replaceChild(canvas, old);
  const badge = el.querySelector<HTMLElement>('.badge')!;
  if (usePdf && !pdfFailed) {
    badge.hidden = false;
    badge.textContent = 'from PDF';
    badge.title = `This page is shown from the last full compile because it ${reason}. Edits on it appear after the next full compile (a second or two).`;
  } else if (reason && reason !== 'fonts are loading' && reason !== 'images are loading') {
    badge.hidden = false;
    badge.textContent = 'approximate';
    badge.title = `Parts of this page are approximated: ${reason}.`;
  } else {
    badge.hidden = true;
  }
}

const PT = 65536;

/** Device-pixel rectangle of an sp rectangle under the page's base matrix (scale only). */
function deviceRect(base: Mat, r: Rect): [number, number, number, number] {
  const x = Math.round(r.x * base[0] + base[4]);
  const y = Math.round(r.y * base[3] + base[5]);
  return [x, y, Math.max(0, Math.round((r.x + r.w) * base[0] + base[4]) - x), Math.max(0, Math.round((r.y + r.h) * base[3] + base[5]) - y)];
}

/** The pixels of `r` (sp) on the canvas, or undefined when it is empty or off the canvas. */
function grabRect(ctx: CanvasRenderingContext2D, base: Mat, r: Rect): ImageData | undefined {
  const [x, y, w, h] = deviceRect(base, r);
  if (w < 1 || h < 1 || x >= ctx.canvas.width || y >= ctx.canvas.height || x + w <= 0 || y + h <= 0) return undefined;
  return ctx.getImageData(x, y, w, h);
}

/** Put pixels taken by grabRect at the top-left of `r` (sp); putImageData ignores the transform. */
function putRect(ctx: CanvasRenderingContext2D, base: Mat, img: ImageData, r: Rect): void {
  const [x, y] = deviceRect(base, r);
  ctx.putImageData(img, x, y);
}

/** Rectangles [x0, y0, x1, y1] (sp) covering each overlay row and the gap above it. */
function rowBands(rows: { line: { x: number; y: number; w: number; h: number; d: number }; dx: number; dy: number }[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  let prevBottom: number | undefined;
  let prevBase = -Infinity;
  for (const { line, dx, dy } of rows) {
    const base = line.y + dy;
    const ownTop = base - line.h - PT;
    const top = prevBottom !== undefined && base > prevBase && base - prevBase < 4 * (line.h + line.d + 2 * PT) ? Math.min(ownTop, prevBottom) : ownTop;
    const bottom = base + Math.max(line.d, 3 * PT);
    out.push([line.x + dx - PT, top, line.x + dx + line.w + PT, bottom]);
    prevBottom = bottom;
    prevBase = base;
  }
  return out;
}

function updatePageNo(): void {
  if (!model.pagesTotal) {
    pageNo.textContent = '';
    return;
  }
  const mid = viewport.scrollTop + viewport.clientHeight / 2;
  const els = pageEls();
  let cur = 1;
  for (let i = 0; i < els.length; i++) {
    if (els[i].offsetTop <= mid) cur = i + 1;
  }
  pageNo.textContent = `Page ${cur} of ${model.pagesTotal}`;
}

// ---------------------------------------------------------------------------------------------
// Screens, banner, status, toast

const SCREEN_DEFAULT_TITLES: Record<ScreenKind, string> = {
  starting: 'Starting the LaTeX engine…',
  compiling: 'Typesetting your document…',
  error: 'Something went wrong',
  noMain: 'Which file is the main document?',
  notInstalled: 'The rtex engine is not installed',
  stopped: 'The live preview is paused',
  unsupported: 'This platform is not supported',
};

function renderActions(container: HTMLElement, actions: Action[] | undefined): void {
  container.innerHTML = '';
  for (const a of actions ?? []) {
    const b = document.createElement('button');
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.addEventListener('click', () => runCommand(a.command, a.args));
    container.appendChild(b);
  }
}

function showScreen(m: Extract<HostToWebview, { type: 'screen' }>): void {
  if (!m.screen) {
    screen.hidden = true;
    setHasDocument(model.hasLayout);
    return;
  }
  // with pages on screen, problems are shown as a banner instead of hiding the document
  if (model.hasLayout && (m.screen === 'error' || m.screen === 'compiling' || m.screen === 'starting')) {
    screen.hidden = true;
    if (m.screen === 'error') showBanner({ type: 'banner', text: `${m.title ?? 'Error'}: ${m.message ?? ''}`, kind: 'error', actions: m.actions });
    return;
  }
  screen.hidden = false;
  setHasDocument(false);
  screen.dataset.kind = m.screen;
  screen.querySelector('.spinner')!.toggleAttribute('hidden', !(m.screen === 'starting' || m.screen === 'compiling'));
  screen.querySelector('.title')!.textContent = m.title ?? SCREEN_DEFAULT_TITLES[m.screen];
  screen.querySelector('.message')!.textContent = m.message ?? '';
  const detail = screen.querySelector<HTMLElement>('.detail')!;
  detail.hidden = !m.detail;
  detail.textContent = m.detail ?? '';
  renderActions(screen.querySelector('.actions')!, m.actions);
}

/** Zoom, follow, recompile and export only mean something once pages are shown. */
function setHasDocument(v: boolean): void {
  if (document.body.classList.contains('has-doc') === v) return;
  document.body.classList.toggle('has-doc', v);
  fitToolbar();
}

function showBanner(m: Extract<HostToWebview, { type: 'banner' }>): void {
  if (!m.text) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.className = `banner ${m.kind ?? 'info'}`;
  banner.querySelector('.text')!.textContent = m.text;
  renderActions(banner.querySelector('.actions')!, m.actions);
}
banner.querySelector('.close')!.addEventListener('click', () => (banner.hidden = true));

let pillKind: PillKind = 'idle';
function showStatus(text: string, kind: PillKind, tooltip: string): void {
  pill.hidden = false;
  pill.textContent = text;
  pill.className = `pill ${kind}`;
  pill.title = tooltip;
  pillKind = kind;
}
pill.addEventListener('click', () => runCommand(pillKind === 'error' || pillKind === 'warn' ? 'workbench.actions.view.problems' : 'realtimeTex.showLog'));

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function showToast(text: string, ms = 6000): void {
  toast.textContent = text;
  toast.hidden = false;
  toast.style.top = `${toolbar.offsetHeight + (banner.hidden ? 0 : banner.offsetHeight + 8) + 10}px`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}
toast.addEventListener('click', () => (toast.hidden = true));

// ---------------------------------------------------------------------------------------------
// Sync

let follow = boot.follow;
function setFollowUi(v: boolean): void {
  follow = v;
  followBtn.classList.toggle('active', v);
  followBtn.setAttribute('aria-pressed', String(v));
}
setFollowUi(follow);

function reveal(page: number, x: number, y: number, force: boolean): void {
  const el = pageEls()[page - 1];
  if (!el) return;
  const k = cssScale();
  const top = el.offsetTop + y * k;
  const vTop = viewport.scrollTop;
  const vh = viewport.clientHeight;
  const inView = top > vTop + vh * 0.15 && top < vTop + vh * 0.85;
  if (!force && !follow) return;
  if (force || !inView) viewport.scrollTo({ top: top - vh * 0.35, behavior: force ? 'smooth' : 'auto' });
  const left = el.offsetLeft + x * k;
  if (left < viewport.scrollLeft || left > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = left - 40;
  if (force) {
    const marker = document.createElement('div');
    marker.className = 'marker';
    const [wSp] = pageSizeSp(page);
    marker.style.left = `${x * k - 6}px`;
    marker.style.width = `${Math.max(40, (wSp - 2 * x) * k + 12)}px`;
    marker.style.top = `${(y - 9 * 65536) * k}px`;
    marker.style.height = `${12 * 65536 * k}px`;
    el.appendChild(marker);
    setTimeout(() => marker.remove(), 1600);
  }
}

function jumpFromEvent(e: MouseEvent): void {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.page');
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const k = cssScale();
  post({ type: 'jump', page: Number(el.dataset.page), x: (e.clientX - rect.left) / k, y: (e.clientY - rect.top) / k });
}
pagesEl.addEventListener('dblclick', (e) => {
  window.getSelection()?.removeAllRanges();
  jumpFromEvent(e);
});
pagesEl.addEventListener('click', (e) => {
  if (e.ctrlKey || e.metaKey) jumpFromEvent(e);
});

// ---------------------------------------------------------------------------------------------
// Toolbar and keys

$('zoomIn').addEventListener('click', () => stepZoom(1));
$('zoomOut').addEventListener('click', () => stepZoom(-1));
zoomLabel.addEventListener('click', () => setZoom('100'));
$('fit').addEventListener('click', () => setZoom('fitWidth'));
followBtn.addEventListener('click', () => {
  setFollowUi(!follow);
  post({ type: 'setFollow', value: follow });
  showToast(follow ? 'The preview now follows your cursor.' : 'The preview no longer follows your cursor. Press Ctrl+Alt+J to jump there on demand.', 3500);
});
$('recompile').addEventListener('click', () => runCommand('realtimeTex.recompile'));
$('export').addEventListener('click', () => runCommand('realtimeTex.exportPdf'));

window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  if (e.key === '=' || e.key === '+') stepZoom(1);
  else if (e.key === '-') stepZoom(-1);
  else if (e.key === '0') setZoom('100');
  else return;
  e.preventDefault();
});
viewport.addEventListener(
  'wheel',
  (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    stepZoom(e.deltaY < 0 ? 1 : -1);
  },
  { passive: false },
);
viewport.addEventListener('scroll', () => updatePageNo(), { passive: true });
let resizeTimer: ReturnType<typeof setTimeout> | undefined;
new ResizeObserver(() => {
  if (zoom !== 'fitWidth') return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const a = scrollAnchor();
    layoutPages();
    restoreAnchor(a);
  }, 80);
}).observe(viewport);

function applyConfig(m: Extract<HostToWebview, { type: 'config' }>): void {
  setFollowUi(m.follow);
  document.body.classList.toggle('invert', m.invert);
  if (m.zoom && !saved?.zoom) setZoom(m.zoom);
}
applyConfig({ type: 'config', follow: boot.follow, invert: boot.invert });

images.onLoaded = () => markDirty(model.pages.keys());

// ---------------------------------------------------------------------------------------------
// Host messages

let pdfSerial = 0;
window.addEventListener('message', (ev: MessageEvent<HostToWebview>) => {
  const m = ev.data;
  switch (m.type) {
    case 'screen':
      showScreen(m);
      break;
    case 'banner':
      showBanner(m);
      break;
    case 'status':
      showStatus(m.text, m.kind, m.tooltip);
      break;
    case 'resources':
      for (const [key, res] of m.fonts) fonts.add(key, res);
      for (const [file, res] of m.images) images.add(file, res);
      break;
    case 'layout': {
      const first = !model.hasLayout;
      const dirtyPages = model.applyLayout({
        pages: m.pages,
        pagesTotal: m.pagesTotal,
        placements: m.placements,
        keepFromRevision: m.keepFromRevision,
      });
      for (const p of m.pages) pagePdfSerial.set(p.page, m.pdf ? pdfSerial + 1 : Infinity);
      if (m.pdf) {
        const serial = ++pdfSerial;
        openPdf(m.pdf).then(
          (doc) => {
            if (serial !== pdfSerial) {
              void doc.destroy();
              return;
            }
            const old = pdfDoc;
            pdfDoc = doc;
            pdfPages = doc.numPages;
            pdfSerialLoaded = serial;
            void old?.destroy();
            markDirty(model.pages.keys());
          },
          (e) => post({ type: 'log', message: `pdf: cannot open the full-compile PDF: ${String(e)}` }),
        );
      }
      layoutPages();
      markDirty(dirtyPages);
      if (first) screen.hidden = true;
      setHasDocument(true);
      updatePageNo();
      break;
    }
    case 'paragraph':
      markDirty(model.applyParagraph(m.parId, m.dl, m.fragments, m.revision));
      break;
    case 'dropOverlays':
      markDirty(model.dropOverlays(m.parIds));
      break;
    case 'reveal':
      reveal(m.page, m.x, m.y, m.force);
      break;
    case 'config':
      applyConfig(m);
      break;
    case 'hint':
      showToast(m.text, 9000);
      break;
    case 'reset':
      setHasDocument(false);
      model.clear();
      pagesEl.innerHTML = '';
      visible.clear();
      dirty.clear();
      pdfDoc = undefined;
      pdfPages = 0;
      pdfSerialLoaded = 0;
      pagePdfSerial.clear();
      banner.hidden = true;
      updatePageNo();
      break;
  }
});

window.addEventListener('error', (e) => post({ type: 'error', message: String(e.message) }));
post({ type: 'ready' });
