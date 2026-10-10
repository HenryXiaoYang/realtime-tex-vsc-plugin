// Which parts of the source update live and which wait for the full compile, for the gutter
// markers next to the line numbers. Pure module.
import type { Span } from './protocol';

export type LiveKind = 'live' | 'full';

export interface LiveMark {
  span: Span;
  kind: LiveKind;
  /** rtex's reasons, when an edit of this part went to the full compile. */
  reasons?: string[];
}

/**
 * The last layout says which units a one-character edit would typeset live
 * (`eligible_paragraphs`); what edits actually did since then refines it until the next layout.
 */
export class LiveState {
  private eligible = new Set<number>();
  private placed = new Set<number>();
  private seen = new Map<number, { live: boolean; reasons: string[] }>();

  get hasLayout(): boolean {
    return this.placed.size > 0;
  }

  /** A new layout: its verdicts replace what edits showed, except a unit the live engine failed
   * on, which stays on the full compile until the preamble changes. */
  layout(eligible: readonly number[], placed: Iterable<number>): void {
    this.eligible = new Set(eligible);
    this.placed = new Set(placed);
    for (const [id, s] of [...this.seen]) if (s.live || !s.reasons.some(isQuarantine)) this.seen.delete(id);
  }

  /** What an edit (or the engine after it) did with units `ids`. */
  observed(ids: readonly number[], live: boolean, reasons: readonly string[] = []): void {
    for (const id of ids) this.seen.set(id, { live, reasons: [...reasons] });
  }

  /** The engine restarted (preamble change): nothing carries over. */
  restarted(): void {
    this.seen.clear();
  }

  clear(): void {
    this.eligible.clear();
    this.placed.clear();
    this.seen.clear();
  }

  /** The mark for each span; spans nothing is known about yet (new text before a layout) and
   * the text after \end{document} get none. */
  marks(spans: readonly Span[]): LiveMark[] {
    if (!this.hasLayout) return [];
    const out: LiveMark[] = [];
    for (const span of spans) {
      if (span.kind === 'Trailer') continue;
      if (span.kind === 'Preamble') {
        out.push({ span, kind: 'full' });
        continue;
      }
      const s = this.seen.get(span.id);
      if (s) out.push({ span, kind: s.live ? 'live' : 'full', reasons: s.live ? undefined : s.reasons });
      else if (this.eligible.has(span.id)) out.push({ span, kind: 'live' });
      else if (this.placed.has(span.id)) out.push({ span, kind: 'full' });
    }
    return out;
  }
}

function isQuarantine(r: string): boolean {
  return /EngineFailed|quarantin/i.test(r);
}

/** `[start, end)` of `text` without leading and trailing whitespace (the blank lines between
 * paragraphs belong to a span but should not be marked); undefined when nothing is left. */
export function trimRange(text: string, start: number, end: number): [number, number] | undefined {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  return end > start ? [start, end] : undefined;
}
