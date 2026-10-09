// The preview WebviewPanel: forwards a session's output to the webview, with the font, image
// and PDF data it needs, and handles clicks coming back.
import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg } from '../config';
import { fontKey } from '../fontKey';
import type { HostToWebview, WebviewToHost } from '../messages';
import type { DisplayList } from '../protocol';
import { ResourceLoader } from '../resources';
import type { Screen, Session, SessionOutput } from '../session';
import { describe, SessionStatus } from '../status';

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
  private queue: Promise<void> = Promise.resolve();
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
    this.session = session;
    this.sentFonts.clear();
    this.sentImages.clear();
    this.panel.title = `Preview ${session.mainRel}`;
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
    for (const d of [...this.sessionSubs, ...this.disposables]) d.dispose();
    this.host.onPanelClosed(this);
    this.panel.dispose();
  }

  // -------------------------------------------------------------------------------------------

  private post(m: HostToWebview): void {
    if (this.disposed) return;
    if (!this.ready) {
      this.backlog.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  /** Messages that need resources first go through one queue, so they keep their order. */
  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(job).catch((e: Error) => this.host.log.appendLine(`[preview] ${e.stack ?? e.message}`));
  }

  private replay(): void {
    const s = this.session;
    if (!s) return;
    this.post({ type: 'reset' });
    this.sentFonts.clear();
    this.sentImages.clear();
    this.postConfig();
    this.postStatus(s.status);
    this.postScreen(s.screen);
    if (s.model.hasLayout) {
      const pages = [...s.model.pages.values()];
      const overlays = [...s.model.overlays.values()];
      this.enqueue(async () => {
        const dls = [...pages.map((p) => p.dl), ...overlays.map((o) => o.dl)];
        const pdf = (await this.needsPdf(s, dls, pages.some((p) => !p.exact))) ? await readPdf(s.pdfPath) : null;
        const placements = [...s.model.placements].map(([par_id, fragments]) => ({ par_id, fragments, lines: 0, kind: '' }));
        this.post({ type: 'layout', pages, pagesTotal: s.model.pagesTotal, placements, keepFromRevision: null, pdf });
        for (const o of overlays) this.post({ type: 'paragraph', parId: o.parId, dl: o.dl, fragments: o.fragments, revision: o.revision });
      });
    }
  }

  private onOutput(s: Session, o: SessionOutput): void {
    switch (o.kind) {
      case 'layout': {
        const ev = o.ev;
        this.enqueue(async () => {
          const dls = ev.pages_changed.map((p) => p.dl);
          const pdf = (await this.needsPdf(s, dls, ev.pages_changed.some((p) => !p.exact) || ev.pdf_fallback !== null))
            ? await readPdf(o.pdfPath)
            : null;
          this.post({ type: 'layout', pages: ev.pages_changed, pagesTotal: ev.pages_total, placements: ev.placements, keepFromRevision: o.keepFromRevision, pdf });
        });
        break;
      }
      case 'paragraph': {
        const ev = o.ev;
        this.enqueue(async () => {
          await this.sendResources(s, [ev.dl]);
          this.post({ type: 'paragraph', parId: ev.par_id, dl: ev.dl, fragments: ev.fragments, revision: ev.versions.source_revision });
        });
        break;
      }
      case 'dropOverlays':
        this.enqueue(async () => this.post({ type: 'dropOverlays', parIds: o.parIds }));
        break;
      case 'reveal':
        this.post({ type: 'reveal', page: o.target.page, x: o.target.x, y: o.target.y, force: o.force });
        break;
      case 'banner':
        this.post({ type: 'banner', text: o.text, kind: o.level, actions: o.actions });
        break;
    }
  }

  /** Send missing fonts/images; true when some page will need the PDF instead. */
  private async needsPdf(s: Session, dls: DisplayList[], degraded: boolean): Promise<boolean> {
    const missing = await this.sendResources(s, dls);
    return degraded || missing;
  }

  private async sendResources(s: Session, dls: DisplayList[]): Promise<boolean> {
    const loader = this.host.resources(s);
    const [fonts, images] = await Promise.all([loader.fontsFor(dls, this.sentFonts), loader.imagesFor(dls, this.sentImages, s.projectRoot)]);
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
    if (fonts.size || images.size) this.post({ type: 'resources', fonts: [...fonts], images: [...images] });
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
        const ok = await this.session?.jumpToSource(m.page, m.x, m.y);
        if (!ok) vscode.window.setStatusBarMessage('$(info) No source paragraph found at that spot of the preview.', 3000);
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
    this.post({ type: 'hint', text: 'Tip: double-click anywhere in the preview to jump to that paragraph in the source.' });
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

async function readPdf(file: string): Promise<Uint8Array | null> {
  try {
    const data = await fs.readFile(file);
    // a PDF being rewritten by the next pass is incomplete: it must end with %%EOF
    const tail = data.subarray(Math.max(0, data.length - 64)).toString('latin1');
    return tail.includes('%%EOF') ? new Uint8Array(data) : null;
  } catch {
    return null;
  }
}

export function previewTitle(mainFile: string): string {
  return `Preview ${path.basename(mainFile)}`;
}
