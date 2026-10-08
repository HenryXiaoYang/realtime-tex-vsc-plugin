// One rtex session for one main file: keeps rtex's buffers in sync with VS Code, turns events
// into diagnostics and status, and forwards display lists to the preview.
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { PreviewModel } from '../webview/model';
import { buildDirFor, exportPathFor, processEnv, resolveServer, ServerLocation } from './config';
import { ShadowText } from './edits';
import type { Action, ScreenKind } from './messages';
import type {
  Diagnostic as RtexDiagnostic,
  EditResult,
  Fragment,
  LayoutUpdateEvent,
  ParagraphUpdateEvent,
  PdfExportedEvent,
  Reply,
  RtexEvent,
  Span,
} from './protocol';
import { ExitInfo, RtexProcess } from './rtexProcess';
import { hitTest, PreviewTarget, spanAt, targetInFragments } from './sourceMap';
import { explainReasons, Phase, SessionStatus } from './status';

export interface Screen {
  screen: ScreenKind | null;
  title?: string;
  message?: string;
  detail?: string;
  actions?: Action[];
}

/** What the preview needs to hear about. */
export type SessionOutput =
  | { kind: 'layout'; ev: LayoutUpdateEvent; keepFromRevision: number | null; pdfPath: string }
  | { kind: 'paragraph'; ev: ParagraphUpdateEvent }
  | { kind: 'dropOverlays'; parIds?: number[] }
  | { kind: 'reveal'; target: PreviewTarget; force: boolean }
  | { kind: 'banner'; text: string | null; level?: 'info' | 'warn' | 'error'; actions?: Action[] };

const ACTIONS = {
  showLog: { label: 'Show Log', command: 'realtimeTex.showLog' },
  restart: { label: 'Restart', command: 'realtimeTex.restart', primary: true },
  checkSetup: { label: 'Check Setup', command: 'realtimeTex.checkSetup' },
  problems: { label: 'Show Problems', command: 'workbench.actions.view.problems', primary: true },
  recompile: { label: 'Recompile', command: 'realtimeTex.recompile' },
} satisfies Record<string, Action>;

export class Session implements vscode.Disposable {
  readonly projectRoot: string;
  readonly mainRel: string;
  readonly buildDir: string;
  /** Pages, placements and overlays (same rules as the webview; used to replay and to sync). */
  readonly model = new PreviewModel();

  private proc: RtexProcess | undefined;
  private server: ServerLocation | undefined;
  private shadows = new Map<string, ShadowText>();
  private spansCache = new Map<string, Promise<Span[]>>();
  private generation = -1;
  private bgDiagnosticsThisPass = false;
  private diags = new Map<string, RtexDiagnostic[]>();
  private exports = new Map<number, (ev: PdfExportedEvent) => void>();
  private pendingTimer: ReturnType<typeof setTimeout> | undefined;
  private startedAt = 0;
  private autoRestarted = false;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;

  private statusValue: SessionStatus = { phase: 'idle', pending: false, errorCount: 0, pagesTotal: 0 };
  private screenValue: Screen = { screen: null };

