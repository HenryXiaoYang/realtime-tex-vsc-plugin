// Gutter markers next to the line numbers: a solid bar beside the parts that update live as you
// type, a dotted one beside the parts that wait for the full compile.
import * as vscode from 'vscode';
import { ShadowText } from './edits';
import { LiveState, trimRange } from './liveMarks';
import type { Span } from './protocol';
import { explainReasons } from './status';

export interface GutterSource {
  /** Path relative to the project when the session tracks the document. */
  relPath(doc: vscode.TextDocument): string | undefined;
  spans(rel: string): Promise<Span[]>;
  shadow(rel: string): ShadowText | undefined;
  running(): boolean;
}

export class LiveGutter implements vscode.Disposable {
  readonly state = new LiveState();
  private readonly live: vscode.TextEditorDecorationType;
  private readonly full: vscode.TextEditorDecorationType;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private subs: vscode.Disposable[] = [];

  constructor(
    media: vscode.Uri,
    private readonly source: GutterSource,
  ) {
    const icon = (name: string): vscode.DecorationRenderOptions => ({
      light: { gutterIconPath: vscode.Uri.joinPath(media, `gutter-${name}-light.svg`) },
      dark: { gutterIconPath: vscode.Uri.joinPath(media, `gutter-${name}-dark.svg`) },
      gutterIconSize: 'cover',
    });
    this.live = vscode.window.createTextEditorDecorationType(icon('live'));
    this.full = vscode.window.createTextEditorDecorationType(icon('full'));
    this.subs.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refresh(0)),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('realtimeTex.editor.liveMarkers') && this.refresh(0)),
    );
  }

  /** Redraw the markers of the visible editors after `delay` ms (the last call wins). */
  refresh(delay = 150): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.draw(), delay);
  }

  clear(): void {
    clearTimeout(this.timer);
    for (const ed of vscode.window.visibleTextEditors) {
      ed.setDecorations(this.live, []);
      ed.setDecorations(this.full, []);
    }
  }

  private async draw(): Promise<void> {
    for (const ed of vscode.window.visibleTextEditors) {
      const doc = ed.document;
      const rel = this.source.relPath(doc);
      if (!rel) continue;
      const on = vscode.workspace.getConfiguration('realtimeTex', doc.uri).get<boolean>('editor.liveMarkers', true);
      if (!on || !this.source.running()) {
        ed.setDecorations(this.live, []);
        ed.setDecorations(this.full, []);
        continue;
      }
      const version = doc.version;
      const spans = await this.source.spans(rel);
      // typed on meanwhile: the next refresh has the current spans
      if (doc.version !== version || doc.isClosed) continue;
      const shadow = this.source.shadow(rel) ?? new ShadowText(doc.getText());
      const text = doc.getText();
      const live: vscode.DecorationOptions[] = [];
      const full: vscode.DecorationOptions[] = [];
      for (const m of this.state.marks(spans)) {
        const r = trimRange(text, shadow.utf16Offset(m.span.range.start), shadow.utf16Offset(m.span.range.end));
        if (!r) continue;
        const range = new vscode.Range(doc.positionAt(r[0]), doc.positionAt(r[1]));
        if (m.kind === 'live') live.push({ range });
        else full.push({ range, hoverMessage: m.reasons ? new vscode.MarkdownString(`**Realtime TeX:** this part updates with the full compile, not live: ${explainReasons(m.reasons)}.`) : undefined });
      }
      ed.setDecorations(this.live, live);
      ed.setDecorations(this.full, full);
    }
  }

  dispose(): void {
    this.clear();
    for (const s of this.subs) s.dispose();
    this.live.dispose();
    this.full.dispose();
  }
}
