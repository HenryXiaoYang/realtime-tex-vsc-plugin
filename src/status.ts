// What the session is doing, in words for the status bar and the preview's status pill.
// Pure module.
import type { PillKind } from './messages';
import type { CompileStatus, Convergence } from './protocol';

export type Phase = 'idle' | 'starting' | 'compiling' | 'live' | 'stopped' | 'failed';

export interface SessionStatus {
  phase: Phase;
  /** A background pass is scheduled or running. */
  pending: boolean;
  convergence?: Convergence;
  compile?: CompileStatus;
  /** Duration of the last fast update, ms. */
  lastFastMs?: number;
  /** Why the last edit could not be shown instantly. */
  lastBackgroundReason?: string;
  errorCount: number;
  pagesTotal: number;
  mainName?: string;
}

export interface StatusText {
  text: string;
  kind: PillKind;
  tooltip: string;
}

const fmtMs = (ms: number) => (ms < 10 ? ms.toFixed(1) : Math.round(ms).toString());

/** Plain-language explanation of rtex's reasons for routing an edit to the background path. */
export function explainReasons(reasons: readonly string[]): string {
  if (reasons.length === 0) return 'the change affects more than one paragraph';
  const r = reasons.join(', ');
  const env = /DisallowedEnvironment\("([^"]+)"\)|environment (\S+) is not on/.exec(r);
  if (env) return `the ${env[1] ?? env[2]} environment is not supported by live typesetting yet`;
  const macro = /(?:math )?macro (\\\S+)/.exec(r);
  if (macro && !/preamble/i.test(r)) return `${macro[1]}${/math macro/.test(r) ? ' inside math' : ''} is not supported by live typesetting yet`;
  const map: [RegExp, string][] = [
    [/preamble/i, 'the preamble changed (the engine reloads it)'],
    [/ParagraphBreak|boundar/i, 'paragraphs were split or merged'],
    [/inserts/i, 'footnote text is placed with the page'],
    [/NoPlacement/i, 'this part has no position from the last full compile yet'],
    [/no ?context|context no longer/i, 'this paragraph is new to the engine'],
    [/budget|slow|over/i, 'this paragraph takes too long to typeset live'],
    [/env/i, 'this environment is updated by the full compile'],
    [/engine restarted/i, 'the engine restarted'],
  ];
  for (const [re, text] of map) if (re.test(r)) return text;
  return r;
}

export function describe(s: SessionStatus): StatusText {
  switch (s.phase) {
    case 'idle':
      return { text: 'Live Preview', kind: 'idle', tooltip: 'Open the live preview of this LaTeX document (Ctrl+Alt+V)' };
    case 'starting':
      return {
        text: 'Starting…',
        kind: 'busy',
        tooltip: 'Starting LuaLaTeX and loading your preamble. The first start takes a few seconds.',
      };
    case 'stopped':
      return { text: 'Stopped', kind: 'idle', tooltip: 'The engine is stopped. Open the preview to start it again.' };
    case 'failed':
      return { text: 'Engine stopped', kind: 'error', tooltip: 'The engine stopped unexpectedly. Click to see the log.' };
    case 'compiling':
      return {
        text: 'Typesetting…',
        kind: 'busy',
        tooltip: 'Running the first full compile of the document. Afterwards, edits appear as you type.',
      };
  }
  // live
  const conv = s.convergence;
  if (s.compile?.state === 'Failed') {
    return { text: 'Compile failed', kind: 'error', tooltip: 'The last full compile produced no pages. Click to see the problems.' };
  }
  if (s.errorCount > 0) {
    return {
      text: `${s.errorCount} error${s.errorCount === 1 ? '' : 's'}`,
      kind: 'error',
      tooltip: 'LaTeX reported errors. The preview shows the best output so far. Click to open the Problems panel.',
    };
  }
  if (s.pending || conv?.state === 'Stale' || conv?.state === 'Converging') {
    const why = s.lastBackgroundReason ? ` because ${s.lastBackgroundReason}` : '';
    return {
      text: 'Updating layout…',
      kind: 'busy',
      tooltip: `A full compile is running${why}. It updates page breaks, references and anything the live path cannot change instantly.`,
    };
  }
  if (conv?.state === 'PassLimitReached') {
    return {
      text: 'Not settled',
      kind: 'warn',
      tooltip: `References or page numbers still changed after ${conv.passes} compiles (${conv.reasons.join(', ') || 'aux files keep changing'}). Click to see the problems.`,
    };
  }
  if (s.lastFastMs !== undefined) {
    return {
      text: `Live · ${fmtMs(s.lastFastMs)} ms`,
      kind: 'live',
      tooltip: `The paragraph you edited was re-typeset in ${fmtMs(s.lastFastMs)} ms. Everything is up to date.`,
    };
  }
  return { text: 'Up to date', kind: 'ok', tooltip: 'The preview matches your document. Edits appear as you type.' };
}
