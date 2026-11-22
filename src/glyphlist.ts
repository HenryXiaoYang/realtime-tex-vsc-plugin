import * as fs from 'node:fs/promises';

export type GlyphList = Map<string, string>;

export function parseGlyphList(text: string): GlyphList {
  const out: GlyphList = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf(';');
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    const codes = line.slice(split + 1).split(',')[0].trim().split(/\s+/).filter(Boolean);
    if (!name || !codes.length) continue;
    try {
      const value = String.fromCodePoint(...codes.map((code) => parseInt(code, 16)));
      // private use (old-style digits, cmex pieces) means nothing once copied: leave the slot table's text
      if (/[\uE000-\uF8FF]/.test(value)) continue;
      // NFKC only to split the f-ligatures (ﬁ → fi): elsewhere it changes the glyph (ℓ → l, ´ → space + combining accent)
      const text = /[\uFB00-\uFB06]/.test(value) ? value.normalize('NFKC') : value.normalize('NFC');
      if (!out.has(name)) out.set(name, text);
    } catch {
    }
  }
  return out;
}

const FILES = ['texglyphlist.txt', 'glyphlist.txt', 'pdfglyphlist.txt'];

/** The glyph lists TeX ships, merged: the first file to name a glyph wins. `find` locates a file
 * (kpsewhich); a list it cannot find or read is skipped. */
export async function loadGlyphList(find: (file: string) => Promise<string | undefined>): Promise<GlyphList> {
  const merged: GlyphList = new Map();
  for (const name of FILES) {
    const file = await find(name);
    if (!file) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (!text) continue;
    for (const [key, value] of parseGlyphList(text)) if (!merged.has(key)) merged.set(key, value);
  }
  return merged;
}
