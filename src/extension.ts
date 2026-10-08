import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, isTexDocument, processEnv, resolveServer } from './config';
import { PreviewPanel, VIEW_TYPE } from './preview/panel';
import { ResourceLoader } from './resources';
import { findMainFile, isMainFile } from './root';
import { Session } from './session';
import { buildFromSource, checkForRtexUpdate, checkSetup, selectServerPath, updateRtex } from './setup';
import { StatusBar } from './statusBar';

const WALKTHROUGH = 'henryxiaoyang.realtime-tex#realtimeTex.welcome';

let ctx: vscode.ExtensionContext;
let log: vscode.OutputChannel;
let diagnostics: vscode.DiagnosticCollection;
let statusBar: StatusBar;
let session: Session | undefined;
let sessionSubs: vscode.Disposable[] = [];
let panel: PreviewPanel | undefined;
let loader: { session: Session; loader: ResourceLoader } | undefined;
let lastTexDoc: vscode.Uri | undefined;

/** Handles for the integration tests. */
export interface Api {
  session(): Session | undefined;
  panel(): PreviewPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): Api {
  ctx = context;
  log = vscode.window.createOutputChannel('Realtime TeX');
  diagnostics = vscode.languages.createDiagnosticCollection('realtime-tex');
  statusBar = new StatusBar();
  context.subscriptions.push(log, diagnostics, statusBar, { dispose: () => session?.dispose() });

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('realtimeTex.openPreview', (uri?: vscode.Uri) => openPreview(uri, true));
  reg('realtimeTex.openPreviewHere', (uri?: vscode.Uri) => openPreview(uri, false));
  reg('realtimeTex.exportPdf', () => withSession((s) => s.exportPdf()));
  reg('realtimeTex.recompile', () => withSession((s) => s.recompile()));
  reg('realtimeTex.restart', () => (session ? session.restart() : openPreview(undefined, true)));
  reg('realtimeTex.stop', async () => {
    await session?.stop();
    updateUi();
  });
  reg('realtimeTex.showLog', () => log.show(true));
  reg('realtimeTex.openLatexLog', () => withSession((s) => s.openLatexLog(), true));
  reg('realtimeTex.checkSetup', () => checkSetup(ctx));
  reg('realtimeTex.buildFromSource', () => buildFromSource(ctx, () => void (session && session.status.phase === 'failed' ? session.restart() : undefined)));
  // a rebuilt engine takes effect when the running (or failed) session restarts; a stopped one stays stopped
  const restartAfterBuild = () => void (session && (session.running || session.status.phase === 'failed') ? session.restart().then(updateUi) : undefined);
  reg('realtimeTex.updateRtex', () => updateRtex(ctx, restartAfterBuild));
  reg('realtimeTex.selectServerPath', async () => {
    if ((await selectServerPath()) && session) await session.restart();
  });
  reg('realtimeTex.selectMainFile', () => selectMainFile());
  reg('realtimeTex.syncToPreview', () => syncToPreview(true));
  reg('realtimeTex.gettingStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH, false));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => session?.onDidChangeDocument(e)),
    vscode.workspace.onDidOpenTextDocument((d) => session?.onDidOpenDocument(d)),
    vscode.workspace.onDidCloseTextDocument((d) => void session?.onDidCloseDocument(d)),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isTexDocument(ed.document)) {
        lastTexDoc = ed.document.uri;
        void maybeAutoStart(ed.document);
      }
      updateUi();
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind === vscode.TextEditorSelectionChangeKind.Command && e.selections.length === 0) return;
      scheduleSync(e.textEditor);
    }),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(webviewPanel) {
        panel = new PreviewPanel(ctx, panelHost, webviewPanel);
        const main = ctx.workspaceState.get<string>('realtimeTex.lastMainFile');
        if (main && (await exists(main))) await startFor(main);
        else panel.showScreen(noFileScreen());
      },
    }),
  );

  const ed = vscode.window.activeTextEditor;
  if (ed && isTexDocument(ed.document)) {
    lastTexDoc = ed.document.uri;
    void maybeAutoStart(ed.document);
  }
  updateUi();
  void welcome();
  // look for a newer engine once things have settled
  const updateTimer = setTimeout(() => void checkForRtexUpdate(ctx, restartAfterBuild), 15000);
  context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });
  return { session: () => session, panel: () => panel };
}

