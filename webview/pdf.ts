// pdf.js: pages the live renderer cannot draw exactly (TikZ, specials, unsupported fonts) and
// PDF images included with \includegraphics.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

let workerReady: Promise<void> | undefined;

/** pdf.js runs its parser in a worker; webviews cannot start workers from resource URLs, so
 * the worker module is fetched and started from a blob URL. */
export function initPdfWorker(workerUrl: string): Promise<void> {
  workerReady ??= (async () => {
    const code = await (await fetch(workerUrl)).text();
    const blob = new Blob([code], { type: 'text/javascript' });
    pdfjs.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(blob), { type: 'module' });
  })();
  return workerReady;
}

export type PdfDoc = pdfjs.PDFDocumentProxy;

export async function openPdf(data: Uint8Array): Promise<PdfDoc> {
  await workerReady;
  // pdf.js transfers the buffer to the worker: hand it a copy
  return pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, disableFontFace: false }).promise;
}

/** Render page `n` (1-based) into `ctx`, scaled to `width`×`height` device pixels. */
export async function renderPdfPage(doc: PdfDoc, n: number, ctx: CanvasRenderingContext2D, width: number, height: number): Promise<void> {
  const page = await doc.getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: Math.min(width / vp1.width, height / vp1.height) });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  await page.render({ canvasContext: ctx, viewport }).promise;
}

/** Rasterize a PDF image (page `n`) for drawing with drawImage. */
export async function rasterizePdfImage(data: Uint8Array, n: number): Promise<CanvasImageSource> {
  const doc = await openPdf(data);
  const page = await doc.getPage(Math.max(1, Math.min(n, doc.numPages)));
  const vp1 = page.getViewport({ scale: 1 });
  // enough pixels for a sharp figure at 200 % zoom on a 2× screen
  const scale = Math.min(6, 2400 / Math.max(vp1.width, vp1.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
  void doc.destroy();
  return canvas;
}
