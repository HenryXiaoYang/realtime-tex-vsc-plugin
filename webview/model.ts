// Preview state: background pages plus fast-path overlays (realtime-tex docs/VERSIONING.md).
// Pure module (no DOM), unit-tested with node:test.
import type { DisplayList, Fragment, Line, PageUpdate, Placement } from '../src/protocol';

export interface Overlay {
  parId: number;
  dl: DisplayList;
  fragments: Fragment[];
  /** source_revision of the edit that produced it. */
  revision: number;
}

export interface OverlayRow {
  line: Line;
  dx: number;
  dy: number;
}

export interface PageOverlay {
  overlay: Overlay;
  rows: OverlayRow[];
}

export interface LayoutInput {
  pages: PageUpdate[];
  pagesTotal: number;
  placements: Placement[];
  /** Keep overlays with revision >= this (the layout is stale since it); null drops them all. */
  keepFromRevision: number | null;
}

const MATCH_TOLERANCE = 64; // sp

export class PreviewModel {
  readonly pages = new Map<number, PageUpdate>();
  pagesTotal = 0;
  /** Layout placements per unit. */
  readonly placements = new Map<number, Fragment[]>();
  readonly overlays = new Map<number, Overlay>();
  private hiddenCache = new Map<number, Set<number>>();

  get hasLayout(): boolean {
    return this.pagesTotal > 0;
  }

  /** Install a background layout. Returns the pages whose drawing changed. */
  applyLayout(input: LayoutInput): Set<number> {
    const dirty = new Set<number>();
    for (const ov of this.overlays.values()) for (const f of ov.fragments) dirty.add(f.page);
    for (const p of input.pages) {
      this.pages.set(p.page, p);
      dirty.add(p.page);
    }
    this.pagesTotal = input.pagesTotal;
    for (const n of [...this.pages.keys()]) if (n > input.pagesTotal) this.pages.delete(n);
    this.placements.clear();
    for (const pl of input.placements) this.placements.set(pl.par_id, pl.fragments);
    for (const [id, ov] of [...this.overlays]) {
      if (input.keepFromRevision === null || ov.revision < input.keepFromRevision) {
        this.overlays.delete(id);
        continue;
      }
      const placed = this.placements.get(id);
      if (placed) ov.fragments = reanchor(placed, ov.dl.lines);
      for (const f of ov.fragments) dirty.add(f.page);
    }
    this.hiddenCache.clear();
    for (const n of dirty) if (n > this.pagesTotal) dirty.delete(n);
    return dirty;
  }

  /** Install a fast-path result. Returns the pages to redraw. */
  applyParagraph(parId: number, dl: DisplayList, fragments: Fragment[], revision: number): Set<number> {
    const dirty = new Set<number>();
    const old = this.overlays.get(parId);
    if (old) for (const f of old.fragments) dirty.add(f.page);
    this.overlays.set(parId, { parId, dl, fragments, revision });
    for (const f of fragments) dirty.add(f.page);
    for (const f of this.placements.get(parId) ?? []) {
      dirty.add(f.page);
      this.hiddenCache.delete(f.page);
    }
    return dirty;
  }

  /** Drop overlays (all when `ids` is undefined). Returns the pages to redraw. */
  dropOverlays(ids?: number[]): Set<number> {
    const dirty = new Set<number>();
    const victims = ids ?? [...this.overlays.keys()];
    for (const id of victims) {
      const ov = this.overlays.get(id);
      if (!ov) continue;
      this.overlays.delete(id);
      for (const f of ov.fragments) dirty.add(f.page);
      for (const f of this.placements.get(id) ?? []) {
        dirty.add(f.page);
        this.hiddenCache.delete(f.page);
      }
    }
    return dirty;
  }

  clear(): void {
    this.pages.clear();
    this.placements.clear();
    this.overlays.clear();
    this.hiddenCache.clear();
    this.pagesTotal = 0;
  }

  /** Indices of the page's lines replaced by overlays (rows of units that have one). */
  hiddenLines(page: number): Set<number> {
    let set = this.hiddenCache.get(page);
    if (set) return set;
    set = new Set<number>();
    const pu = this.pages.get(page);
    if (pu) {
      for (const id of this.overlays.keys()) {
        for (const f of this.placements.get(id) ?? []) {
          if (f.page !== page) continue;
          for (let k = 0; k < f.baselines.length; k++) {
            pu.dl.lines.forEach((line, idx) => {
              if (Math.abs(line.y - f.baselines[k]) <= MATCH_TOLERANCE && Math.abs(line.x - (f.xs[k] ?? f.x)) <= MATCH_TOLERANCE) {
                set!.add(idx);
              }
            });
          }
        }
      }
    }
    this.hiddenCache.set(page, set);
    return set;
  }

  /** Overlay rows to draw on `page`, with the translation of each row into page coordinates. */
  overlaysOn(page: number): PageOverlay[] {
    const out: PageOverlay[] = [];
    for (const ov of this.overlays.values()) {
      const rows: OverlayRow[] = [];
      for (const f of ov.fragments) {
        if (f.page !== page) continue;
        for (let k = 0; k < f.baselines.length; k++) {
          const line = ov.dl.lines[f.first_line - 1 + k];
          if (!line) continue;
          rows.push({ line, dx: (f.xs[k] ?? f.x) - line.x, dy: f.baselines[k] - line.y });
        }
      }
      if (rows.length) out.push({ overlay: ov, rows });
    }
    return out;
  }

  /** Where each unit currently is: overlay fragments win over layout placements. */
  currentPlacements(): Map<number, Fragment[]> {
    const out = new Map(this.placements);
    for (const ov of this.overlays.values()) out.set(ov.parId, ov.fragments);
    return out;
  }
}

/** Place a unit's rows at a layout's placement rows (the algorithm of rtex layout.rs
 * `fragments`): rows are positioned relative to the first placement row of each page; rows
 * beyond the placement continue on its last page. */
export function reanchor(placed: readonly Fragment[], rows: readonly Line[]): Fragment[] {
  const pl: { page: number; x: number; y: number }[] = [];
  for (const f of placed) for (let k = 0; k < f.baselines.length; k++) pl.push({ page: f.page, x: f.xs[k] ?? f.x, y: f.baselines[k] });
  const frags: Fragment[] = [];
  let i = 0;
  while (i < pl.length && i < rows.length) {
    const page = pl[i].page;
    const anchor = pl[i];
    const ax = rows[i].x;
    const ay = rows[i].y;
    const first = i;
    const xs: number[] = [];
    const baselines: number[] = [];
    while (i < pl.length && pl[i].page === page && i < rows.length) {
      xs.push(anchor.x + (rows[i].x - ax));
      baselines.push(anchor.y + (rows[i].y - ay));
      i++;
    }
    let approximate = false;
    if (i >= pl.length) {
      while (i < rows.length) {
        xs.push(anchor.x + (rows[i].x - ax));
        baselines.push(anchor.y + (rows[i].y - ay));
        i++;
        approximate = true;
      }
    }
    frags.push({ page, first_line: first + 1, last_line: i, x: xs[0], xs, baselines, approximate });
  }
  return frags;
}