export function deactivate(): Promise<void> | undefined {
  return session?.stop();
}

// ---------------------------------------------------------------------------------------------

const panelHost = {
  get log() {
    return log;
  },
  resources(s: Session): ResourceLoader {
    if (loader?.session !== s) loader = { session: s, loader: new ResourceLoader(processEnv(ctx, resolveServer(ctx)), (m) => log.appendLine(m)) };
    return loader.loader;
  },
  onPanelClosed(p: PreviewPanel) {
    if (panel !== p) return;
    panel = undefined;
    if (cfg().get<boolean>('stopWhenPreviewCloses', true) && !cfg().get<boolean>('autoStart', false)) {
      void session?.stop().then(updateUi);
    }
  },
};

function updateUi(): void {
  const ed = vscode.window.activeTextEditor;
  statusBar.update(session?.status, !!ed && isTexDocument(ed.document));
  void vscode.commands.executeCommand('setContext', 'realtimeTex.running', !!session?.running);
}

async function withSession(fn: (s: Session) => unknown, evenIfStopped = false): Promise<void> {
  if (session && evenIfStopped) {
    await fn(session);
    return;
  }
  if (!session?.running) {
    const pick = await vscode.window.showWarningMessage('The live preview is not running.', 'Open Live Preview');
    if (pick) await openPreview(undefined, true);
    return;
  }
  await fn(session);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function noFileScreen() {
  return {
    screen: 'noMain' as const,
    title: 'Open a LaTeX file to preview it',
    message: 'Open a .tex file in an editor, then click the preview button in its title bar or press Ctrl+Alt+V.',
    actions: [{ label: 'Choose Main File…', command: 'realtimeTex.selectMainFile', primary: true }],
  };
}

/** Which .tex file the user means: the explorer selection, the active editor, the last one. */
function targetDocument(uri?: vscode.Uri): vscode.Uri | undefined {
  if (uri && uri.scheme === 'file' && /\.tex$/i.test(uri.fsPath)) return uri;
  const ed = vscode.window.activeTextEditor;
  if (ed && isTexDocument(ed.document)) return ed.document.uri;
  return lastTexDoc;
}

async function readText(file: string): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.fileName === file);
  if (open) return open.getText();
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

async function texCandidates(): Promise<string[]> {
  const uris = await vscode.workspace.findFiles('**/*.tex', '{**/node_modules/**,**/.git/**,**/build/**}', 500);
  return uris.map((u) => u.fsPath);
}

async function mainFileFor(doc: vscode.Uri): Promise<string | undefined> {
  const folder = vscode.workspace.getWorkspaceFolder(doc)?.uri.fsPath ?? path.dirname(doc.fsPath);
  const configured = cfg(doc).get<string>('mainFile', '').trim();
  const candidates = configured ? [] : await texCandidates();
  return findMainFile({
    activeFile: doc.fsPath,
    configured: configured ? path.resolve(folder, configured) : undefined,
    candidates,
    readFile: readText,
  });
}

async function openPreview(uri: vscode.Uri | undefined, beside: boolean): Promise<void> {
  const column = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  if (!panel) panel = PreviewPanel.create(ctx, panelHost, column, true);
  else panel.reveal(true);

  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    panel.showScreen({
      screen: 'unsupported',
      message:
        'The rtex engine runs on Linux and macOS. On Windows, open this folder in WSL ("WSL: Reopen Folder in WSL") and install the extension there.',
      actions: [{ label: 'Learn about WSL', command: 'vscode.open', args: ['https://code.visualstudio.com/docs/remote/wsl'], primary: true }],
    });
    return;
  }
  const doc = targetDocument(uri);
  if (!doc) {
    if (session) panel.attach(session);
    else panel.showScreen(noFileScreen());
    return;
  }
  const main = await mainFileFor(doc);
  if (!main) {
    panel.showScreen({
      screen: 'noMain',
      message: `${path.basename(doc.fsPath)} has no \\documentclass, and no single main file includes it. Choose the main file of this project (you can also add "% !TEX root = main.tex" at the top of ${path.basename(doc.fsPath)}).`,
      actions: [{ label: 'Choose Main File…', command: 'realtimeTex.selectMainFile', primary: true }],
    });
    return;
  }
  await startFor(main);
}

