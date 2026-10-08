// The status bar entry: one click opens the preview; while running it says what the engine does.
import * as vscode from 'vscode';
import { describe, SessionStatus } from './status';

const ICON: Record<string, string> = {
  idle: '$(open-preview)',
  busy: '$(sync~spin)',
  live: '$(zap)',
  ok: '$(check)',
  warn: '$(warning)',
  error: '$(error)',
};

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('realtimeTex.status', vscode.StatusBarAlignment.Right, 100);

  constructor() {
    this.item.name = 'Realtime TeX';
  }

  update(status: SessionStatus | undefined, activeIsTex: boolean): void {
    const s = status ?? { phase: 'idle', pending: false, errorCount: 0, pagesTotal: 0 };
    const running = s.phase !== 'idle' && s.phase !== 'stopped';
    if (!running && !activeIsTex) {
      this.item.hide();
      return;
    }
    const d = describe(s);
    this.item.text = `${ICON[d.kind] ?? ''} ${s.phase === 'idle' || s.phase === 'stopped' ? 'Live Preview' : `TeX: ${d.text}`}`;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = true;
    md.appendMarkdown(`**Realtime TeX**${s.mainName && running ? ` — ${s.mainName}` : ''}\n\n${d.tooltip}\n\n`);
    if (running) {
      md.appendMarkdown(
        '[$(open-preview) Show Preview](command:realtimeTex.openPreview) · [$(file-pdf) Export PDF](command:realtimeTex.exportPdf) · [$(refresh) Recompile](command:realtimeTex.recompile) · [$(output) Log](command:realtimeTex.showLog)',
      );
    } else {
      md.appendMarkdown('[$(open-preview) Open Live Preview](command:realtimeTex.openPreview) · [$(rocket) Get Started](command:realtimeTex.gettingStarted)');
    }
    this.item.tooltip = md;
    this.item.command = d.kind === 'error' || d.kind === 'warn' ? 'workbench.actions.view.problems' : 'realtimeTex.openPreview';
    this.item.backgroundColor = d.kind === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    this.item.show();
  }

  dispose(): void {
    this.item.dispose();
  }
}
