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

/** Words of `rows`, in their order: glyphs on one baseline join into a word until a gap wider
 * than a sixth of the font size, which becomes a space. */
export function words(rows: readonly TextRow[]): Word[] {
  const out: Word[] = [];
  for (const { dl, line, dx, dy } of rows) {
    let cur: Word | undefined;
    let end = 0;
    const flush = () => {
      if (cur && cur.text) out.push(cur);
      cur = undefined;
    };
    for (const it of line.items as Item[]) {
      if (it[0] !== 'g') continue;
      const [, font, char, index, gx, gy, adv] = it as [string, number, number, number | null, number, number, number];
      const text = glyphText(char, index);
      if (!text) continue;
      const size = dl.fonts[String(font)]?.size ?? 655360;
      const x = gx + dx;
      const y = gy + dy;
      if (cur && (Math.abs(y - cur.y) > size * 0.3 || x - end > size / 6 || x < end - size)) {
        if (Math.abs(y - cur.y) <= size * 0.3) cur.text += ' ';
        flush();
      }
      if (!cur) cur = { x, y, w: 0, size, text: '', eol: false };
      cur.text += text;
      end = x + (adv ?? 0);
      cur.w = Math.max(cur.w, end - cur.x);
    }
    flush();
    if (out.length) out[out.length - 1].eol = true;
  }
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
