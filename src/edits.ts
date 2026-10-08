// Translating VS Code text changes (UTF-16 offsets) into rtex edits (UTF-8 byte offsets).
// Pure module: no vscode imports, so it is unit-tested with node:test.

/** One VS Code content change, in the shape of `vscode.TextDocumentContentChangeEvent`. */
export interface TextChange {
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

/** An edit in rtex terms: replace bytes [start, end) with `text`. */
export interface ByteEdit {
  start: number;
  end: number;
  text: string;
}

const BLOCK = 4096;

/** UTF-8 length of `s[from, to)` counted per UTF-16 unit (a surrogate unit counts 2 bytes, so a
 * pair counts 4 and the count is additive across any split point). */
export function utf8Length(s: string, from = 0, to = s.length): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdfff) n += 2;
    else n += 3;
  }
  return n;
}

/**
 * A copy of a document's text with cached UTF-16 → UTF-8 offset checkpoints.
 *
 * Checkpoint k holds the byte offset of UTF-16 offset k·BLOCK. An edit only invalidates the
 * checkpoints after it, and typing happens in one place, so each keystroke costs O(BLOCK).
 */
export class ShadowText {
  private cps: number[] = [0];

  constructor(private textValue: string) {}

  get text(): string {
    return this.textValue;
  }

  get length(): number {
    return this.textValue.length;
  }

  reset(text: string): void {
    this.textValue = text;
    this.cps = [0];
  }

  /** Byte offset of UTF-16 offset `off`. */
  byteOffset(off: number): number {
    off = Math.max(0, Math.min(off, this.textValue.length));
    const k = Math.floor(off / BLOCK);
    this.ensure(k);
    const base = Math.min(k, this.cps.length - 1);
    return this.cps[base] + utf8Length(this.textValue, base * BLOCK, off);
  }

  /** UTF-16 offset of byte offset `b` (clamped to a character boundary at or before `b`). */
  utf16Offset(b: number): number {
    if (b <= 0) return 0;
    const lastK = Math.floor(this.textValue.length / BLOCK);
    this.ensure(lastK);
    // binary search the last checkpoint with byte offset <= b
    let lo = 0;
    let hi = this.cps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cps[mid] <= b) lo = mid;
      else hi = mid - 1;
    }
    let off = lo * BLOCK;
    let bytes = this.cps[lo];
    const s = this.textValue;
    while (off < s.length) {
      const c = s.charCodeAt(off);
      let w: number;
      let units = 1;
      if (c < 0x80) w = 1;
      else if (c < 0x800) w = 2;
      else if (c >= 0xd800 && c <= 0xdbff && off + 1 < s.length) {
        w = 4;
        units = 2;
      } else if (c >= 0xd800 && c <= 0xdfff) w = 2; // half of a pair split by a checkpoint
      else w = 3;
      if (bytes + w > b) break;
      bytes += w;
      off += units;
    }
    return off;
  }

  /** Apply changes in order (VS Code applies an event's changes sequentially) and return the
   * equivalent byte edits, each relative to the text left by the previous one. */
  apply(changes: readonly TextChange[]): ByteEdit[] {
    const out: ByteEdit[] = [];
    for (const ch of changes) {
      const start = this.byteOffset(ch.rangeOffset);
      const end = start + utf8Length(this.textValue, ch.rangeOffset, ch.rangeOffset + ch.rangeLength);
      out.push({ start, end, text: ch.text });
      this.textValue =
        this.textValue.slice(0, ch.rangeOffset) + ch.text + this.textValue.slice(ch.rangeOffset + ch.rangeLength);
      // checkpoints at or before the change start stay valid
      const keep = Math.floor(ch.rangeOffset / BLOCK) + 1;
      if (this.cps.length > keep) this.cps.length = keep;
    }
    return out;
  }

  private ensure(k: number): void {
    const s = this.textValue;
    const maxK = Math.floor(s.length / BLOCK);
    k = Math.min(k, maxK);
    while (this.cps.length <= k) {
      const j = this.cps.length;
      this.cps.push(this.cps[j - 1] + utf8Length(s, (j - 1) * BLOCK, j * BLOCK));
    }
  }
}
