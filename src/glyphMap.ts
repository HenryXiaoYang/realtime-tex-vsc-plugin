// Character-exact mapping from preview glyphs to the source text of their unit. TeX keeps no
// column positions, so the glyph text of a unit is aligned with the unit's source text, with the
// markup that prints nothing taken out (longest common subsequence). Glyphs a macro printed
// (\ref, \cite, \today) match nothing and map to the source just after the matched text before
// them. Pure module.
import type { DisplayList, Line } from './protocol';
import type { PdfWord } from './messages';
import type { PreviewModel } from '../webview/model';
import { rowGlyphs, type RowGlyph, type TextRow } from '../webview/textLayer';

/** The text of `rows` (words, rows and baselines within a row split by a space) and, per glyph, where its text is. */
export interface GlyphText {
  text: string;
  glyphs: (RowGlyph & { start: number })[];
}

export function glyphTextOf(rows: readonly TextRow[]): GlyphText {
  let text = '';
  const glyphs: GlyphText['glyphs'] = [];
  let row = -1;
  for (const g of rowGlyphs(rows)) {
    if (text && (g.row !== row || g.gap !== 'none')) text += ' ';
    row = g.row;
    glyphs.push({ ...g, start: text.length });
    text += g.text;
  }
  return { text, glyphs };
}

/** A character of `text` under a click: the glyph whose box holds (`x`, `y`) or is nearest it,
 * and whether the click is on the character's right half (the caret goes after it). */
export function charAt(gt: GlyphText, x: number, y: number): { index: number; after: boolean; on: boolean } | undefined {
  // by each glyph's own baseline, not its row's: a row can hold several (a tabular is one row),
  // and PDF text runs share one. The glyph nearest across among those nearest the baseline.
  let best: GlyphText['glyphs'][number] | undefined;
  let bestV = Infinity;
  let bestX = Infinity;
  for (const g of gt.glyphs) {
    const [t, b] = [g.y - 0.75 * g.size, g.y + 0.25 * g.size];
    const v = y < t ? t - y : y > b ? y - b : 0;
    const dx = x < g.x ? g.x - x : x > g.x + g.adv ? x - g.x - g.adv : 0;
    if (v < bestV || (v === bestV && dx < bestX)) [best, bestV, bestX] = [g, v, dx];
  }
  if (!best) return undefined;
  // a ligature's glyph holds several characters: split its box evenly between them
  const f = best.adv > 0 ? Math.min(Math.max((x - best.x) / best.adv, 0), 0.999) * best.text.length : 0;
  return { index: best.start + Math.floor(f), after: f - Math.floor(f) >= 0.5, on: bestV === 0 && bestX === 0 };
}

/** Source text with the markup that prints nothing removed; `start`/`end` give each character's
 * source range (a `--` is one character there, like the dash it prints). */
export interface Visible {
  text: string;
  start: number[];
  end: number[];
}

// commands whose first argument is not printed (a label, a key, a file, an environment name)
const HIDDEN_ARG = new Set([
  'label', 'ref', 'eqref', 'pageref', 'autoref', 'nameref', 'cref', 'Cref', 'cite', 'citep', 'citet', 'parencite',
  'textcite', 'autocite', 'footcite', 'nocite', 'begin', 'end', 'includegraphics', 'input', 'include', 'hspace',
  'vspace', 'color', 'textcolor', 'href', 'index', 'hyperref', 'cline', 'multicolumn', 'multirow', 'setlength', 'addtolength',
]);

const TWO_HIDDEN_ARGS = new Set(['multicolumn', 'multirow']);