  private readonly outputEmitter = new vscode.EventEmitter<SessionOutput>();
  readonly onOutput = this.outputEmitter.event;
  private readonly statusEmitter = new vscode.EventEmitter<SessionStatus>();
  readonly onStatus = this.statusEmitter.event;
  private readonly screenEmitter = new vscode.EventEmitter<Screen>();
  readonly onScreen = this.screenEmitter.event;

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly mainFile: string,
    private readonly log: vscode.OutputChannel,
    private readonly diagnostics: vscode.DiagnosticCollection,
  ) {
    this.projectRoot = path.dirname(mainFile);
    this.mainRel = path.basename(mainFile);
    this.buildDir = buildDirFor(ctx, mainFile);
    this.statusValue.mainName = this.mainRel;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  get screen(): Screen {
    return this.screenValue;
  }

  get running(): boolean {
    return this.proc?.running ?? false;
  }

  get pdfPath(): string {
    return path.join(this.buildDir, 'bg', path.basename(this.mainRel, path.extname(this.mainRel)) + '.pdf');
  }

  /**
   * rtex (≤ 0.0.2) copies the project into `<build>/src` before every full compile (and into
   * `<build>/export-src` before an export), but creates
   * no folders while doing so: a project with any subfolder fails with "snapshot: No such file
   * or directory". Create the folders it will copy into (same rules: depth ≤ 8, skipping
   * hidden, `build` and `target`).
   */
  private async mirrorProjectFolders(): Promise<void> {
    const dsts = [path.join(this.buildDir, 'src'), path.join(this.buildDir, 'export-src')];
    const walk = async (rel: string, depth: number): Promise<void> => {
      if (depth > 8) return;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.readdir(path.join(this.projectRoot, rel), { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith('.') || e.name === 'build' || e.name === 'target') continue;
        // rtex follows symlinks to folders as well
        const isDir = e.isDirectory() || (e.isSymbolicLink() && (await fs.stat(path.join(this.projectRoot, rel, e.name)).catch(() => undefined))?.isDirectory());
        if (!isDir) continue;
        const sub = path.join(rel, e.name);
        if (path.join(this.projectRoot, sub) === this.buildDir) continue;
        for (const dst of dsts) await fs.mkdir(path.join(dst, sub), { recursive: true });
        await walk(sub, depth + 1);
      }
    };
    try {
      for (const dst of dsts) await fs.mkdir(dst, { recursive: true });
      await walk('', 0);
    } catch (e) {
      this.log.appendLine(`[start] could not prepare the build folders: ${(e as Error).message}`);
    }
  }

  /** The log of the background compile (LuaLaTeX's own .log). */
  get latexLogPath(): string {
    return path.join(this.buildDir, 'bg', path.basename(this.mainRel, path.extname(this.mainRel)) + '.log');
  }

  async openLatexLog(): Promise<void> {
    if (!existsSync(this.latexLogPath)) {
      void vscode.window.showInformationMessage('LuaLaTeX has not written a log yet. The extension log has what rtex reported so far.', 'Show Log').then((p) => {
        if (p) this.log.show(true);
      });
      return;
    }
    const doc = await vscode.workspace.openTextDocument(this.latexLogPath);
    const ed = await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.One });
    // the end of the log is where a run stops
    const end = new vscode.Position(doc.lineCount - 1, 0);
    ed.revealRange(new vscode.Range(end, end), vscode.TextEditorRevealType.InCenter);
  }

  // -------------------------------------------------------------------------------------------
  // lifecycle

  async start(): Promise<void> {
    if (this.running || this.disposed) return;
    this.server = resolveServer(this.ctx);
    if (!this.server) {
      this.setPhase('failed');
      this.setScreen({
        screen: 'notInstalled',
        message:
          'Realtime TeX uses the rtex engine from the realtime-tex project to re-typeset only the paragraph you edit. Install it once (it is built from source, a few minutes), or point the extension at an rtex binary you already have.',
        actions: [
          { label: 'Install rtex', command: 'realtimeTex.buildFromSource', primary: true },
          { label: 'Locate rtex Binary…', command: 'realtimeTex.selectServerPath' },
          ACTIONS.checkSetup,
        ],
      });
      return;
    }
    await fs.mkdir(this.buildDir, { recursive: true });
    await this.mirrorProjectFolders();
    const env = processEnv(this.ctx, this.server);
    this.log.appendLine(`[start] ${this.server.path} serve --project ${this.projectRoot} --main ${this.mainRel} --build ${this.buildDir}`);
    if (env.RTEX_TEXLIVE_BIN) this.log.appendLine(`[start] TeX Live: ${env.RTEX_TEXLIVE_BIN}`);
    execFile('lualatex', ['--version'], { env, timeout: 10000 }, (err, stdout) => {
      this.log.appendLine(`[start] ${err ? `lualatex --version failed: ${err.message}` : String(stdout).split('\n')[0]}`);
    });
    const proc = new RtexProcess({ serverPath: this.server.path, projectRoot: this.projectRoot, mainFile: this.mainRel, buildDir: this.buildDir, env });
    this.proc = proc;
    proc.on('event', (ev: RtexEvent) => this.onEvent(ev));
    proc.on('stderr', (line: string) => this.log.appendLine(line));
    proc.on('exit', (info: ExitInfo) => this.onExit(proc, info));
    this.startedAt = Date.now();
    this.generation = -1;
    this.model.clear();
    this.outputEmitter.fire({ kind: 'dropOverlays' });
    this.setPhase('starting');
    this.setScreen({
      screen: 'starting',
      message: `Loading LuaLaTeX and the packages in the preamble of ${this.mainRel}. The first start takes a few seconds.`,
    });
    proc.start();
    // rtex reads the files from disk; give it the editor's unsaved text
    this.shadows.clear();
    for (const doc of vscode.workspace.textDocuments) {
      const rel = this.relPath(doc);
      if (!rel) continue;
      this.shadows.set(rel, new ShadowText(doc.getText()));
      // the main file is loaded from disk by rtex; other files only when they are edited
      if (doc.isDirty || rel !== this.mainRel) proc.send({ cmd: 'set_document', path: rel, text: doc.getText() }, (r) => this.onEditReply(r));
    }
    this.watchFiles();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.stop();
    this.disposeWatchers();
    this.setPhase('stopped');
    this.setScreen({
      screen: 'stopped',
      message: 'The engine is stopped. Start it again to keep the preview updating as you type.',
      actions: [{ label: 'Start Again', command: 'realtimeTex.restart', primary: true }],
    });
  }

  async restart(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await proc.stop();
    this.disposeWatchers();
    this.autoRestarted = false;
    await this.start();
  }

  dispose(): void {
    this.disposed = true;
    void this.proc?.stop();
    this.proc = undefined;
    this.disposeWatchers();
    this.diagnostics.clear();
    clearTimeout(this.pendingTimer);
    this.outputEmitter.dispose();
    this.statusEmitter.dispose();
    this.screenEmitter.dispose();
  }

  private onExit(proc: RtexProcess, info: ExitInfo): void {
    if (proc !== this.proc) return;
    this.proc = undefined;
    this.disposeWatchers();
    if (info.requested || this.disposed) return;
    const tail = info.stderrTail.join('\n');
    this.log.appendLine(`[exit] code ${info.code} signal ${info.signal}${info.error ? ` error ${info.error.message}` : ''}`);
    if (info.error?.code === 'ENOENT' || info.error?.code === 'EACCES') {
      this.setPhase('failed');
      this.setScreen({
        screen: 'notInstalled',
        message: `The rtex binary could not be started (${info.error.code}): ${this.server?.path}`,
        actions: [{ label: 'Install rtex', command: 'realtimeTex.buildFromSource', primary: true }, { label: 'Locate rtex Binary…', command: 'realtimeTex.selectServerPath' }, ACTIONS.checkSetup],
      });
      return;
    }
    // a crash after a good while: restart once by itself
    if (Date.now() - this.startedAt > 20000 && !this.autoRestarted) {
      this.autoRestarted = true;
      this.log.appendLine('[exit] restarting the engine');
      void this.start();
      return;
    }
    const hint = explainStartupFailure(tail);
    this.setPhase('failed');
    this.setScreen({
      screen: 'error',
      title: 'The engine stopped',
      message: hint.message,
      detail: tail || undefined,
      actions: [...hint.actions, ACTIONS.restart, ACTIONS.showLog, ACTIONS.checkSetup],
    });
  }

  // -------------------------------------------------------------------------------------------
  // editor → rtex

  /** Path of `doc` relative to the project root when the session tracks it. */
  relPath(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme !== 'file' || !/\.tex$/i.test(doc.fileName)) return undefined;
    const rel = path.relative(this.projectRoot, doc.fileName);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
    if (doc.fileName.startsWith(this.buildDir)) return undefined;
    return rel.split(path.sep).join('/');
  }

  onDidChangeDocument(e: vscode.TextDocumentChangeEvent): void {
    const proc = this.proc;
    const rel = this.relPath(e.document);
    if (!proc || !rel || e.contentChanges.length === 0) return;
    this.spansCache.delete(rel);
    const shadow = this.shadows.get(rel);
    if (!shadow) {
      this.shadows.set(rel, new ShadowText(e.document.getText()));
      proc.send({ cmd: 'set_document', path: rel, text: e.document.getText() }, (r) => this.onEditReply(r));
      return;
    }
    const edits = shadow.apply(e.contentChanges);
    if (shadow.length !== documentLength(e.document)) {
      // out of step (should not happen): resend the whole buffer
      this.log.appendLine(`[sync] ${rel}: resynchronizing`);
      shadow.reset(e.document.getText());
      proc.send({ cmd: 'set_document', path: rel, text: shadow.text }, (r) => this.onEditReply(r));
      return;
    }
    for (const ed of edits) {
      proc.send({ cmd: 'edit', path: rel, start: ed.start, end: ed.end, text: ed.text }, (r) => this.onEditReply(r));
    }
  }

  /** Track a newly opened document so its edits can be sent incrementally. */
  onDidOpenDocument(doc: vscode.TextDocument): void {
    const rel = this.relPath(doc);
    if (!rel || !this.proc || this.shadows.has(rel)) return;
    this.shadows.set(rel, new ShadowText(doc.getText()));
    // rtex loaded the main file from disk; other files only when they are sent
    if (doc.isDirty || rel !== this.mainRel) this.proc.send({ cmd: 'set_document', path: rel, text: doc.getText() }, (r) => this.onEditReply(r));
  }

  /** A document closed without saving goes back to its text on disk. */
  async onDidCloseDocument(doc: vscode.TextDocument): Promise<void> {
    const rel = this.relPath(doc);
    if (!rel || !this.proc || !this.shadows.has(rel)) return;
    try {
      const disk = await fs.readFile(doc.fileName, 'utf8');
      if (disk !== this.shadows.get(rel)!.text) {
        this.shadows.get(rel)!.reset(disk);
        this.proc.send({ cmd: 'set_document', path: rel, text: disk }, (r) => this.onEditReply(r));
      }
    } catch {
      /* deleted */
    }
    this.shadows.delete(rel);
    this.spansCache.delete(rel);
  }

  private errorRecheck: ReturnType<typeof setTimeout> | undefined;

  private onEditReply(r: Reply): void {
    if (r.reply === 'error') {
      this.log.appendLine(`[rtex] ${r.message}`);
      return;
    }
    if (r.reply !== 'edit' && r.reply !== 'set_document') return;
    const res: EditResult = r.result;
    // errors are found by full compiles, which fast edits do not start: while the Problems
    // panel lists some, recompile shortly after typing stops so fixed ones disappear
    if ((this.diags.get('background') ?? []).some((d) => d.severity === 'error')) {
      clearTimeout(this.errorRecheck);
      this.errorRecheck = setTimeout(() => this.recompile(), 1000);
    }
    if (res.outcome.removed.length) {
      this.model.dropOverlays(res.outcome.removed);
      this.outputEmitter.fire({ kind: 'dropOverlays', parIds: res.outcome.removed });
    }
    if (res.routed !== 'fast') {
      this.statusValue.lastBackgroundReason = res.routed === 'preamble' ? 'the preamble changed' : explainReasons(res.reasons);
      this.setPending(true);
    }
  }

  private watchers: vscode.Disposable[] = [];
  private watchFiles(): void {
    this.disposeWatchers();
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.projectRoot, '**/*'));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const changed = async (uri: vscode.Uri) => {
      const file = uri.fsPath;
      if (file.startsWith(this.buildDir) || /[\\/](build|\.git|node_modules)[\\/]/.test(path.relative(this.projectRoot, file))) return;
      if ((await fs.stat(file).catch(() => undefined))?.isDirectory()) {
        await this.mirrorProjectFolders();
        return;
      }
      if (/\.(aux|log|pdf|synctex\.gz|fls|fdb_latexmk|out|toc|bbl|blg|bcf|run\.xml)$/i.test(file)) return;
      const rel = path.relative(this.projectRoot, file).split(path.sep).join('/');
      const open = vscode.workspace.textDocuments.find((d) => d.fileName === file);
      if (/\.tex$/i.test(file)) {
        if (open) return; // the editor's buffer is authoritative
        try {
          const text = await fs.readFile(file, 'utf8');
          this.proc?.send({ cmd: 'set_document', path: rel, text }, (r) => this.onEditReply(r));
        } catch {
          /* deleted */
        }
        return;
      }
      // bibliographies, images, packages: recompile (debounced)
      clearTimeout(timer);
      timer = setTimeout(() => this.recompile(), 400);
    };
    this.watchers.push(w, w.onDidChange(changed), w.onDidCreate(changed), w.onDidDelete(changed));
  }

  private disposeWatchers(): void {
    for (const d of this.watchers) d.dispose();
    this.watchers = [];
  }

  recompile(): void {
    if (!this.proc) return;
    this.statusValue.lastBackgroundReason = undefined;
    this.setPending(true);
    this.proc.send({ cmd: 'request_layout' });
  }

  // -------------------------------------------------------------------------------------------
  // rtex → editor

  private onEvent(ev: RtexEvent): void {
    switch (ev.event) {
      case 'EngineState': {
        this.log.appendLine(`[engine] ${ev.state} (generation ${ev.engine_generation})${ev.reason ? `: ${ev.reason}` : ''}`);
        if (ev.engine_generation !== this.generation && this.generation >= 0) {
          this.model.dropOverlays();
          this.outputEmitter.fire({ kind: 'dropOverlays' });
        }
        this.generation = ev.engine_generation;
        if (ev.state === 'Ready') {
          if (this.statusValue.phase === 'starting') {
            this.setPhase('compiling');
            this.setScreen({
              screen: 'compiling',
              message: `Running the first full compile of ${this.mainRel}. After that, the preview updates as you type.`,
            });
          }
          this.outputEmitter.fire({ kind: 'banner', text: null });
        } else if (ev.state === 'Failed') {
          this.outputEmitter.fire({
            kind: 'banner',
            level: 'warn',
            text: `Live typing is paused: the engine could not load the preamble${ev.reason ? ` (${firstLine(ev.reason)})` : ''}. The preview still updates after each full compile.`,
            actions: [ACTIONS.showLog],
          });
        } else if (ev.state === 'Starting' && this.model.hasLayout) {
          this.statusValue.lastBackgroundReason = 'the preamble changed';
          this.setPending(true);
        }
        break;
      }
      case 'LayoutUpdate':
        this.onLayout(ev);
        break;
      case 'ParagraphUpdate': {
        this.statusValue.lastFastMs = ev.timing.total_us / 1000;
        this.model.applyParagraph(ev.par_id, ev.dl, ev.fragments, ev.versions.source_revision);
        this.outputEmitter.fire({ kind: 'paragraph', ev });
        this.setDiagnostics('live', ev.diagnostics);
        if (ev.pagination_stale || ev.reasons.length) {
          this.statusValue.lastBackgroundReason = ev.reasons.includes('inserts') ? 'footnote text is placed with the page' : 'the paragraph changed its number of lines';
          this.setPending(true);
        } else this.emitStatus();
        break;
      }
      case 'Diagnostics':
        for (const d of ev.items) {
          this.log.appendLine(`[${ev.source}] ${d.severity}${d.file ? ` ${d.file}${d.line ? `:${d.line}` : ''}` : ''}: ${d.message}`);
        }
        if (ev.source === 'background') {
          this.bgDiagnosticsThisPass = true;
          this.onPassFailure(ev.items);
        }
        this.setDiagnostics(ev.source, ev.items);
        break;
      case 'BackgroundScheduled':
        this.statusValue.lastBackgroundReason = explainReasons(ev.reasons);
        this.setPending(true);
        break;
      case 'PdfExported': {
        const done = this.exports.get(ev.job_id);
        this.exports.delete(ev.job_id);
        done?.(ev);
        break;
      }
    }
  }

  private onLayout(ev: LayoutUpdateEvent): void {
    this.log.appendLine(
      `[layout] v${ev.versions.layout_version}: ${ev.pages_total} pages (${ev.pages_changed.length} changed), ${ev.compile.state}, ${ev.convergence.state}, ${ev.wall_ms} ms`,
    );
    if (!this.bgDiagnosticsThisPass) this.setDiagnostics('background', []);
    this.bgDiagnosticsThisPass = false;
    this.setDiagnostics('live', []);
    const keepFromRevision = ev.convergence.state === 'Stale' ? ev.convergence.pending_since : null;
    this.model.applyLayout({ pages: ev.pages_changed, pagesTotal: ev.pages_total, placements: ev.placements, keepFromRevision });
    this.statusValue.convergence = ev.convergence;
    this.statusValue.compile = ev.compile;
    this.statusValue.pagesTotal = ev.pages_total;
    const settled = ev.convergence.state === 'Converged' || ev.convergence.state === 'PassLimitReached';
    if (settled || (ev.convergence.state === 'Converging' && ev.compile.state !== 'Ok')) this.setPending(false, false);
    this.spansCache.clear();
    if (ev.pages_total === 0) {
      const first = this.firstError();
      this.setPhase('live');
      this.setScreen({
        screen: 'error',
        title: 'The document produced no pages',
        message: first
          ? `LaTeX stopped with an error${first.line ? ` on line ${first.line}` : ''}${first.file ? ` of ${first.file}` : ''}:\n${first.message}`
          : 'The full compile did not produce any page. The log has the details.',
        actions: [ACTIONS.problems, ACTIONS.showLog, ACTIONS.recompile],
      });
    } else {
      this.setPhase('live');
      this.setScreen({ screen: null });
    }
    this.emitStatus();
    this.outputEmitter.fire({ kind: 'layout', ev, keepFromRevision, pdfPath: ev.pdf_fallback ?? this.pdfPath });
  }

  /** rtex reports a background pass that could not run at all (no layout follows) as a
   * diagnostic without file and line. Before the first layout that would leave the preview
   * waiting forever: show what went wrong instead. */
  private onPassFailure(items: RtexDiagnostic[]): void {
    const fail = items.find((d) => d.severity === 'error' && !d.file && !d.line);
    if (!fail) return;
    const msg = fail.message;
    let advice = 'The full compile could not run.';
    if (/^snapshot:/.test(msg)) {
      advice = `rtex could not copy the project folder into its build folder (${this.buildDir}).`;
    } else if (/produced no .*rtex\.json/i.test(msg)) {
      advice =
        "LuaLaTeX ran but rtex's capture did not. This usually means LuaLaTeX is older than TeX Live 2026, rtex's tex/ folder was not found, or LaTeX stopped at an error before \\begin{document}.";
    } else if (/spawning lualatex|No such file/i.test(msg)) {
      advice = 'LuaLaTeX could not be started.';
    }
    // LuaLaTeX's own error line (e.g. "! LaTeX Error: File `x.sty' not found.") says the most
    const texError = msg.split('\n').find((l) => /^! /.test(l.trim()) || /:\d+: /.test(l));
    if (texError) advice = `LaTeX stopped: ${texError.trim()}`;
    const actions: Action[] = [
      { label: 'Open LaTeX Log', command: 'realtimeTex.openLatexLog', primary: true },
      ACTIONS.showLog,
      ACTIONS.checkSetup,
      ACTIONS.recompile,
    ];
    if (!this.model.hasLayout) {
      this.setPhase('live');
      this.setScreen({ screen: 'error', title: 'The first compile failed', message: advice, detail: msg.length > 3000 ? '…' + msg.slice(-3000) : msg, actions });
    } else {
      this.outputEmitter.fire({ kind: 'banner', level: 'error', text: `The last full compile failed: ${firstLine(msg)}`, actions });
    }
    this.setPending(false);
  }

  private firstError(): RtexDiagnostic | undefined {
    for (const items of this.diags.values()) {
      const e = items.find((d) => d.severity === 'error');
      if (e) return e;
    }
    return undefined;
  }

  private setDiagnostics(source: string, items: RtexDiagnostic[]): void {
    this.diags.set(source, items);
    const byFile = new Map<string, vscode.Diagnostic[]>();
    let errors = 0;
    for (const list of this.diags.values()) {
      for (const d of list) {
        const file = d.file ? path.resolve(this.projectRoot, d.file) : this.mainFile;
        const line = Math.max(0, (d.line ?? 1) - 1);
        const sev =
          d.severity === 'error'
            ? vscode.DiagnosticSeverity.Error
            : d.severity === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information;
        if (sev === vscode.DiagnosticSeverity.Error) errors++;
        const diag = new vscode.Diagnostic(new vscode.Range(line, 0, line, 1000), d.message + (d.context ? `\n${d.context}` : ''), sev);
        diag.source = 'LaTeX';
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push(diag);
      }
    }
    this.diagnostics.clear();
    for (const [file, list] of byFile) this.diagnostics.set(vscode.Uri.file(file), list);
    if (errors !== this.statusValue.errorCount) {
      this.statusValue.errorCount = errors;
      this.emitStatus();
    }
  }

  // -------------------------------------------------------------------------------------------
  // export

  /** Export the PDF; resolves to its path (undefined when it failed). */
  async exportPdf(): Promise<string | undefined> {
    const proc = this.proc;
    if (!proc) {
      void vscode.window.showWarningMessage('Start the live preview first: the PDF is produced by its engine.');
      return undefined;
    }
    const out = exportPathFor(this.mainFile);
    await fs.mkdir(path.dirname(out), { recursive: true });
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Exporting ${path.basename(out)}…`, cancellable: false },
      async () => {
        const reply = await proc.request({ cmd: 'export_pdf', out });
        if (reply.reply !== 'export_pdf') throw new Error(reply.reply === 'error' ? reply.message : 'unexpected reply');
        return new Promise<PdfExportedEvent>((resolve) => this.exports.set(reply.job_id, resolve));
      },
    );
    const where = path.relative(vscode.workspace.getWorkspaceFolder(vscode.Uri.file(out))?.uri.fsPath ?? path.dirname(out), out) || out;
    if (result.status.state === 'Failed' || !result.path) {
      void vscode.window.showErrorMessage('Export failed: LaTeX did not produce a PDF.', 'Show Problems', 'Show Log').then((pick) => {
        if (pick === 'Show Problems') void vscode.commands.executeCommand('workbench.actions.view.problems');
        if (pick === 'Show Log') this.log.show(true);
      });
      return undefined;
    }
    const pdf = result.path;
    const msg = result.converged
      ? `Exported ${where}.`
      : result.status.state === 'CompiledWithErrors'
        ? `Exported ${where}, but LaTeX reported ${result.status.count} error(s).`
        : `Exported ${where}, but references or page numbers had not settled after ${result.passes} passes.`;
    const show = result.converged ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    void show(msg, 'Open PDF', 'Reveal in Folder').then((pick) => {
      if (pick === 'Open PDF') void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(pdf), vscode.ViewColumn.Beside);
      if (pick === 'Reveal in Folder') void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(pdf));
    });
    return pdf;
  }

  // -------------------------------------------------------------------------------------------
  // sync

  private spans(rel: string): Promise<Span[]> {
    let p = this.spansCache.get(rel);
    if (!p) {
      const proc = this.proc;
      p = proc
        ? proc.request({ cmd: 'spans', path: rel }).then((r) => (r.reply === 'spans' ? r.spans : []), () => [])
        : Promise.resolve([]);
      this.spansCache.set(rel, p);
    }
    return p;
  }

  /** Scroll the preview to the text at `pos` in `doc`. */
  async revealInPreview(doc: vscode.TextDocument, pos: vscode.Position, force: boolean): Promise<boolean> {
    const rel = this.relPath(doc);
    if (!rel || !this.model.hasLayout) return false;
    const shadow = this.shadows.get(rel) ?? new ShadowText(doc.getText());
    const byte = shadow.byteOffset(doc.offsetAt(pos));
    const span = spanAt(await this.spans(rel), byte);
    if (!span) return false;
    const frags = this.model.currentPlacements().get(span.id);
    if (!frags) return false;
    const len = Math.max(1, span.range.end - span.range.start);
    const target = targetInFragments(frags, (byte - span.range.start) / len);
    if (!target) return false;
    this.outputEmitter.fire({ kind: 'reveal', target, force });
    return true;
  }

  /** Open the source of the unit at (page, y) in the preview. */
  async jumpToSource(page: number, _x: number, y: number): Promise<boolean> {
    const hit = hitTest(this.model.currentPlacements(), page, y);
    if (!hit) return false;
    const files = [this.mainRel, ...[...this.shadows.keys()].filter((f) => f !== this.mainRel)];
    for (const rel of files) {
      const span = (await this.spans(rel)).find((s) => s.id === hit.parId);
      if (!span) continue;
      const uri = vscode.Uri.file(path.join(this.projectRoot, rel));
      const doc = await vscode.workspace.openTextDocument(uri);
      const shadow = this.shadows.get(rel) ?? new ShadowText(doc.getText());
      const startOff = shadow.utf16Offset(span.range.start);
      const endOff = shadow.utf16Offset(span.range.end);
      const at = shadow.utf16Offset(span.range.start + Math.floor(hit.fraction * (span.range.end - span.range.start)));
      const visibleEditor = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === uri.fsPath);
      const editor = await vscode.window.showTextDocument(doc, {
        viewColumn: visibleEditor?.viewColumn ?? vscode.ViewColumn.One,
        preserveFocus: false,
      });
      let pos = doc.positionAt(at);
      pos = new vscode.Position(pos.line, doc.lineAt(pos.line).firstNonWhitespaceCharacterIndex);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      flashRange(editor, new vscode.Range(doc.positionAt(startOff), doc.positionAt(endOff)));
      return true;
    }
    return false;
  }

  /** Where each unit is shown (for tests and the panel). */
  placements(): Map<number, Fragment[]> {
    return this.model.currentPlacements();
  }

  // -------------------------------------------------------------------------------------------
  // status

  private compileTimer: ReturnType<typeof setInterval> | undefined;

  /** While the first compile runs, say how long it has been and what may be slow. */
  private watchFirstCompile(): void {
    clearInterval(this.compileTimer);
    const t0 = Date.now();
    this.compileTimer = setInterval(() => {
      if (this.statusValue.phase !== 'compiling') {
        clearInterval(this.compileTimer);
        return;
      }
      const secs = Math.round((Date.now() - t0) / 1000);
      if (secs < 15) return;
      this.setScreen({
        screen: 'compiling',
        title: `Still typesetting… (${secs} s)`,
        message:
          `The first full compile of ${this.mainRel} is still running. Large documents take a while, and the very first LuaLaTeX run on a computer builds its font cache, which can take a few minutes.\n` +
          'The LaTeX log shows how far it got.',
        actions: [{ label: 'Open LaTeX Log', command: 'realtimeTex.openLatexLog', primary: true }, ACTIONS.showLog, ACTIONS.restart],
      });
    }, 5000);
  }

  private setPhase(phase: Phase): void {
    if (this.statusValue.phase === phase) return;
    if (phase === 'compiling') this.watchFirstCompile();
    this.statusValue.phase = phase;
    if (phase !== 'live') this.statusValue.pending = false;
    this.emitStatus();
  }

  private setPending(pending: boolean, emit = true): void {
    clearTimeout(this.pendingTimer);
    this.statusValue.pending = pending;
    // a pass that never reports back must not leave "Updating…" on screen forever
    if (pending) this.pendingTimer = setTimeout(() => this.setPending(false), 120000);
    if (emit) this.emitStatus();
  }

  private emitStatus(): void {
    this.statusEmitter.fire(this.statusValue);
  }

  private setScreen(s: Screen): void {
    this.screenValue = s;
    this.screenEmitter.fire(s);
  }

  /** Show a screen without starting (e.g. unsupported platform). */
  showScreen(s: Screen): void {
    this.setScreen(s);
  }
}

function documentLength(doc: vscode.TextDocument): number {
  const last = doc.lineAt(doc.lineCount - 1);
  return doc.offsetAt(last.range.end);
}

function firstLine(s: string): string {
  const l = s.split('\n').find((x) => x.trim()) ?? s;
  return l.length > 160 ? l.slice(0, 157) + '…' : l;
}

/** Turn the engine's last words into advice. */
export function explainStartupFailure(stderr: string): { message: string; actions: Action[] } {
  if (/lualatex not found/i.test(stderr)) {
    return {
      message:
        'LuaLaTeX was not found. Install TeX Live 2026 (or newer), or set "Realtime TeX: Texlive Bin" to the folder that contains lualatex.',
      actions: [{ label: 'Set TeX Live Folder', command: 'workbench.action.openSettings', args: ['realtimeTex.texliveBin'], primary: true }],
    };
  }
  if (/cannot locate rtex tex\/ directory/i.test(stderr)) {
    return {
      message: 'rtex could not find its tex/ folder. Set "Realtime TeX: Tex Dir" to the tex/ folder of your realtime-tex checkout.',
      actions: [{ label: 'Set tex/ Folder', command: 'workbench.action.openSettings', args: ['realtimeTex.texDir'], primary: true }],
    };
  }
  if (/No such file|not found/i.test(stderr) && /main/i.test(stderr)) {
    return { message: 'The main file could not be read. Check that it exists and is saved at least once.', actions: [] };
  }
  return { message: 'The rtex engine exited unexpectedly. The log below and the output panel have the details.', actions: [] };
}

const flashDecoration = vscode.window.createTextEditorDecorationType({
  backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
  isWholeLine: false,
});

function flashRange(editor: vscode.TextEditor, range: vscode.Range): void {
  editor.setDecorations(flashDecoration, [range]);
  setTimeout(() => editor.setDecorations(flashDecoration, []), 1200);
}
