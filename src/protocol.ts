// Types of the `rtex serve` JSON-lines protocol (realtime-tex crates/rtex-cli/src/serve.rs and
// crates/rtex-core/src/session.rs). Display lists use the JSON mirror of docs/DISPLAY_LIST.md.

export type Sp = number;

export interface Versions {
  source_revision: number;
  context_revision: number;
  engine_generation: number;
  layout_version: number;
}

export interface FontDesc {
  id: number;
  name?: string | null;
  fullname?: string | null;
  psname?: string | null;
  filename?: string | null;
  format?: string | null;
  type?: string | null;
  size?: number | null;
  designsize?: number | null;
  slant?: number | null;
  extend?: number | null;
  squeeze?: number | null;
  subfont?: number | null;
}

/** Items: ["g",font,char,index,x,y,w,ef] ["r",x,y_top,w,h] ["c",stack,cmd,data] ["l",mode,data]
 * ["u",kind,detail] ["m","on"|"off",x] ["i",index,x,y_top,w,h] ["M","save"|"set"|"restore",x,y,data] */
export type Item = [string, ...unknown[]];

export interface Line {
  par?: number;
  i?: number;
  unit?: number;
  row?: number;
  x: Sp;
  y: Sp;
  w: Sp;
  h: Sp;
  d: Sp;
  items: Item[];
}

export interface ImageInfo {
  file: string;
  page?: number;
  pages?: number;
}

export interface DisplayList {
  kind: string;
  fonts: Record<string, FontDesc>;
  lines: Line[];
  other: Item[];
  flags: unknown;
  glyphs?: number;
  inserts?: number;
  images_info?: Record<string, ImageInfo>;
  width: Sp;
  height: Sp;
  depth: Sp;
  page?: number | null;
  page_width?: Sp;
  page_height?: Sp;
}

export interface Fragment {
  page: number;
  first_line: number;
  last_line: number;
  x: Sp;
  xs: Sp[];
  baselines: Sp[];
  approximate: boolean;
}

export interface Placement {
  par_id: number;
  fragments: Fragment[];
  lines: number;
  kind: string;
}

export interface PageUpdate {
  page: number;
  exact: boolean;
  hash: number;
  dl: DisplayList;
}

export type Convergence =
  | { state: 'Converged' }
  | { state: 'Converging'; pass: number; reasons: string[] }
  | { state: 'PassLimitReached'; passes: number; reasons: string[] }
  | { state: 'Stale'; pending_since: number };

export type CompileStatus = { state: 'Ok' } | { state: 'CompiledWithErrors'; count: number } | { state: 'Failed' };

export interface Diagnostic {
  severity: string;
  file?: string | null;
  line?: number | null;
  message: string;
  context?: string | null;
}

export interface Timing {
  total_us: number;
  tex_us: number;
  traverse_us: number;
  pack_us: number;
}

export interface ParagraphUpdateEvent {
  event: 'ParagraphUpdate';
  par_id: number;
  edit_id: number;
  versions: Versions;
  status: string;
  reasons: string[];
  fragments: Fragment[];
  pagination_stale: boolean;
  context_stale: boolean;
  dl: DisplayList;
  diagnostics: Diagnostic[];
  timing: Timing;
}

export interface LayoutUpdateEvent {
  event: 'LayoutUpdate';
  versions: Versions;
  compile: CompileStatus;
  convergence: Convergence;
  passes: number;
  pages_changed: PageUpdate[];
  pages_total: number;
  placements: Placement[];
  eligible_paragraphs: number[];
  pdf_fallback: string | null;
  wall_ms: number;
}

export interface DiagnosticsEvent {
  event: 'Diagnostics';
  source: string;
  items: Diagnostic[];
}

export interface EngineStateEvent {
  event: 'EngineState';
  engine_generation: number;
  state: string;
  reason: string | null;
}

export interface BackgroundScheduledEvent {
  event: 'BackgroundScheduled';
  par_id: number | null;
  reasons: string[];
  edit_id: number;
}

export interface PdfExportedEvent {
  event: 'PdfExported';
  job_id: number;
  path: string | null;
  status: CompileStatus;
  converged: boolean;
  passes: number;
}

export type RtexEvent =
  | ParagraphUpdateEvent
  | LayoutUpdateEvent
  | DiagnosticsEvent
  | EngineStateEvent
  | BackgroundScheduledEvent
  | PdfExportedEvent;

export interface EditOutcome {
  touched: number[];
  added: number[];
  removed: number[];
}

export interface EditResult {
  edit_id: number;
  source_revision: number;
  outcome: EditOutcome;
  routed: 'fast' | 'background' | 'preamble' | string;
  reasons: string[];
}

export interface Span {
  id: number;
  range: { start: number; end: number };
  kind: 'Preamble' | 'Body' | 'Env' | 'Heading' | 'Trailer';
  hash: number;
  last_revision: number;
}

export type Reply =
  | { reply: 'edit'; result: EditResult }
  | { reply: 'set_document'; result: EditResult }
  | { reply: 'spans'; spans: Span[] }
  | { reply: 'status'; versions: Versions; convergence: Convergence | null }
  | { reply: 'request_layout' }
  | { reply: 'export_pdf'; job_id: number }
  | { reply: 'error'; message: string };

export type Command =
  | { cmd: 'edit'; path: string; start: number; end: number; text: string }
  | { cmd: 'set_document'; path: string; text: string }
  | { cmd: 'spans'; path: string }
  | { cmd: 'status' }
  | { cmd: 'request_layout' }
  | { cmd: 'export_pdf'; out: string }
  | { cmd: 'quit' };

/** 1 pt = 65536 sp; 1 bp = 65781.76 sp. */
export const SP_PER_PT = 65536;
export const SP_PER_BP = 65781.76;
