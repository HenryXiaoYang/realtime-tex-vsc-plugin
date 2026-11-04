// The text of a page drawn from its PDF (pdf.js text content), placed in display-list sp: a
// click on text the display list does not have, such as a TikZ label, is matched with this.
// Pure, so the tests can run it.
import type { PdfWord } from '../src/messages';

/** pdf.js text items placed by viewport transform `vt`, whose units are sp (`scale` sp per PDF
 * unit). Rotated and empty items are left out. */
export function pdfWords(items: readonly unknown[], vt: readonly number[], scale: number): PdfWord[] {
  const out: PdfWord[] = [];
  for (const it of items as { str?: unknown; transform?: unknown; width?: unknown }[]) {
    if (typeof it?.str !== 'string' || !it.str.trim() || !Array.isArray(it.transform) || typeof it.width !== 'number') continue;
    const [a, b, c, d, e, f] = it.transform as number[];
    const size = Math.hypot(vt[0] * c + vt[2] * d, vt[1] * c + vt[3] * d);
    if (!(size > 0) || Math.abs(vt[1] * a + vt[3] * b) > 1e-3 * size) continue;
    out.push({ text: it.str, x: vt[0] * e + vt[2] * f + vt[4], y: vt[1] * e + vt[3] * f + vt[5], w: it.width * scale, size });
  }
  return out;
}