export function visibleSource(src: string): Visible {
  const v: Visible = { text: '', start: [], end: [] };
  const emit = (ch: string, s: number, e: number) => {
    v.text += ch;
    v.start.push(s);
    v.end.push(e);
  };
  const isLetter = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '@';
  /** Index after the balanced group opening at `i` (`open`/`close`), or `i` when none opens there. */
  const group = (i: number, open: string, close: string): number => {
    if (src[i] !== open) return i;
    let depth = 0;
    for (let k = i; k < src.length; k++) {
      if (src[k] === '\\') k++;
      else if (src[k] === open) depth++;
      else if (src[k] === close && --depth === 0) return k + 1;
    }
    return src.length;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '%') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '\\') {
      const n = src[i + 1] ?? '';
      if (isLetter(n)) {
        let k = i + 1;
        while (k < src.length && isLetter(src[k])) k++;
        const name = src.slice(i + 1, k);
        if (src[k] === '*') k++;
        while (src[k] === ' ' || src[k] === '\t') k++;
        if (src[k] === '\n') k++;
        if (HIDDEN_ARG.has(name)) {
          for (let j = group(k, '[', ']'); j !== k; j = group(k, '[', ']')) k = j;
          k = group(k, '{', '}');
          // a table cell's span and column spec: \multicolumn{2}{c}{text}, \multirow{3}{*}{text}
          if (TWO_HIDDEN_ARGS.has(name)) k = group(k, '{', '}');
        }
        i = k;
      } else {
        if ('&%$#_{}'.includes(n) && n) emit(n, i, i + 2);
        else if ((n === ' ' || n === '\\') && !v.text.endsWith(' ')) emit(' ', i, i + 2);
        i += 2;
      }
    } else if ('{}$&^_#'.includes(c)) {
      i++;
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '~') {
      if (v.text && !v.text.endsWith(' ')) emit(' ', i, i + 1);
      i++;
    } else if ((c === '`' || c === "'") && src[i + 1] === c) {
      emit('"', i, i + 2);
      i += 2;
    } else if (c === '`') {
      emit("'", i, i + 1);
      i++;
    } else if (c === '-') {
      const n = src.startsWith('---', i) ? 3 : src.startsWith('--', i) ? 2 : 1;
      emit('-', i, i + n);
      i += n;
    } else {
      emit(c, i, i + 1);
      i++;
    }
  }
  return v;
}

/** Glyph characters as the source spells them: curly quotes and dashes fold to ASCII. */
function fold(c: string): string {
  if (c === '“' || c === '”' || c === '„') return '"';
  if (c === '‘' || c === '’' || c === '`') return "'";
  if (c === '–' || c === '—' || c === '‐' || c === '−') return '-';
  if (c === ' ') return ' ';
  return c;
}

/** Cells of the alignment table beyond which a narrower window is aligned instead (16 MB). */
const MAX_CELLS = 8_000_000;

/**
 * Align `a` (glyph text) with `b` (visible source): for each character of `a`, the index of the
 * character of `b` it matches, or -1. Longest common subsequence; only `a[a0, a1)` and
 * `b[b0, b1)` take part.
 */
