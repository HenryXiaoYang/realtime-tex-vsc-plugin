// PDF.js link parsing. This module is bundled only into dist/pdf-links.worker.js: importing it
// from the extension host would put PDF.js back on the host's event loop, which is exactly what
// the worker exists to avoid.
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  destinationPoint,
  destinationUserPoint,
  PdfLinkError,
  rectFractions,
  safeLinkUrl,
  viewAspect,
  type PdfRect,
  type ViewportLike,
} from './pdfLinkCore';
import type { PdfLink, PdfLinkTarget } from './protocol';

/** A link annotation as pdf.js reports it (only the fields we use). */
interface AnnotationLike {
  subtype?: string;
  rect?: number[];
  url?: string | null;
  dest?: unknown;
}

interface PageLike {
  getViewport(params: { scale: number }): ViewportLike;
  getAnnotations(): Promise<unknown[]>;
}

interface DocumentLike {
  numPages: number;
  getPage(n: number): Promise<PageLike>;
  getDestination(name: string): Promise<unknown[] | null>;
  getPageIndex(ref: unknown): Promise<number>;
}

interface LoadingTaskLike {
  promise: Promise<unknown>;
  destroy(): Promise<void>;
}

type PdfJs = typeof import('pdfjs-dist');

let pdfjs: Promise<PdfJs> | undefined;

/** pdf.js's real API, loaded on first use. A rejected initialization is not cached. */
async function loadPdfjs(): Promise<PdfJs> {
  if (!pdfjs) {
    pdfjs = (async () => {
      const mod = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as PdfJs;
      mod.GlobalWorkerOptions.workerSrc = pathToFileURL(pdfjsWorkerFile()).href;
      return mod;
    })();
  }
  try {
    return await pdfjs;
  } catch (error) {
    pdfjs = undefined;
    throw error;
  }
}

