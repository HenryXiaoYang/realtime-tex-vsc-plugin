// Geometry of PDF link annotations in page coordinates, and the DOM overlay that keeps link
// nodes stable while a layout is on screen. Pure module (no DOM globals), so the geometry and
// the real controller can be unit-tested with a tiny fake document.
import { SP_PER_BP } from '../src/protocol';
import type { PdfLink, PdfLinkTarget } from '../src/protocol';
import type { Rect } from './model';

/** A page target as carried by the protocol (x/pageAspect and the raw user-space point). */
export type PdfPageTargetGeometry = Extract<PdfLinkTarget, { kind: 'page' }>;
export type PdfLinkTargetGeometry = PdfLinkTarget;
/** The protocol link plus the optional raw user-space rectangle A supplies for display lists. */
export type PdfLinkGeometry = PdfLink;

/** Whether the page's canvas currently shows the PDF viewport or the unrotated display list. */
export type LinkDrawMode = 'pdf' | 'displayList';

const ASPECT_EPS = 1e-4;

function finite(v: number | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** The unrotated page box in page coordinates. */
export function fullPageBox(pageWidth: number, pageHeight: number): Rect | undefined {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return undefined;
  return { x: 0, y: 0, w: pageWidth, h: pageHeight };
}

/**
 * Where renderPdfPage actually paints a PDF page on the page canvas: the rotated/cropped PDF
 * viewport is scaled by `min(canvasWidth / viewportWidth, canvasHeight / viewportHeight)` and
 * anchored at the top-left, so a PDF whose aspect differs from the page leaves white space.
 * This is the one geometry helper both the renderer and the link overlay use.
 */
export function pdfContentBox(pageWidth: number, pageHeight: number, aspect: number | undefined): Rect | undefined {
  const full = fullPageBox(pageWidth, pageHeight);
  if (!full) return undefined;
  if (!finite(aspect) || aspect <= 0) return full;
  const pageAspect = pageWidth / pageHeight;
  if (Math.abs(aspect / pageAspect - 1) <= ASPECT_EPS) return full;
  if (aspect > pageAspect) {
    const h = pageWidth / aspect;
    return { x: 0, y: 0, w: pageWidth, h };
  }
  return { x: 0, y: 0, w: pageHeight * aspect, h: pageHeight };
}

/**
 * The display list is the unrotated, uncropped TeX page. A PDF whose viewport has another
 * aspect (rotation or a narrower CropBox) cannot be mapped onto it by viewport fractions alone;
 * links are withheld unless A supplied raw user-space geometry.
 */
function displayListBox(pageWidth: number, pageHeight: number, aspect: number | undefined): Rect | undefined {
  const full = fullPageBox(pageWidth, pageHeight);
  if (!full) return undefined;
  if (!finite(aspect) || aspect <= 0) return full;
  return Math.abs(aspect / (pageWidth / pageHeight) - 1) <= ASPECT_EPS ? full : undefined;
}

function fractionRect(box: Rect, x: number, y: number, w: number, h: number): Rect | undefined {
  if (![x, y, w, h].every(Number.isFinite)) return undefined;
  const left = clamp(box.x + x * box.w, box.x, box.x + box.w);
  const right = clamp(box.x + (x + w) * box.w, box.x, box.x + box.w);
  const top = clamp(box.y + y * box.h, box.y, box.y + box.h);
  const bottom = clamp(box.y + (y + h) * box.h, box.y, box.y + box.h);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** Raw PDF user space (points, bottom-left origin, unrotated/uncropped) to page coordinates. */
function userRectToPage(rect: readonly [number, number, number, number], pageWidth: number, pageHeight: number): Rect | undefined {
  if (rect.length < 4 || !rect.every((v) => typeof v === 'number' && Number.isFinite(v))) return undefined;
  const left = clamp(Math.min(rect[0], rect[2]) * SP_PER_BP, 0, pageWidth);
  const right = clamp(Math.max(rect[0], rect[2]) * SP_PER_BP, 0, pageWidth);
  const top = clamp(pageHeight - Math.max(rect[1], rect[3]) * SP_PER_BP, 0, pageHeight);
  const bottom = clamp(pageHeight - Math.min(rect[1], rect[3]) * SP_PER_BP, 0, pageHeight);
  if (right - left <= 0 || bottom - top <= 0) return undefined;
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * The link's rectangle in page coordinates (sp).
 *
 * `pdf`: fractions of the PDF viewport, which renderPdfPage fits into the page canvas.
 * `displayList`: the unrotated TeX page. Raw `userRect` (when A provides it) is exact even
 * with /Rotate or a non-zero /CropBox; without it, only a non-rotated full-page PDF can be
 * mapped and the link is withheld otherwise.
 */
export function linkRect(link: PdfLinkGeometry, pageWidth: number, pageHeight: number, mode: LinkDrawMode = 'pdf'): Rect | undefined {
  if (mode === 'displayList') {
    if (link.userRect) return userRectToPage(link.userRect, pageWidth, pageHeight);
    const box = displayListBox(pageWidth, pageHeight, link.pageAspect);
    return box ? fractionRect(box, link.x, link.y, link.w, link.h) : undefined;
  }
  const box = pdfContentBox(pageWidth, pageHeight, link.pageAspect);
  return box ? fractionRect(box, link.x, link.y, link.w, link.h) : undefined;
}

export function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Whether a link from the last full compile lies under something a live edit has replaced. The
 * annotation is stale there (its text moved or the link itself changed), so hiding it until the
 * next full compile is better than letting it point at the wrong glyphs.
 */
export function linkIsCovered(
  link: PdfLinkGeometry,
  pageWidth: number,
  pageHeight: number,
  covered: readonly Rect[],
  mode: LinkDrawMode = 'pdf',
): boolean {
  if (!covered.length) return false;
  const r = linkRect(link, pageWidth, pageHeight, mode);
  return r ? covered.some((c) => overlaps(r, c)) : false;
}

/** A point in page coordinates (sp). */
export interface TargetPoint {
  x: number;
  y: number;
}

/**
 * Convert an internal destination to page coordinates. Raw user-space coordinates (when A
 * provides them) are used for display-list pages; otherwise the destination is a fraction of
 * the PDF viewport and is mapped through the same fit as a PDF-rendered page. Undefined when a
 * display-list page has a rotated/cropped PDF and no raw destination can be mapped.
 */
export function targetPoint(
  target: PdfPageTargetGeometry,
  pageWidth: number,
  pageHeight: number,
  mode: LinkDrawMode = 'pdf',
): TargetPoint | undefined {
  if (!(pageWidth > 0) || !(pageHeight > 0)) return undefined;
  if (mode === 'displayList') {
    if (finite(target.userX) || finite(target.userY)) {
      // FitH/FitV and XYZ with one null coordinate name only one axis; the PDF convention for
      // the other is the page edge (x=0 / top=0), not a viewport fraction of a cropped page.
      const x = finite(target.userX) ? target.userX * SP_PER_BP : 0;
      const y = finite(target.userY) ? pageHeight - target.userY * SP_PER_BP : 0;
      return { x: clamp(x, 0, pageWidth), y: clamp(y, 0, pageHeight) };
    }
    const box = displayListBox(pageWidth, pageHeight, target.pageAspect);
    if (!box) return undefined;
    const x = finite(target.x) ? target.x : 0;
    return { x: clamp(box.x + x * box.w, 0, pageWidth), y: clamp(box.y + target.y * box.h, 0, pageHeight) };
  }
  const box = pdfContentBox(pageWidth, pageHeight, target.pageAspect);
  if (!box) return undefined;
  const x = finite(target.x) ? target.x : 0;
  const y = finite(target.y) ? target.y : 0;
  return { x: clamp(box.x + x * box.w, 0, pageWidth), y: clamp(box.y + y * box.h, 0, pageHeight) };
}

// ---------------------------------------------------------------------------------------------
// Link DOM overlay

/** The few DOM members the overlay uses; a real HTMLAnchorElement satisfies this and a tiny
 * fake can implement it without installing a DOM library. */
export interface LinkStyleLike {
  left: string;
  top: string;
  width: string;
  height: string;
}

export interface LinkDatasetLike {
  url?: string;
  page?: string;
  x?: string;
  y?: string;
  aspect?: string;
  userX?: string;
  userY?: string;
  [key: string]: string | undefined;
}

export interface LinkElementLike {
  hidden: boolean;
  tabIndex: number;
  className: string;
  title: string;
  style: LinkStyleLike;
  dataset: LinkDatasetLike;
  setAttribute(name: string, value: string): void;
  remove(): void;
}

export interface LinkLayerLike {
  appendChild(node: LinkElementLike): void;
}

export interface LinkDocumentLike {
  createElement(tag: 'a'): LinkElementLike;
}

/** The page geometry the overlay needs at draw time; percentages do not depend on zoom. */
export interface LinkPageState {
  widthSp: number;
  heightSp: number;
  /** The canvas currently shows the PDF page (renderPdfPage succeeded), not the display list. */
  fromPdf: boolean;
  /** Rectangles (page coordinates, sp) a live edit replaced. */
  covered: readonly Rect[];
}

export type LinkPageStateFor = (page: number) => LinkPageState | undefined;
export type LinkLayerFor = (page: number) => LinkLayerLike | undefined;
/** Called at most once per batch; the preview passes requestAnimationFrame. */
export type FrameScheduler = (callback: () => void) => void;

/**
 * Keeps one `<a class="pdf-link">` per link of the current layout. Paragraph updates only
 * toggle hidden/tabIndex and rewrite changed geometry, so untouched nodes keep their identity
 * and keyboard focus; nodes exist only for pages that have become visible.
 */
export class LinkOverlay {
  private layoutVersion = 0;
  private readonly linksByPage = new Map<number, PdfLinkGeometry[]>();
  private readonly nodes = new Map<number, LinkElementLike[]>();
  private readonly visible = new Set<number>();
  private readonly pending = new Set<number>();
  /** Per-node target signature: target/attributes are rewritten only when they change. */
  private readonly targetKeys = new WeakMap<LinkElementLike, string>();
  private scheduled = false;
  private disposed = false;

  constructor(
    private readonly doc: LinkDocumentLike,
    private readonly stateFor: LinkPageStateFor,
    private readonly layerFor: LinkLayerFor,
    private readonly scheduleFrame: FrameScheduler,
  ) {}

  get version(): number {
    return this.layoutVersion;
  }

  /** A new visual layout: old links must not stay clickable at different coordinates. */
  beginLayout(version: number): void {
    if (version === this.layoutVersion) return;
    this.layoutVersion = version;
    this.linksByPage.clear();
    this.clearNodes();
    this.pending.clear();
  }

  /** Install the links of the current display version; older versions are ignored. */
  setLinks(links: readonly PdfLinkGeometry[], version: number): boolean {
    if (this.disposed || version !== this.layoutVersion) return false;
    const hadNodes = new Set(this.nodes.keys());
    this.linksByPage.clear();
    for (const link of links) {
      if (!Number.isInteger(link.page) || link.page < 1) continue;
      const list = this.linksByPage.get(link.page);
      if (list) list.push(link);
      else this.linksByPage.set(link.page, [link]);
    }
    for (const page of new Set([...this.visible, ...hadNodes])) this.invalidate(page);
    return true;
  }

  setVisible(page: number, isVisible: boolean): void {
    if (isVisible) {
      this.visible.add(page);
      this.invalidate(page);
    } else {
      this.visible.delete(page);
    }
  }

  /** The page's display list or occlusion changed (or it was just drawn from another source). */
  invalidate(page: number): void {
    if (this.disposed || !this.visible.has(page)) return;
    this.pending.add(page);
    this.schedule();
  }

  invalidateVisible(): void {
    for (const page of this.visible) this.pending.add(page);
    this.schedule();
  }

  /** Page removed from the model (pagesTotal shrank). */
  dropPage(page: number): void {
    this.removeNodes(page);
    this.linksByPage.delete(page);
    this.visible.delete(page);
    this.pending.delete(page);
  }

  reset(): void {
    this.layoutVersion = 0;
    this.linksByPage.clear();
    this.clearNodes();
    this.visible.clear();
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  /** The live nodes for a page (tests); production code must not mutate this array. */
  nodesFor(page: number): readonly LinkElementLike[] {
    return this.nodes.get(page) ?? [];
  }

  private schedule(): void {
    if (this.scheduled || this.disposed) return;
    this.scheduled = true;
    this.scheduleFrame(() => this.flush());
  }

  /** Run the pending per-page updates now (the frame callback; also used by tests). */
  flush(): void {
    this.scheduled = false;
    if (this.disposed) return;
    const pages = [...this.pending];
    this.pending.clear();
    for (const page of pages) if (this.visible.has(page)) this.renderPage(page);
  }

  private renderPage(page: number): void {
    const state = this.stateFor(page);
    const layer = this.layerFor(page);
    if (!state || !layer) return;
    const links = this.linksByPage.get(page) ?? [];
    let nodes = this.nodes.get(page);
    if (!nodes) {
      nodes = [];
      this.nodes.set(page, nodes);
    }
    for (let i = nodes.length; i < links.length; i++) nodes.push(this.createNode(layer));
    while (nodes.length > links.length) nodes.pop()!.remove();
    const mode: LinkDrawMode = state.fromPdf ? 'pdf' : 'displayList';
    for (let i = 0; i < links.length; i++) this.updateNode(nodes[i], links[i], state, mode);
  }

  private createNode(layer: LinkLayerLike): LinkElementLike {
    const node = this.doc.createElement('a');
    node.className = 'pdf-link';
    node.hidden = true;
    node.tabIndex = -1;
    node.title = '';
    node.style.left = '0%';
    node.style.top = '0%';
    node.style.width = '0%';
    node.style.height = '0%';
    node.setAttribute('role', 'link');
    layer.appendChild(node);
    return node;
  }

  private updateNode(node: LinkElementLike, link: PdfLinkGeometry, state: LinkPageState, mode: LinkDrawMode): void {
    const rect = linkRect(link, state.widthSp, state.heightSp, mode);
    const covered = rect ? state.covered.some((c) => overlaps(rect, c)) : false;
    const active = rect !== undefined && !covered;
    if (node.hidden !== !active) node.hidden = !active;
    if (rect) this.applyStyle(node, rect, state);
    this.applyTarget(node, link.target, active);
  }

  private applyStyle(node: LinkElementLike, rect: Rect, state: LinkPageState): void {
    const left = `${(rect.x / state.widthSp) * 100}%`;
    const top = `${(rect.y / state.heightSp) * 100}%`;
    const width = `${(rect.w / state.widthSp) * 100}%`;
    const height = `${(rect.h / state.heightSp) * 100}%`;
    if (node.style.left !== left) node.style.left = left;
    if (node.style.top !== top) node.style.top = top;
    if (node.style.width !== width) node.style.width = width;
    if (node.style.height !== height) node.style.height = height;
  }

  private applyTarget(node: LinkElementLike, target: PdfLinkTargetGeometry, active: boolean): void {
    const key =
      (target.kind === 'url'
        ? `url:${target.url}`
        : `page:${target.page}:${finite(target.x) ? target.x : 0}:${target.y}:${finite(target.pageAspect) ? target.pageAspect : ''}:${
            finite(target.userX) ? target.userX : ''
          }:${finite(target.userY) ? target.userY : ''}`) + (active ? '|active' : '|covered');
    if (this.targetKeys.get(node) !== key) {
      this.targetKeys.set(node, key);
      if (target.kind === 'url') {
        node.dataset.url = target.url;
        delete node.dataset.page;
        delete node.dataset.x;
        delete node.dataset.y;
        delete node.dataset.aspect;
        delete node.dataset.userX;
        delete node.dataset.userY;
        node.title = target.url;
        node.setAttribute('aria-label', `Open ${target.url}`);
      } else {
        delete node.dataset.url;
        node.dataset.page = String(target.page);
        node.dataset.x = String(finite(target.x) ? target.x : 0);
        node.dataset.y = String(target.y);
        if (finite(target.pageAspect)) node.dataset.aspect = String(target.pageAspect);
        else delete node.dataset.aspect;
        if (finite(target.userX)) node.dataset.userX = String(target.userX);
        else delete node.dataset.userX;
        if (finite(target.userY)) node.dataset.userY = String(target.userY);
        else delete node.dataset.userY;
        node.title = active ? `Go to page ${target.page}` : `Go to page ${target.page} (waiting for the next full compile)`;
        node.setAttribute('aria-label', `Go to page ${target.page}`);
      }
    }
    // A covered link is stale: not clickable and not a tab stop.
    const tab = active ? 0 : -1;
    if (node.tabIndex !== tab) node.tabIndex = tab;
    node.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  private clearNodes(): void {
    for (const list of this.nodes.values()) for (const node of list) node.remove();
    this.nodes.clear();
  }

  private removeNodes(page: number): void {
    const list = this.nodes.get(page);
    if (!list) return;
    for (const node of list) node.remove();
    this.nodes.delete(page);
  }
}
