// Messages between the extension host and the preview webview.
import type { FontResource, ImageResource } from './fontKey';
import type { DisplayList, Fragment, PageUpdate, Placement } from './protocol';

export type ScreenKind = 'starting' | 'compiling' | 'error' | 'noMain' | 'notInstalled' | 'stopped' | 'unsupported';

export interface Action {
  label: string;
  command: string;
  args?: unknown[];
  primary?: boolean;
}

export type PillKind = 'live' | 'busy' | 'ok' | 'warn' | 'error' | 'idle';

export type HostToWebview =
  | { type: 'screen'; screen: ScreenKind | null; title?: string; message?: string; detail?: string; actions?: Action[] }
  | { type: 'banner'; text: string | null; kind?: 'info' | 'warn' | 'error'; actions?: Action[] }
  | { type: 'status'; text: string; kind: PillKind; tooltip: string }
  | {
      type: 'layout';
      pages: PageUpdate[];
      pagesTotal: number;
      placements: Placement[];
      keepFromRevision: number | null;
      /** The background PDF, when some page may need it. */
      pdf: Uint8Array | null;
    }
  | { type: 'paragraph'; parId: number; dl: DisplayList; fragments: Fragment[]; revision: number }
  | { type: 'dropOverlays'; parIds?: number[] }
  | { type: 'resources'; fonts: [string, FontResource][]; images: [string, ImageResource][] }
  | { type: 'reveal'; page: number; x: number; y: number; force: boolean }
  | { type: 'config'; follow: boolean; invert: boolean; zoom?: string }
  | { type: 'hint'; text: string }
  | { type: 'reset' };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'jump'; page: number; x: number; y: number }
  | { type: 'command'; command: string; args?: unknown[] }
  | { type: 'setFollow'; value: boolean }
  | { type: 'error'; message: string }
  | { type: 'log'; message: string };
