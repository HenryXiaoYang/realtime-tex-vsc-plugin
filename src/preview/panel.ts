// The preview WebviewPanel: forwards a session's output to the webview, with the font, image
// and PDF data it needs, and handles clicks coming back.
import { randomBytes } from 'crypto';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg } from '../config';
import { fontKey } from '../fontKey';
import type { HostToWebview, WebviewToHost } from '../messages';
import { PdfLinkExtractor, safeLinkUrl } from '../pdfLinks';
import type { DisplayList } from '../protocol';
import { ResourceLoader } from '../resources';
import type { Screen, Session, SessionOutput } from '../session';
import { describe, SessionStatus } from '../status';
import { captureSnapshot, LayoutLinkController, readCompletePdf, SerialQueue, type LayoutSnapshot } from './layoutLinks';

export const VIEW_TYPE = 'realtimeTex.preview';

export interface PanelHost {
  log: vscode.OutputChannel;
  resources(session: Session): ResourceLoader;
  /** Called when the user closes the preview. */
  onPanelClosed(panel: PreviewPanel): void;
}

export class PreviewPanel implements vscode.Disposable {
  private session: Session | undefined;
  private sessionSubs: vscode.Disposable[] = [];
  private disposables: vscode.Disposable[] = [];
  private sentFonts = new Set<string>();
  private sentImages = new Set<string>();
  /** Serializes page/overlay messages so an incremental layout keeps its pages_changed order. */
  private readonly queue = new SerialQueue((e) => this.logPreviewError(e));
  /** Link extraction and the monotonic display version of this panel. */
  private readonly links: LayoutLinkController<Session>;
  /** Bumped whenever the panel switches session or resets; queued work from the old one is dropped. */
  private attachmentEpoch = 0;
  private ready = false;
  private backlog: HostToWebview[] = [];
  private disposed = false;

