// Version-bound layout snapshots, the preview's serial queue and the lifecycle of link
// extraction. Pure Node module (no vscode and no DOM), so the production controller below can
// be tested directly with fake queues, extractors and sessions.
import { promises as fs } from 'fs';
import * as path from 'path';
import type { DisplayList, Fragment, PageUpdate, PdfLink, Placement } from '../protocol';

/** One rtex layout's PDF: copies per layout are immutable; `bg/<jobname>.pdf` is only a moving
 * alias and must never be used for pages or links. */
export function layoutPdfPath(buildDir: string, layoutVersion: number): string {
  return path.join(buildDir, 'bg', `layout-${layoutVersion}.pdf`);
}

/** A PDF that is still being written does not end with %%EOF; the preview must not hand a
 * truncated file to pdf.js. The next layout provides a complete copy. */
export async function readCompletePdf(file: string): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(file);
    const tail = data.subarray(Math.max(0, data.length - 1024)).toString('latin1');
    return tail.includes('%%EOF') ? new Uint8Array(data) : null;
  } catch {
    return null;
  }
}

/** Jobs run one after another, in arrival order, so incremental layouts keep their
 * `pages_changed` sequence and paragraphs never overtake the layout that placed them. */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly onError: (e: unknown) => void = () => undefined) {}

  run(job: () => Promise<void> | void): void {
    this.tail = this.tail.then(job).catch((e: unknown) => this.onError(e));
  }

  /** Resolves when every job queued so far has finished (tests and shutdown). */
  idle(): Promise<void> {
    return this.tail;
  }
}

/** The subset of `PdfLinkExtractor` the controller needs (A owns the concrete class). */
export interface LinkExtractorLike {
  extract(file: string, expectedPages?: number): Promise<PdfLink[]>;
  cancel(): void;
  dispose(): void;
}

export interface OverlaySnapshot {
  parId: number;
  dl: DisplayList;
  fragments: Fragment[];
  revision: number;
}

/** Everything a page or link message needs, captured before any await: later layouts mutate
 * the live PreviewModel (overlay fragments are re-anchored), so the queue must not re-read it. */
export interface LayoutSnapshot<T = unknown> {
  /** Opaque owner token: the panel's Session. The controller never inspects it. */
  context: T;
  /** rtex layout version, used only to name the version PDF. */
  engineVersion: number;
  /** Immutable `bg/layout-<version>.pdf`; never the moving `bg/<jobname>.pdf` alias. */
  pdfPath: string;
  pages: PageUpdate[];
  pagesTotal: number;
  placements: Placement[];
  overlays: OverlaySnapshot[];
  keepFromRevision: number | null;
  /** True for a replay: `pages` is the whole model and `overlays` must be posted too. */
  full: boolean;
  /** The layout has at least one page that may need the PDF (live: pdf_fallback != null;
   * replay: some page is not exact). */
  pdfFallback: boolean;
}

/** The parts of PreviewModel a snapshot reads. */
export interface SnapshotSource {
  readonly hasLayout: boolean;
  readonly pages: ReadonlyMap<number, PageUpdate>;
  readonly pagesTotal: number;
  readonly placements: ReadonlyMap<number, readonly Fragment[]>;
  readonly overlays: ReadonlyMap<number, { parId: number; dl: DisplayList; fragments: readonly Fragment[]; revision: number }>;
}

function copyFragment(f: Fragment): Fragment {
  return { ...f, xs: [...f.xs], baselines: [...f.baselines] };
}

/**
 * Freeze the current preview state for replay. Called before the resource queue is entered:
 * a layout that arrives while fonts or PDF bytes are loading must not change what is replayed.
 */
export function captureSnapshot<T>(model: SnapshotSource, engineVersion: number, pdfPath: string, context: T): LayoutSnapshot<T> | undefined {
  if (!model.hasLayout) return undefined;
  const pages = [...model.pages.values()].sort((a, b) => a.page - b.page);
  const placements = [...model.placements.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([par_id, fragments]) => ({ par_id, fragments: fragments.map(copyFragment), lines: 0, kind: '' }));
  const overlays = [...model.overlays.values()]
    .sort((a, b) => a.parId - b.parId)
    .map((o) => ({ parId: o.parId, dl: o.dl, fragments: o.fragments.map(copyFragment), revision: o.revision }));
  return {
    context,
    engineVersion,
    pdfPath,
    pages,
    pagesTotal: model.pagesTotal,
    placements,
    overlays,
    keepFromRevision: null,
    full: true,
    pdfFallback: pages.some((p) => !p.exact),
  };
}

/** The layout message the panel posts to the webview. `layoutVersion` is the panel's display
 * serial, not rtex's version (which may restart at 1 when the engine restarts). */
export interface LayoutMessage {
  pages: PageUpdate[];
  pagesTotal: number;
  placements: Placement[];
  keepFromRevision: number | null;
  pdf: Uint8Array | null;
  layoutVersion: number;
}

