// The words of a page for its selectable text layer (main.ts `renderTextLayer`): one
// transparent span per word over the glyphs the canvas drew, so the browser's own selection and
// copy work (#19). Pure, so the tests can run it.
import type { DisplayList, Item, Line } from '../src/protocol';

/** A word on the page, in sp: left edge, baseline, width and font size. */
export interface Word {
  x: number;
  y: number;
  w: number;
  size: number;
  text: string;
  /** Last word of its line: a line break follows. */
  eol: boolean;
}

export interface TextRow {
  dl: DisplayList;
  line: Line;
  dx: number;
  dy: number;
}

// OT1/T1 slots of TFM fonts that are not their ASCII character (ligatures, quotes, dashes)
const TFM_CHARS: Record<number, string> = {
  11: 'ff', 12: 'fi', 13: 'fl', 14: 'ffi', 15: 'ffl', 27: 'ff', 28: 'fi', 29: 'fl', 30: 'ffi', 31: 'ffl',
  16: '“', 17: '”', 21: '–', 22: '—', 34: '”', 92: '“', 96: '‘', 39: '’', 123: '–', 124: '—',
};

/** The text of glyph `char`: TFM fonts (no glyph index) number their slots by encoding, OpenType
 * fonts by Unicode; private-use codes (unnamed variants) give nothing. */
export function glyphText(char: number, index: unknown): string {
  if (index === null || index === undefined) {
    if (char in TFM_CHARS) return TFM_CHARS[char];
    return char > 32 && char < 127 ? String.fromCharCode(char) : '';
  }
  if (char <= 32 || (char >= 0xe000 && char <= 0xf8ff) || char >= 0xf0000 || char > 0x10ffff) return '';
  return String.fromCodePoint(char).normalize('NFKC');
}

/** A glyph that has text, in sp. `gap` says what separates it from the glyph before it in its
 * row: nothing, a space, or a break without a space (another baseline, a jump back). */
export interface RowGlyph {
  x: number;
  y: number;
  adv: number;
  size: number;
  text: string;
  /** Index of its row in the `rows` passed in. */
  row: number;
  gap: 'none' | 'space' | 'break';
}

/** The glyphs of `rows` that have text, in order: a gap wider than a sixth of the font size is a
 * space. */
export function rowGlyphs(rows: readonly TextRow[]): RowGlyph[] {
  const out: RowGlyph[] = [];
  rows.forEach(({ dl, line, dx, dy }, row) => {
    let prev: RowGlyph | undefined;
    let end = 0;
    for (const it of line.items as Item[]) {
      if (it[0] !== 'g') continue;
      const [, font, char, index, gx, gy, adv] = it as [string, number, number, number | null, number, number, number];
      const text = glyphText(char, index);
      if (!text) continue;
      const size = dl.fonts[String(font)]?.size ?? 655360;
      const x = gx + dx;
      const y = gy + dy;
      let gap: RowGlyph['gap'] = 'none';
      if (prev && (Math.abs(y - prev.y) > size * 0.3 || x - end > size / 6 || x < end - size)) {
        gap = Math.abs(y - prev.y) <= size * 0.3 ? 'space' : 'break';
      }
      prev = { x, y, adv: adv ?? 0, size, text, row, gap };
      out.push(prev);
      end = x + (adv ?? 0);
    }
  });
  return out;
}

/** Words of `rows`, in their order: glyphs on one baseline join into a word until a gap wider
 * than a sixth of the font size, which becomes a space. */
export function words(rows: readonly TextRow[]): Word[] {
  const out: Word[] = [];
  let cur: Word | undefined;
  let row = -1;
  const flush = () => {
    if (cur) out.push(cur);
    cur = undefined;
  };
  for (const g of rowGlyphs(rows)) {
    if (g.row !== row) {
      flush();
      if (out.length) out[out.length - 1].eol = true;
      row = g.row;
    } else if (g.gap !== 'none') {
      if (g.gap === 'space') cur!.text += ' ';
      flush();
    }
    if (!cur) cur = { x: g.x, y: g.y, w: 0, size: g.size, text: '', eol: false };
    cur.text += g.text;
    cur.w = Math.max(cur.w, g.x + g.adv - cur.x);
  }
  flush();
  if (out.length) out[out.length - 1].eol = true;
  return out;
}

/** Page lines in order, with each live row placed before the first page line below it. */
export function readingOrder(page: TextRow[], live: TextRow[]): TextRow[] {
  const pending = [...live].sort((a, b) => a.line.y + a.dy - (b.line.y + b.dy));
  const out: TextRow[] = [];
  for (const r of page) {
    while (pending.length && pending[0].line.y + pending[0].dy < r.line.y + r.dy) out.push(pending.shift()!);
    out.push(r);
  }
  return out.concat(pending);
}
