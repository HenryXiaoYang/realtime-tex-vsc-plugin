// Preview-local back navigation. No document parsing, host messages or per-scroll work.
export interface NavigationAnchor {
  /** One-based page number. Fractions may be negative in the margin before a page. */
  page: number;
  x: number;
  y: number;
}

export interface PageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScrollPosition {
  left: number;
  top: number;
}

export function captureAnchor(page: number, box: PageBox, position: ScrollPosition): NavigationAnchor | undefined {
  if (!Number.isInteger(page) || page < 1 || !validBox(box) || !finitePosition(position)) return undefined;
  return { page, x: (position.left - box.left) / box.width, y: (position.top - box.top) / box.height };
}

export function anchorPosition(anchor: NavigationAnchor, box: PageBox): ScrollPosition | undefined {
  if (!validAnchor(anchor) || !validBox(box)) return undefined;
  const position = { left: box.left + anchor.x * box.width, top: box.top + anchor.y * box.height };
  return finitePosition(position) ? position : undefined;
}

/** Compare actual, clamped scroll positions so a link at the document edge adds no no-op. */
export function clampScroll(position: ScrollPosition, maxLeft: number, maxTop: number): ScrollPosition {
  return {
    left: Math.max(0, Math.min(position.left, Math.max(0, maxLeft))),
    top: Math.max(0, Math.min(position.top, Math.max(0, maxTop))),
  };
}

export function scrollChanged(a: ScrollPosition, b: ScrollPosition): boolean {
  return Math.abs(a.left - b.left) > 1 || Math.abs(a.top - b.top) > 1;
}

/** At most 50 departure positions; browsing back never creates a new departure. */
export class NavigationHistory {
  private entries: NavigationAnchor[] = [];

  get size(): number {
    return this.entries.length;
  }

  push(anchor: NavigationAnchor): void {
    if (!validAnchor(anchor)) return;
    const last = this.entries[this.entries.length - 1];
    if (last && last.page === anchor.page && Math.abs(last.x - anchor.x) < 1e-6 && Math.abs(last.y - anchor.y) < 1e-6) return;
    this.entries.push({ ...anchor });
    if (this.entries.length > 50) this.entries.shift();
  }

  pop(): NavigationAnchor | undefined {
    return this.entries.pop();
  }

  prune(pagesTotal: number): void {
    this.entries = this.entries.filter((entry) => entry.page <= pagesTotal);
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface BackMouseEvent {
  type: string;
  button: number;
  preventDefault(): void;
  stopPropagation(): void;
}

/** Own a side-button press from down through auxclick, navigating only once. Some browser
 * integrations emit only auxclick; accept that too. Empty history leaves host navigation alone. */
export class BackMouseHandler {
  private pressed = false;
  private suppressAux = false;

  constructor(private readonly canGoBack: () => boolean, private readonly goBack: () => void) {}

  handle(event: BackMouseEvent): void {
    if (event.button !== 3) return;
    let navigate = false;
    switch (event.type) {
      case 'mousedown':
        if (!this.pressed) {
          this.suppressAux = false;
          if (!this.canGoBack()) return;
          this.pressed = true;
          navigate = true;
        }
        break;
      case 'mouseup':
        if (!this.pressed) return;
        this.pressed = false;
        this.suppressAux = true;
        break;
      case 'auxclick':
        if (!this.pressed && !this.suppressAux) {
          if (!this.canGoBack()) return;
          navigate = true;
        }
        this.reset();
        break;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (navigate) this.goBack();
  }

  reset(): void {
    this.pressed = false;
    this.suppressAux = false;
  }
}

function validAnchor(anchor: NavigationAnchor): boolean {
  return Number.isInteger(anchor.page) && anchor.page >= 1 && Number.isFinite(anchor.x) && Number.isFinite(anchor.y);
}

function validBox(box: PageBox): boolean {
  return [box.left, box.top, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0;
}

function finitePosition(position: ScrollPosition): boolean {
  return Number.isFinite(position.left) && Number.isFinite(position.top);
}