export interface LayoutLinkHost<T = unknown> {
  /** Send missing fonts/images and read the version PDF if a page may need it. */
  prepare(snapshot: LayoutSnapshot<T>): Promise<Uint8Array | null>;
  layout(message: LayoutMessage): void;
  /** Post the replayed live overlays (a no-op for incremental layouts). */
  overlays(snapshot: LayoutSnapshot<T>): void;
  links(links: PdfLink[], displayVersion: number): void;
  /** Already prefixed by the panel (`[links]`). */
  log(message: string): void;
  /** A non-link problem (already prefixed by the panel, e.g. `[preview]`); defaults to `log`. */
  error?(message: string): void;
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';
}

/**
 * Owns everything that must not outlive a layout: the serial queue for page/overlay messages,
 * the monotonic webview display version, and link extraction.
 *
 * - Every submitted snapshot is posted in order; an intermediate `pages_changed` set is never
 *   dropped, because later layouts only carry their own changed pages.
 * - A new layout cancels the previous extraction immediately, not after its resources load.
 * - Links are posted only after the layout with the same display version, and only when that
 *   layout is still the newest.
 * - `reset()` (attach, engine restart, dispose, replay) bumps an epoch; queued jobs and late
 *   worker results from the old state are ignored. Display versions are never reused, so the
 *   webview cannot accept old links for a new layout even when rtex reuses version numbers.
 */
export class LayoutLinkController<T = unknown> {
  private epoch = 0;
  private nextId = 0;
  private latestId = 0;
  private displayVersion = 0;
  private lastError = '';
  private disposed = false;

  constructor(
    private readonly queue: SerialQueue,
    private readonly extractor: LinkExtractorLike,
    private readonly host: LayoutLinkHost<T>,
  ) {}

  /** Queue a layout. Returns the display version the webview will see. */
  submit(snapshot: LayoutSnapshot<T>): number {
    if (this.disposed) return 0;
    const id = ++this.nextId;
    this.latestId = id;
    const version = ++this.displayVersion;
    const epoch = this.epoch;
    // The old extraction is already pointless as soon as a newer layout exists; stop its
    // worker now instead of waiting for this layout's resources.
    this.extractor.cancel();
    this.queue.run(async () => {
      if (this.disposed || epoch !== this.epoch) return;
      let pdf: Uint8Array | null = null;
      try {
        pdf = await this.host.prepare(snapshot);
      } catch (e) {
        // Resource failures must not swallow an incremental pages_changed set: the later
        // layout only carries its own changed pages. Show the pages without the PDF instead.
        if (this.disposed || epoch !== this.epoch) return;
        const message = e instanceof Error ? e.message : String(e);
        (this.host.error ?? this.host.log)(`layout ${snapshot.engineVersion} resources: ${message}`);
      }
      if (this.disposed || epoch !== this.epoch) return;
      this.host.layout({
        pages: snapshot.pages,
        pagesTotal: snapshot.pagesTotal,
        placements: snapshot.placements,
        keepFromRevision: snapshot.keepFromRevision,
        pdf,
        layoutVersion: version,
      });
      this.host.overlays(snapshot);
      if (id !== this.latestId || epoch !== this.epoch) return;
      void this.fetchLinks(snapshot, version, id, epoch);
    });
    return version;
  }

  /** Invalidate every queued job and in-flight extraction (attach/reset/engine start). */
  reset(): void {
    this.epoch++;
    this.latestId = ++this.nextId;
    this.lastError = '';
    this.extractor.cancel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.reset();
    this.disposed = true;
    this.extractor.dispose();
  }

  private async fetchLinks(snapshot: LayoutSnapshot<T>, version: number, id: number, epoch: number): Promise<void> {
    try {
      const links = await this.extractor.extract(snapshot.pdfPath, snapshot.pagesTotal);
      if (this.disposed || epoch !== this.epoch || id !== this.latestId) return;
      // A mismatch cannot normally get here (expectedPages rejects it), but never hand the
      // webview a link whose page does not exist in this layout.
      const valid = links.filter((l) => Number.isInteger(l.page) && l.page >= 1 && l.page <= snapshot.pagesTotal);
      this.lastError = '';
      this.host.links(valid, version);
    } catch (e) {
      if (isAbortError(e)) return;
      if (this.disposed || epoch !== this.epoch || id !== this.latestId) return;
      this.noteError(snapshot.pdfPath, e);
    }
  }

  /** Log a changed problem; a repeated identical failure of the same version PDF is not
   * repeated on every layout, but a later different problem is never swallowed. */
  private noteError(pdfPath: string, e: unknown): void {
    const message = e instanceof Error ? e.message : String(e);
    const key = `${pdfPath}\n${message}`;
    if (key === this.lastError) return;
    this.lastError = key;
    this.host.log(`${path.basename(pdfPath)}: ${message}`);
  }
}