export function align(a: string, b: string, a0 = 0, a1 = a.length, b0 = 0, b1 = b.length): Int32Array {
  const out = new Int32Array(a.length).fill(-1);
  const n = a1 - a0;
  const m = b1 - b0;
  if (n <= 0 || m <= 0) return out;
  const w = m + 1;
  const dp = new Uint16Array((n + 1) * w);
  const fa = Array.from(a.slice(a0, a1), fold);
  for (let i = 1; i <= n; i++) {
    const ca = fa[i - 1];
    for (let j = 1; j <= m; j++) {
      dp[i * w + j] = ca === b[b0 + j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  for (let i = n, j = m; i > 0 && j > 0; ) {
    if (fa[i - 1] === b[b0 + j - 1] && dp[i * w + j] === dp[(i - 1) * w + j - 1] + 1) {
      out[a0 + i - 1] = b0 + j - 1;
      i--;
      j--;
    } else if (dp[(i - 1) * w + j] >= dp[i * w + j - 1]) i--;
    else j--;
  }
  return out;
}

/**
 * Offset in `src` (the unit's source text) of the character at `index` of `gt.text`, or the
 * offset just after it when `after`. Undefined when nothing around it matches.
 */
export function sourceOffset(gt: GlyphText, index: number, after: boolean, src: string): number | undefined {
  const vis = visibleSource(src);
  const n = gt.text.length;
  let [a0, a1, b0, b1] = [0, n, 0, vis.text.length];
  if (n * vis.text.length > MAX_CELLS) {
    // a long unit: align a few hundred characters around the click with the matching stretch of
    // the source, found by where the click falls in the unit
    a0 = Math.max(0, index - 300);
    a1 = Math.min(n, index + 300);
    const width = Math.min(vis.text.length, Math.floor(MAX_CELLS / (a1 - a0)));
    const mid = Math.round((index / Math.max(1, n)) * vis.text.length);
    b0 = Math.max(0, Math.min(vis.text.length - width, mid - (width >> 1)));
    b1 = b0 + width;
  }
  const match = align(gt.text, vis.text, a0, a1, b0, b1);
  if (match[index] >= 0) return after ? vis.end[match[index]] : vis.start[match[index]];
  // printed by a macro: just after the matched text before it, else just before the text after it
  for (let k = index - 1; k >= a0; k--) if (match[k] >= 0) return vis.end[match[k]];
  for (let k = index + 1; k < a1; k++) if (match[k] >= 0) return vis.start[match[k]];
  return undefined;
}

/** The rows of each unit on `page` as the preview draws them: a unit's live rows where it has
 * them, else its rows in the last layout. */
export function unitRows(model: PreviewModel, page: number): Map<number, TextRow[]> {
  const units = new Map<number, TextRow[]>();
  const pu = model.pages.get(page);
  if (!pu) return units;
  for (const { overlay, rows } of model.overlaysOn(page)) units.set(overlay.parId, rows.map((r) => ({ dl: overlay.dl, ...r })));
  for (const [parId, frags] of model.placements) {
    if (units.has(parId) || !frags.some((f) => f.page === page)) continue;
    const own = [...model.ownLines(page, parId)].sort((a, b) => a - b);
    units.set(parId, own.map((i) => ({ dl: pu.dl, line: pu.dl.lines[i], dx: 0, dy: 0 })));
  }
  return units;
}

/** The unit and character under a click at (page, x, y), in sp, as the preview draws the page:
 * a unit's live rows where it has them, else its rows in the last layout. */
export function clickedChar(
  model: PreviewModel,
  page: number,
  x: number,
  y: number,
  pdfText?: readonly PdfWord[],
): { parId: number; gt: GlyphText; index: number; after: boolean } | undefined {
  const units = unitRows(model, page);
  // nearest row above or below the click, and of those (two columns) the nearest across
  let best: { parId: number; rows: TextRow[]; v: number; h: number } | undefined;
  for (const [parId, rows] of units) {
    for (const { line, dx, dy } of rows) {
      const [l, r, t, b] = [line.x + dx, line.x + dx + line.w, line.y + dy - line.h, line.y + dy + line.d];
      const v = Math.max(t - y, 0, y - b);
      const h = Math.max(l - x, 0, x - r);
      if (!best || v < best.v || (v === best.v && h < best.h)) best = { parId, rows, v, h };
    }
  }
  // farther than about two lines from any text: not a click on this unit
  if (!best || best.v > 24 * 65536) return undefined;
  let rows = best.rows;
  let gt = glyphTextOf(rows);
  let at = charAt(gt, x, y);
  // a click on text only the PDF has (a TikZ label): the unit's PDF text instead
  const box = (w: PdfWord) => [w.x, w.x + w.w, w.y - 0.75 * w.size, w.y + 0.25 * w.size];
  const under = (w: PdfWord, px: number, py: number) => {
    const [l, r, t, b] = box(w);
    return px >= l && px <= r && py >= t && py <= b;
  };
  if (!at?.on && pdfText?.some((w) => under(w, x, y))) {
    const inUnit = (w: PdfWord) =>
      best.rows.some(({ line, dx, dy }) => {
        const [cx, cy] = [w.x + w.w / 2, w.y];
        return cx >= line.x + dx && cx <= line.x + dx + line.w && cy >= line.y + dy - line.h && cy <= line.y + dy + line.d;
      });
    rows = pdfRows(pdfText.filter((w) => under(w, x, y) || inUnit(w)));
    gt = glyphTextOf(rows);
    at = charAt(gt, x, y);
  }
  return at && { parId: best.parId, gt, index: at.index, after: at.after };
}

/** PDF text runs as display-list rows, one per run, its width shared evenly by its characters. */
function pdfRows(ws: readonly PdfWord[]): TextRow[] {
  return ws.map((w, i) => {
    const chars = Array.from(w.text);
    const adv = w.w / Math.max(1, chars.length);
    const dl = { fonts: { [i]: { id: i, size: w.size } } } as unknown as DisplayList;
    const items = chars.map((ch, k) => ['g', i, ch.codePointAt(0)!, 0, w.x + k * adv, w.y, adv, 0]) as Line['items'];
    return { dl, line: { x: w.x, y: w.y, w: w.w, h: 0.75 * w.size, d: 0.25 * w.size, items }, dx: 0, dy: 0 };
  });
}
