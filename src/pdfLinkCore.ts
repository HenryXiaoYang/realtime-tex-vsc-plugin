// Helpers shared by the extension-host service and the PDF worker. Nothing here imports PDF.js,
// so the extension bundle can use these types without bundling the parser.
import type { PdfLink } from './protocol';

export interface PdfRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The part of a pdf.js viewport the destination code needs (all in viewport points). */
export interface ViewportLike {
  width: number;
  height: number;
  convertToViewportPoint(x: number, y: number): number[];
  convertToViewportRectangle(rect: number[]): number[];
  convertToPdfPoint(x: number, y: number): number[];
}

export type PdfLinkErrorCode = 'incomplete' | 'invalid' | 'pages' | 'io' | 'worker' | 'parse' | 'disposed';

/** A failure the preview can classify (and the worker can serialize back to the host). */
export class PdfLinkError extends Error {
  constructor(
    readonly code: PdfLinkErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfLinkError';
  }
}

export function abortError(message = 'PDF link extraction cancelled'): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}

export interface PdfLinkWorkerSnapshot {
  mtimeMs: number;
  size: number;
}

/** Host -> worker. The worker owns file IO, completeness checks and all PDF.js work. */
export interface PdfLinkWorkerRequest {
  type: 'extract';
  id: number;
  file: string;
  expectedPages?: number;
}

/** Worker -> host. Only the current request id is accepted by the host. */
export type PdfLinkWorkerResponse =
  | { type: 'result'; id: number; links: PdfLink[]; snapshot: PdfLinkWorkerSnapshot }
  | { type: 'error'; id: number; code: PdfLinkErrorCode; message: string };

/** Only what a PDF is allowed to open without surprising the user. */
export function safeLinkUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** A rectangle in viewport coordinates as fractions of the page (top-left origin, 0..1). */
export function rectFractions(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  width: number,
  height: number,
): PdfRect | undefined {
  if (![x1, y1, x2, y2, width, height].every(Number.isFinite) || !(width > 0) || !(height > 0)) return undefined;
  const x0 = clamp01(Math.min(x1, x2) / width);
  const x3 = clamp01(Math.max(x1, x2) / width);
  const y0 = clamp01(Math.min(y1, y2) / height);
  const y3 = clamp01(Math.max(y1, y2) / height);
  if (x3 - x0 <= 0 || y3 - y0 <= 0) return undefined;
  return { x: x0, y: y0, w: x3 - x0, h: y3 - y0 };
}

/** viewport.width / viewport.height, or undefined when pdf.js gave an unusable page box. */
export function viewAspect(viewport: Pick<ViewportLike, 'width' | 'height'>): number | undefined {
  const aspect = viewport.width / viewport.height;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : undefined;
}

export interface PdfPoint {
  /** Fraction from the left of the viewport. */
  x: number;
  /** Fraction from the top of the viewport. */
  y: number;
}

/** A raw PDF user-space destination point (points, bottom-left origin, before /Rotate and
 * /CropBox). A coordinate is omitted when the destination does not name it. */
export interface PdfUserPoint {
  x?: number;
  y?: number;
}

/**
 * The destination point in raw PDF user space, for mapping links onto an unrotated display
 * list. XYZ keeps whichever of left/top is present; FitH/FitBH name a horizontal line (top),
 * FitV/FitBV a vertical line (left), and FitR resolves to the rectangle's top-left corner.
 * Fit/FitB and unknown kinds name no explicit point, so they return undefined.
 */
export function destinationUserPoint(dest: readonly unknown[]): PdfUserPoint | undefined {
  if (!Array.isArray(dest) || dest.length < 2) return undefined;
  const kind = destinationKind(dest);
  if (!kind) return undefined;
  switch (kind) {
    case 'XYZ': {
      const left = numberAt(dest, 2);
      const top = numberAt(dest, 3);
      if (left === undefined && top === undefined) return undefined;
      return { ...(left !== undefined ? { x: left } : {}), ...(top !== undefined ? { y: top } : {}) };
    }
    case 'FitH':
    case 'FitBH': {
      const top = numberAt(dest, 2);
      return top === undefined ? undefined : { y: top };
    }
    case 'FitV':
    case 'FitBV': {
      const left = numberAt(dest, 2);
      return left === undefined ? undefined : { x: left };
    }
    case 'FitR': {
      const left = numberAt(dest, 2);
      const bottom = numberAt(dest, 3);
      const right = numberAt(dest, 4);
      const top = numberAt(dest, 5);
      if (left === undefined || bottom === undefined || right === undefined || top === undefined) return undefined;
      return { x: Math.min(left, right), y: Math.max(bottom, top) };
    }
    default:
      return undefined;
  }
}

