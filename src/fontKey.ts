// Shared by the extension host and the webview: the key of the font *resource* (outline data)
// a display-list font descriptor needs. Font ids are per process; sizes and transforms come from
// the descriptor, so one resource serves every size of a font file.
import type { FontDesc } from './protocol';

export function fontKey(desc: FontDesc): string {
  if (desc.filename) return `file:${desc.filename}#${desc.subfont ?? 0}`;
  return `tfm:${desc.name ?? desc.id}`;
}

/** Font resources the webview can draw. */
export type FontResource =
  | { kind: 'sfnt'; data: Uint8Array }
  | { kind: 'type1'; upem: number; glyphs: Record<number, string>; slant?: number; extend?: number }
  | { kind: 'missing'; reason: string };

export type ImageResource = { kind: 'bitmap' | 'pdf'; mime: string; data: Uint8Array } | { kind: 'missing'; reason: string };