async function startFor(main: string): Promise<void> {
  if (!session || session.mainFile !== main) {
    session?.dispose();
    for (const d of sessionSubs) d.dispose();
    diagnostics.clear();
    session = new Session(ctx, main, log, diagnostics);
    sessionSubs = [session.onStatus(() => updateUi())];
    void ctx.workspaceState.update('realtimeTex.lastMainFile', main);
  }
  panel?.attach(session);
  if (!session.running) await session.start();
  updateUi();
}

async function maybeAutoStart(doc: vscode.TextDocument): Promise<void> {
  if (!cfg(doc.uri).get<boolean>('autoStart', false) || session?.running) return;
  if (process.platform !== 'linux' && process.platform !== 'darwin') return;
  const main = await mainFileFor(doc.uri);
  if (main && resolveServer(ctx)) await startFor(main);
}

async function selectMainFile(): Promise<void> {
  const files = await texCandidates();
  const items: (vscode.QuickPickItem & { file: string; main: boolean })[] = [];
  for (const f of files) {
    const main = isMainFile((await readText(f)) ?? '');
    items.push({
      label: path.basename(f),
      description: vscode.workspace.asRelativePath(path.dirname(f)),
      detail: main ? '$(file-text) has \\documentclass' : undefined,
      file: f,
      main,
    });
  }
  items.sort((a, b) => Number(b.main) - Number(a.main) || a.label.localeCompare(b.label));
  if (items.length === 0) {
    void vscode.window.showWarningMessage('There are no .tex files in this workspace.');
    return;
  }
  const pick = await vscode.window.showQuickPick(items, { title: 'Main file of the LaTeX project', placeHolder: 'The file with \\documentclass and \\begin{document}' });
  if (!pick) return;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(pick.file));
  if (folder) {
    await cfg(folder.uri).update('mainFile', path.relative(folder.uri.fsPath, pick.file), vscode.ConfigurationTarget.WorkspaceFolder);
  }
  await openPreview(vscode.Uri.file(pick.file), true);
}

let syncTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleSync(editor: vscode.TextEditor): void {
  if (!session?.running || !panel || !isTexDocument(editor.document)) return;
  if (!cfg().get<boolean>('syncCursor', true)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void session?.revealInPreview(editor.document, editor.selection.active, false), 150);
}

async function syncToPreview(force: boolean): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTexDocument(ed.document)) return;
  if (!session?.running || !panel) {
    await openPreview(ed.document.uri, true);
    return;
  }
  panel.reveal(true);
  const ok = await session.revealInPreview(ed.document, ed.selection.active, force);
  if (!ok) vscode.window.setStatusBarMessage('$(info) This part of the source has no position in the preview yet.', 3000);
}

async function welcome(): Promise<void> {
  const key = 'realtimeTex.welcomed';
  if (ctx.globalState.get<boolean>(key)) return;
  await ctx.globalState.update(key, true);
  // let a preview that is being opened right now speak for itself
  await new Promise((r) => setTimeout(r, 3000));
  if (panel) return;
  if (!resolveServer(ctx)) {
    void vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH, false);
    return;
  }
  const pick = await vscode.window.showInformationMessage(
    'Realtime TeX is ready: open the live preview with the preview button in the editor title or Ctrl+Alt+V.',
    'Open Live Preview',
    'Get Started',
  );
  if (pick === 'Open Live Preview') void openPreview(undefined, true);
  if (pick === 'Get Started') void vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH, false);
}