/** dist/pdf.worker.mjs next to this bundle. No cwd, project or node_modules guessing. */
function pdfjsWorkerFile(): string {
  const candidates = [
    path.join(__dirname, 'pdf.worker.mjs'), // dist/ or out/test/
    path.join(__dirname, '..', 'dist', 'pdf.worker.mjs'), // a test bundle outside dist
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  if (!file) throw new PdfLinkError('worker', `pdf.js worker is missing (looked in ${candidates.join(', ')})`);
  return file;
}

/**
 * Read every link annotation in `data` and express its rectangle and target as viewport
 * fractions. A malformed page or destination only drops the affected link; an unreadable
 * document, a page-count mismatch or an incomplete file rejects instead of looking like a PDF
 * without links.
 */
export async function readPdfLinks(data: Uint8Array, expectedPages?: number): Promise<PdfLink[]> {
  const lib = await loadPdfjs();
  let task: LoadingTaskLike | undefined;
  try {
    task = lib.getDocument({
      data,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      useWorkerFetch: false,
      verbosity: 0,
    }) as unknown as LoadingTaskLike;
    const doc = (await task.promise) as DocumentLike;
    if (!Number.isInteger(doc.numPages) || doc.numPages < 1) {
      throw new PdfLinkError('invalid', `PDF reports an unusable page count (${String(doc.numPages)})`);
    }
    if (expectedPages !== undefined && doc.numPages !== expectedPages) {
      throw new PdfLinkError('pages', `PDF has ${doc.numPages} pages but the layout expects ${expectedPages}`);
    }
    return await collectLinks(doc);
  } catch (error) {
    if (error instanceof PdfLinkError) throw error;
    throw new PdfLinkError('invalid', `Could not read the PDF: ${errorMessage(error)}`, { cause: error });
  } finally {
    if (task) await task.destroy().catch(() => undefined);
  }
}

async function collectLinks(doc: DocumentLike): Promise<PdfLink[]> {
  const pagePromises = new Map<number, Promise<PageLike>>();
  const viewports = new Map<number, ViewportLike>();
  const namedDestinations = new Map<string, Promise<unknown[] | null>>();
  const pageIndexes = new Map<string, Promise<number | undefined>>();

  const getPage = (page: number): Promise<PageLike> => {
    let promise = pagePromises.get(page);
    if (!promise) {
      promise = doc.getPage(page);
      pagePromises.set(page, promise);
    }
    return promise;
  };

  const getViewport = async (pageNumber: number): Promise<ViewportLike | undefined> => {
    const cached = viewports.get(pageNumber);
    if (cached) return cached;
    try {
      const page = await getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (!viewAspect(viewport)) return undefined;
      viewports.set(pageNumber, viewport);
      return viewport;
    } catch {
      return undefined;
    }
  };

  const getDestination = (name: string): Promise<unknown[] | null> => {
    let promise = namedDestinations.get(name);
    if (!promise) {
      promise = doc.getDestination(name).catch(() => null);
      namedDestinations.set(name, promise);
    }
    return promise;
  };

  const getPageIndex = (ref: unknown): Promise<number | undefined> => {
    if (typeof ref === 'number' && Number.isInteger(ref)) return Promise.resolve(ref);
    const key = refKey(ref);
    if (!key) return Promise.resolve(undefined);
    let promise = pageIndexes.get(key);
    if (!promise) {
      promise = doc.getPageIndex(ref).catch(() => undefined);
      pageIndexes.set(key, promise);
    }
    return promise;
  };

  const destinationArray = async (raw: unknown): Promise<unknown[] | undefined> => {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string' && raw.length > 0) {
      const dest = await getDestination(raw);
      return Array.isArray(dest) ? dest : undefined;
    }
    return undefined;
  };

  const resolvePageTarget = async (dest: readonly unknown[]): Promise<PdfLinkTarget | undefined> => {
    if (dest.length < 2) return undefined;
    const pageIndex = await getPageIndex(dest[0]);
    if (pageIndex === undefined || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) return undefined;
    const pageNumber = pageIndex + 1;
    const viewport = await getViewport(pageNumber);
    if (!viewport) return undefined;
    const pageAspect = viewAspect(viewport);
    if (!pageAspect) return undefined;
    const point = destinationPoint(dest, viewport);
    if (!point) return undefined;
    const user = destinationUserPoint(dest);
    return {
      kind: 'page',
      page: pageNumber,
      x: point.x,
      y: point.y,
      pageAspect,
      ...(user?.x !== undefined ? { userX: user.x } : {}),
      ...(user?.y !== undefined ? { userY: user.y } : {}),
    };
  };

  const resolveTarget = async (annotation: AnnotationLike): Promise<PdfLinkTarget | undefined> => {
    if (typeof annotation.url === 'string') {
      const url = safeLinkUrl(annotation.url);
      if (url) return { kind: 'url', url };
    }
    try {
      const dest = await destinationArray(annotation.dest);
      if (!dest) return undefined;
      return await resolvePageTarget(dest);
    } catch {
      return undefined; // a broken or unsupported destination is not a reason to drop the others
    }
  };

  const links: PdfLink[] = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
    let page: PageLike;
    try {
      page = await getPage(pageNumber);
    } catch {
      continue; // a damaged page must not discard the links found on the other pages
    }
    let viewport: ViewportLike;
    try {
      viewport = page.getViewport({ scale: 1 });
    } catch {
      continue;
    }
    const pageAspect = viewAspect(viewport);
    if (!pageAspect) continue;
    viewports.set(pageNumber, viewport);

    let annotations: unknown[];
    try {
      annotations = await page.getAnnotations();
    } catch {
      continue;
    }
    if (!Array.isArray(annotations)) continue;

    for (const raw of annotations) {
      if (!raw || typeof raw !== 'object') continue;
      const annotation = raw as AnnotationLike;
      if (annotation.subtype !== 'Link' || !Array.isArray(annotation.rect) || annotation.rect.length < 4) continue;
      const rect = annotationRect(annotation.rect, viewport);
      if (!rect) continue;
      const target = await resolveTarget(annotation);
      if (!target) continue;
      const userRect = annotationUserRect(annotation.rect);
      links.push({ page: pageNumber, ...rect, pageAspect, ...(userRect ? { userRect } : {}), target });
    }
  }
  return links;
}

function annotationRect(rect: number[], viewport: ViewportLike): PdfRect | undefined {
  const converted = viewport.convertToViewportRectangle(rect);
  if (!Array.isArray(converted) || converted.length < 4) return undefined;
  return rectFractions(converted[0], converted[1], converted[2], converted[3], viewport.width, viewport.height);
}

/** The annotation's /Rect exactly as the PDF states it: PDF points, bottom-left origin,
 * unaffected by /Rotate and /CropBox. */
function annotationUserRect(rect: number[]): [number, number, number, number] | undefined {
  if (rect.length < 4) return undefined;
  const [x1, y1, x2, y2] = rect;
  if (![x1, y1, x2, y2].every((value) => typeof value === 'number' && Number.isFinite(value))) return undefined;
  return [x1, y1, x2, y2];
}

function refKey(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const { num, gen } = ref as { num?: unknown; gen?: unknown };
  if (Number.isInteger(num) && Number.isInteger(gen)) return `${String(num)}:${String(gen)}`;
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