  static create(ctx: vscode.ExtensionContext, host: PanelHost, column: vscode.ViewColumn, preserveFocus: boolean): PreviewPanel {
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      'Live Preview',
      { viewColumn: column, preserveFocus },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')] },
    );
    return new PreviewPanel(ctx, host, panel);
  }

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly host: PanelHost,
    readonly panel: vscode.WebviewPanel,
  ) {
    this.links = new LayoutLinkController<Session>(this.queue, new PdfLinkExtractor(), {
      prepare: (snapshot) => this.prepareLayout(snapshot),
      layout: (message) => this.post({ type: 'layout', ...message }),
      overlays: (snapshot) => this.postReplayOverlays(snapshot),
      links: (links, layoutVersion) => this.post({ type: 'links', links, layoutVersion }),
      log: (message) => this.host.log.appendLine(`[links] ${message}`),
      error: (message) => this.host.log.appendLine(`[preview] ${message}`),
    });
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'dist'), vscode.Uri.joinPath(ctx.extensionUri, 'media')],
    };
    panel.iconPath = {
      light: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-light.svg'),
      dark: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-dark.svg'),
    };
    panel.webview.html = this.html();
    this.disposables.push(
      panel.webview.onDidReceiveMessage((m: WebviewToHost) => this.onMessage(m)),
      panel.onDidDispose(() => this.dispose()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('realtimeTex.syncCursor') || e.affectsConfiguration('realtimeTex.preview')) this.postConfig();
      }),
    );
  }

  get attached(): Session | undefined {
    return this.session;
  }

  /** Show `session` in this panel (replaying its current state). */
  attach(session: Session): void {
    if (this.session === session) return;
    for (const d of this.sessionSubs) d.dispose();
    this.attachmentEpoch++;
    this.links.reset();
    this.session = session;
    this.sentFonts.clear();
    this.sentImages.clear();
    this.missing.clear();
    this.panel.title = `Preview ${session.name}`;
    this.sessionSubs = [
      session.onOutput((o) => this.onOutput(session, o)),
      session.onStatus((s) => this.postStatus(s)),
      session.onScreen((s) => this.postScreen(s)),
    ];
    if (this.ready) this.replay();
  }

  /** Show a screen without a session (no main file, unsupported platform…). */
  showScreen(s: Screen): void {
    this.post({ type: 'screen', ...s });
  }

  reveal(preserveFocus = true): void {
    this.panel.reveal(undefined, preserveFocus);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.links.dispose();
    for (const d of [...this.sessionSubs, ...this.disposables]) d.dispose();
    this.host.onPanelClosed(this);
    this.panel.dispose();
  }

  // -------------------------------------------------------------------------------------------

  private logPreviewError(e: unknown): void {
    const error = e instanceof Error ? e : new Error(String(e));
    this.host.log.appendLine(`[preview] ${error.stack ?? error.message}`);
  }

  private post(m: HostToWebview): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.backlog.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  /** Async work must also match the epoch: an engine restart reuses the same Session. */
  private isCurrent(session: Session, epoch = this.attachmentEpoch): boolean {
    return !this.disposed && this.session === session && epoch === this.attachmentEpoch;
  }

  /** Post only if the async job still belongs to the current session (attach/reset). */
  private postFor(session: Session, m: HostToWebview, epoch: number): void {
    if (!this.isCurrent(session, epoch)) return;
    this.post(m);
  }

  /** Run `job` in order, passing the epoch so it can detect resets after each await. */
  private enqueueFor(session: Session, job: (epoch: number) => Promise<void> | void): void {
    const epoch = this.attachmentEpoch;
    this.queue.run(async () => {
      if (!this.isCurrent(session, epoch)) return;
      await job(epoch);
    });
  }

  private replay(): void {
    const s = this.session;
    if (!s) return;
    // Snapshot before posting or awaiting anything: while the queue waits for fonts and PDF
    // bytes, a later layout may mutate the model (it re-anchors overlay fragments).
    const snapshot = captureSnapshot(s.model, s.layoutVersion, s.layoutPdfPath, s);
    this.attachmentEpoch++;
    this.links.reset();
    this.post({ type: 'reset' });
    this.sentFonts.clear();
    this.sentImages.clear();
    this.missing.clear();
    this.postConfig();
    this.postStatus(s.status);
    this.postScreen(s.screen);
    if (snapshot) this.links.submit(snapshot);
  }

  private onOutput(s: Session, o: SessionOutput): void {
    switch (o.kind) {
      case 'layout':
        this.submitLayout(s, o);
        break;
      case 'paragraph': {
        const ev = o.ev;
        this.enqueueFor(s, async (epoch) => {
          await this.sendResources(s, [ev.dl], epoch);
          this.postFor(s, { type: 'paragraph', parId: ev.par_id, dl: ev.dl, fragments: ev.fragments, revision: ev.versions.source_revision }, epoch);
        });
        break;
      }
      case 'dropOverlays':
        this.enqueueFor(s, (epoch) => this.postFor(s, { type: 'dropOverlays', parIds: o.parIds }, epoch));
        break;
      case 'reveal':
        this.post({ type: 'reveal', page: o.target.page, x: o.target.x, y: o.target.y, force: o.force });
        break;
      case 'banner':
        this.post({ type: 'banner', text: o.text, kind: o.level, actions: o.actions });
        break;
      case 'reset':
        this.resetPreview();
        break;
    }
  }

  /** A new engine session cleared the model: drop old pages, links and queued extraction. */
  private resetPreview(): void {
    this.attachmentEpoch++;
    this.links.reset();
    this.sentFonts.clear();
    this.sentImages.clear();
    this.missing.clear();
    this.post({ type: 'reset' });
  }

  /** Freeze the incremental event so later model/event changes cannot leak into the queued job. */
  private submitLayout(s: Session, o: Extract<SessionOutput, { kind: 'layout' }>): void {
    const snapshot: LayoutSnapshot<Session> = {
      context: s,
      engineVersion: o.ev.versions.layout_version,
      pdfPath: o.pdfPath,
      pages: o.ev.pages_changed.slice(),
      pagesTotal: o.ev.pages_total,
      placements: o.ev.placements.slice(),
      overlays: [],
      keepFromRevision: o.keepFromRevision,
      full: false,
      pdfFallback: o.ev.pdf_fallback !== null,
    };
    this.links.submit(snapshot);
  }

  /** Resources and PDF bytes for one frozen layout, read in the panel's serial queue. */
  private async prepareLayout(snapshot: LayoutSnapshot<Session>): Promise<Uint8Array | null> {
    const s = snapshot.context;
    const epoch = this.attachmentEpoch;
    if (!this.isCurrent(s, epoch)) return null;
    const dls = snapshot.full
      ? [...snapshot.pages.map((p) => p.dl), ...snapshot.overlays.map((o) => o.dl)]
      : snapshot.pages.map((p) => p.dl);
    const needPdf = await this.needsPdf(s, dls, snapshot.pdfFallback || snapshot.pages.some((p) => !p.exact), epoch);
    // An attach/reset while fonts or the PDF were loading makes the whole layout stale; the
    // controller drops it without posting, and its resources must not leak into the new session.
    if (!this.isCurrent(s, epoch) || !needPdf) return null;
    const pdf = await readCompletePdf(snapshot.pdfPath);
    return this.isCurrent(s, epoch) ? pdf : null;
  }

  /** A replay also restores the live results that were on top of the pages. */
  private postReplayOverlays(snapshot: LayoutSnapshot<Session>): void {
    if (!snapshot.full || !this.isCurrent(snapshot.context)) return;
    for (const o of snapshot.overlays) {
      this.post({ type: 'paragraph', parId: o.parId, dl: o.dl, fragments: o.fragments, revision: o.revision });
    }
  }

  /** Send missing fonts/images; true when some page will need the PDF instead. */
  private async needsPdf(s: Session, dls: DisplayList[], degraded: boolean, epoch: number): Promise<boolean> {
    const missing = await this.sendResources(s, dls, epoch);
    return degraded || missing;
  }

  private async sendResources(s: Session, dls: DisplayList[], epoch: number): Promise<boolean> {
    const loader = this.host.resources(s);
    const [fonts, images] = await Promise.all([loader.fontsFor(dls, this.sentFonts), loader.imagesFor(dls, this.sentImages, s.projectRoot)]);
    // A reset or session switch while a font/image was loading must not change bookkeeping
    // or send old resources into the fresh webview.
    if (!this.isCurrent(s, epoch)) return false;
    for (const [k, f] of fonts) {
      this.sentFonts.add(k);
      if (f.kind === 'missing') {
        this.missing.add(k);
        this.host.log.appendLine(`[fonts] ${k}: ${f.reason}`);
      }
    }
    for (const [k, im] of images) {
      this.sentImages.add(k);
      if (im.kind === 'missing') {
        this.missing.add(`image:${k}`);
        this.host.log.appendLine(`[images] ${im.reason}`);
      }
    }
    if (fonts.size || images.size) this.postFor(s, { type: 'resources', fonts: [...fonts], images: [...images] }, epoch);
    // fonts or images this preview cannot draw make the PDF necessary
    return dls.some(
      (dl) =>
        Object.values(dl.fonts ?? {}).some((d) => this.missing.has(fontKey(d))) ||
        Object.values(dl.images_info ?? {}).some((i) => this.missing.has(`image:${i.file}`)),
    );
  }

  private missing = new Set<string>();

  private postStatus(s: SessionStatus): void {
    const d = describe(s);
    this.post({ type: 'status', text: d.text, kind: d.kind, tooltip: d.tooltip });
  }

  private postScreen(s: Screen): void {
    this.post({ type: 'screen', ...s });
  }

  private postConfig(): void {
    this.post({
      type: 'config',
      follow: cfg().get<boolean>('syncCursor', true),
      invert: cfg().get<boolean>('preview.invertInDarkTheme', false),
    });
  }

  private async onMessage(m: WebviewToHost): Promise<void> {
    switch (m.type) {
      case 'ready':
        this.ready = true;
        for (const b of this.backlog.splice(0)) void this.panel.webview.postMessage(b);
        this.replay();
        this.maybeHint();
        break;
      case 'jump': {
        const ok = await this.session?.jumpToSource(m.page, m.x, m.y, m.pdfText);
        if (!ok) vscode.window.setStatusBarMessage('$(info) No source paragraph found at that spot of the preview.', 3000);
        break;
      }
      case 'openLink': {
        // the webview may not open URLs itself (and a PDF may name any scheme): check it here
        const url = safeLinkUrl(m.url);
        if (!url) {
          this.host.log.appendLine(`[links] refused to open ${JSON.stringify(m.url)}`);
          break;
        }
        const opened = await vscode.env.openExternal(vscode.Uri.parse(url));
        if (!opened) void vscode.window.showWarningMessage(`Could not open ${url}`);
        break;
      }
      case 'command': {
        const allowed = m.command.startsWith('realtimeTex.') || m.command === 'workbench.actions.view.problems' || m.command === 'workbench.action.openSettings' || m.command === 'vscode.open';
        if (!allowed) return;
        const args = (m.args ?? []).map((a) => (m.command === 'vscode.open' && typeof a === 'string' ? vscode.Uri.parse(a) : a));
        void vscode.commands.executeCommand(m.command, ...args);
        break;
      }
      case 'setFollow':
        await cfg().update('syncCursor', m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'error':
      case 'log':
        this.host.log.appendLine(`[preview] ${m.message}`);
        break;
    }
  }

  private maybeHint(): void {
    const key = 'realtimeTex.hintShown';
    if (this.ctx.globalState.get<boolean>(key)) return;
    void this.ctx.globalState.update(key, true);
    this.post({ type: 'hint', text: 'Tip: double-click a word in the preview to put the cursor there in the source.' });
  }

  private html(): string {
    const w = this.panel.webview;
    const nonce = randomBytes(16).toString('base64');
    const script = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'preview.css'));
    const worker = w.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'pdf.worker.mjs'));
    const boot = {
      workerUrl: worker.toString(),
      zoom: cfg().get<string>('preview.zoom', 'fitWidth'),
      follow: cfg().get<boolean>('syncCursor', true),
      invert: cfg().get<boolean>('preview.invertInDarkTheme', false),
    };
    const csp = [
      `default-src 'none'`,
      `img-src ${w.cspSource} blob: data:`,
      `style-src ${w.cspSource}`,
      `font-src ${w.cspSource} blob: data:`,
      `script-src 'nonce-${nonce}' ${w.cspSource}`,
      `worker-src blob:`,
      `connect-src ${w.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<script type="application/json" id="rtex-boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<title>Live Preview</title>
</head>
<body>
<script type="module" nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

export function previewTitle(mainFile: string): string {
  return `Preview ${path.basename(mainFile)}`;
}