/**
 * Where a destination enters its target page, as fractions of that page's pdf.js viewport.
 *
 * `dest` is `[pageRef, {name}, ...coords]`. All conversion goes through the same viewport used to
 * draw the page, so /Rotate and a non-zero /CropBox are handled by pdf.js rather than by
 * assuming that PDF x grows right and y grows up on the screen. A missing XYZ coordinate is
 * replaced with the PDF point that maps to the viewport's top-left corner, which makes the
 * default entry point the page top-left on every rotation. Unknown kinds (and Fit/FitB) enter
 * at the page top, as the protocol promises.
 */
export function destinationPoint(dest: readonly unknown[], viewport: ViewportLike): PdfPoint | undefined {
  if (!Array.isArray(dest) || dest.length < 2) return undefined;
  const width = viewport.width;
  const height = viewport.height;
  if (!Number.isFinite(width) || !Number.isFinite(height) || !(width > 0) || !(height > 0)) return undefined;
  const kind = destinationKind(dest);
  if (!kind) return undefined;

  let corner: number[] | undefined;
  const pdfCorner = (): number[] | undefined => {
    if (!corner) {
      try {
        const point = viewport.convertToPdfPoint(0, 0);
        if (Array.isArray(point) && point.length >= 2 && Number.isFinite(point[0]) && Number.isFinite(point[1])) corner = point;
      } catch {
        return undefined;
      }
    }
    return corner;
  };
  const pointAt = (pdfX: number, pdfY: number): PdfPoint | undefined => {
    if (!Number.isFinite(pdfX) || !Number.isFinite(pdfY)) return undefined;
    try {
      const point = viewport.convertToViewportPoint(pdfX, pdfY);
      if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) return undefined;
      return { x: clamp01(point[0] / width), y: clamp01(point[1] / height) };
    } catch {
      return undefined;
    }
  };

  switch (kind) {
    case 'XYZ': {
      const left = numberAt(dest, 2);
      const top = numberAt(dest, 3);
      const fallback = pdfCorner();
      if (!fallback) return undefined;
      return pointAt(left ?? fallback[0], top ?? fallback[1]);
    }
    case 'FitH':
    case 'FitBH': {
      const top = numberAt(dest, 2);
      const fallback = pdfCorner();
      if (!fallback) return undefined;
      if (top === undefined) return { x: 0, y: 0 };
      return pointAt(fallback[0], top);
    }
    case 'FitV':
    case 'FitBV': {
      const left = numberAt(dest, 2);
      const fallback = pdfCorner();
      if (!fallback) return undefined;
      if (left === undefined) return { x: 0, y: 0 };
      return pointAt(left, fallback[1]);
    }
    case 'FitR': {
      const left = numberAt(dest, 2);
      const bottom = numberAt(dest, 3);
      const right = numberAt(dest, 4);
      const top = numberAt(dest, 5);
      if (left === undefined || bottom === undefined || right === undefined || top === undefined) return { x: 0, y: 0 };
      try {
        const rect = viewport.convertToViewportRectangle([left, bottom, right, top]);
        if (!Array.isArray(rect) || rect.length < 4 || !rect.slice(0, 4).every(Number.isFinite)) return undefined;
        return {
          x: clamp01(Math.min(rect[0], rect[2]) / width),
          y: clamp01(Math.min(rect[1], rect[3]) / height),
        };
      } catch {
        return undefined;
      }
    }
    case 'Fit':
    case 'FitB':
      return { x: 0, y: 0 };
    default:
      // pdf.js filters unknown destination kinds out of annotations, but a named destination
      // can still be odd; entering at the page top is the safe fallback.
      return { x: 0, y: 0 };
  }
}

/** The old, rotation-unaware vertical fraction helper, kept for tests and third-party callers.
 * New parsing must use `destinationPoint` with the target page's viewport instead. */
export function destinationY(dest: readonly unknown[], pageHeight: number): number {
  const kind = destinationKind(dest);
  const at = (i: number): number | undefined => {
    const value = dest[i];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  };
  const top = kind === 'XYZ' ? at(3) : kind === 'FitH' || kind === 'FitBH' ? at(2) : kind === 'FitR' ? at(5) : undefined;
  if (top === undefined || !(pageHeight > 0)) return 0;
  return clamp01(1 - top / pageHeight);
}

function destinationKind(dest: readonly unknown[]): string | undefined {
  const value = dest[1];
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const name = (value as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

function numberAt(dest: readonly unknown[], index: number): number | undefined {
  const value = dest[index];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
