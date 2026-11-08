import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, debugDir, isTexDocument, platformSupported, processEnv, resolveServer } from './config';
import { PreviewPanel, VIEW_TYPE } from './preview/panel';
import { ResourceLoader } from './resources';
import { findMainFile, isMainFile, PREVIEW_WRAPPER, previewWrapper } from './root';
import { type Screen, Session } from './session';
import { pruneReleases } from './prebuilt';
import { buildFromSource, checkForRtexUpdate, checkSetup, installRtex, selectServerPath, updateRtex } from './setup';
import { StatusBar } from './statusBar';

const WALKTHROUGH = 'henryxiaoyang.realtime-tex#realtimeTex.welcome';

let ctx: vscode.ExtensionContext;
let log: vscode.OutputChannel;
let statusBar: StatusBar;
let lastTexDoc: vscode.Uri | undefined;

/** One previewed document: its engine and the panel showing it. No panel: started by
 * autoStart, or its panel was closed; such an engine gives way to the next one started. */
interface Preview {
  session: Session;
  panel: PreviewPanel | undefined;
  diagnostics: vscode.DiagnosticCollection;
  subs: vscode.Disposable[];
}
/** By main file: each one has its own panel and engine. */
const previews = new Map<string, Preview>();
let lastUsed: Preview | undefined;
/** A panel showing a screen without a session (no main file…); the next preview opened uses it. */
let spare: PreviewPanel | undefined;
const loaders = new WeakMap<Session, ResourceLoader>();

/** The preview commands act on: the one of the active editor's project, else the focused or last used one. */
function current(): Preview | undefined {
  const all = [...previews.values()];
  const ed = vscode.window.activeTextEditor;
  if (ed) {
    const file = ed.document.fileName;
    const own = all.filter((p) => p.session.relPath(ed.document) !== undefined);
    // the file itself, else the innermost project that contains it
    const best = own.find((p) => p.session.sourceFile === file) ?? own.sort((a, b) => b.session.projectRoot.length - a.session.projectRoot.length)[0];
    if (best) return best;
  }
  return all.find((p) => p.panel?.panel.active) ?? lastUsed ?? all[0];
}
const session = (): Session | undefined => current()?.session;
const sessions = (): Session[] => [...previews.values()].map((p) => p.session);
/** The engines that get the edits of `doc`: all whose project has it, except that the main file
 * of one preview is not part of another (two main files in one folder). */
const sessionsFor = (doc: vscode.TextDocument): Session[] => sessions().filter((s) => s.mainFile === doc.fileName || !previews.has(doc.fileName));

/** Handles for the integration tests. */
export interface Api {
  session(): Session | undefined;
  panel(): PreviewPanel | undefined;
}

export function activate(context: vscode.ExtensionContext): Api {
  ctx = context;
  log = vscode.window.createOutputChannel('Realtime TeX');
  statusBar = new StatusBar();
  context.subscriptions.push(log, statusBar, { dispose: () => [...previews.values()].forEach(endSession) });

  const reg = (id: string, fn: (...args: any[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('realtimeTex.openPreview', (uri?: vscode.Uri) => openPreview(uri, true));
  reg('realtimeTex.openPreviewHere', (uri?: vscode.Uri) => openPreview(uri, false));
  reg('realtimeTex.previewFile', (uri?: vscode.Uri) => openPreview(uri, true, true));
  reg('realtimeTex.exportPdf', () => withSession((s) => s.exportPdf()));
  reg('realtimeTex.recompile', () => withSession((s) => s.recompile()));
  reg('realtimeTex.restart', () => {
    const s = session();
    return s ? s.restart().then(updateUi) : openPreview(undefined, true);
  });
  reg('realtimeTex.stop', async () => {
    await session()?.stop();
    updateUi();
  });
  reg('realtimeTex.showLog', () => log.show(true));
  reg('realtimeTex.openLatexLog', () => withSession((s) => s.openLatexLog(), true));
  reg('realtimeTex.openDebugFolder', () => openDebugFolder());
  reg('realtimeTex.checkSetup', () => checkSetup(ctx));
  // a new engine takes effect when the running (or failed) session restarts; a stopped one stays stopped
  const restartAfterBuild = () => {
    for (const s of sessions()) if (s.running || s.status.phase === 'failed') void s.restart().then(updateUi);
  };
  reg('realtimeTex.installRtex', () => installRtex(ctx, restartAfterBuild));
  reg('realtimeTex.buildFromSource', () => buildFromSource(ctx, restartAfterBuild));
  reg('realtimeTex.updateRtex', () => updateRtex(ctx, restartAfterBuild));
  reg('realtimeTex.selectServerPath', async () => {
    if (await selectServerPath()) await Promise.all(sessions().map((s) => s.restart()));
  });
  reg('realtimeTex.selectMainFile', () => selectMainFile());
  reg('realtimeTex.syncToPreview', () => syncToPreview(true));
  reg('realtimeTex.gettingStarted', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', WALKTHROUGH, false));

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => sessionsFor(e.document).forEach((s) => s.onDidChangeDocument(e))),
    vscode.workspace.onDidOpenTextDocument((d) => sessionsFor(d).forEach((s) => s.onDidOpenDocument(d))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      const engineSettings = ['realtimeTex.engine', 'realtimeTex.debug', 'realtimeTex.serverPath', 'realtimeTex.texliveBin', 'realtimeTex.texDir', 'realtimeTex.buildDir', 'realtimeTex.env'];
      const running = sessions().filter((s) => s.running);
      if (!running.length || !engineSettings.some((k) => e.affectsConfiguration(k))) return;
      vscode.window.setStatusBarMessage('$(sync~spin) Restarting the engine with the new settings…', 4000);
      for (const s of running) void s.restart().then(updateUi);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => sessionsFor(d).forEach((s) => void s.onDidCloseDocument(d))),
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
      async deserializeWebviewPanel(webviewPanel, state?: { main?: string }) {
        const panel = new PreviewPanel(ctx, panelHost, webviewPanel);
        // panels saved before 0.0.6 have no main file of their own
        const main = state?.main ?? ctx.workspaceState.get<string>('realtimeTex.lastMainFile');
        if (main && !previews.get(main)?.panel && (await exists(main))) {
          await startFor(main, panel);
        } else {
          spare?.dispose();
          spare = panel;
          panel.showScreen(noFileScreen());
        }
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
  const updateTimer = setTimeout(() => {
    void pruneReleases(ctx); // releases an engine still ran on when they were replaced
    void checkForRtexUpdate(ctx, restartAfterBuild);
  }, 15000);
  context.subscriptions.push({ dispose: () => clearTimeout(updateTimer) });
  return { session, panel: () => current()?.panel ?? spare };
}

export async function deactivate(): Promise<void> {
  await Promise.all(sessions().map((s) => s.stop()));
}

// ---------------------------------------------------------------------------------------------

const panelHost = {
  get log() {
    return log;
  },
  resources(s: Session): ResourceLoader {
    let l = loaders.get(s);
    if (!l) loaders.set(s, (l = new ResourceLoader(processEnv(ctx, resolveServer(ctx), s.mainFile), (m) => log.appendLine(m))));
    return l;
  },
  onPanelClosed(panel: PreviewPanel) {
    if (spare === panel) spare = undefined;
    const p = [...previews.values()].find((q) => q.panel === panel);
    if (!p) return;
    p.panel = undefined;
    if (cfg().get<boolean>('stopWhenPreviewCloses', true) && !cfg().get<boolean>('autoStart', false)) {
      void p.session.stop().then(updateUi);
    }
    updateUi();
  },
};

/** Stop showing `p`: its engine, diagnostics and gutter go; its panel stays. */
function endSession(p: Preview): void {
  p.session.dispose();
  p.diagnostics.dispose();
  for (const d of p.subs) d.dispose();
  if (previews.get(p.session.mainFile) === p) previews.delete(p.session.mainFile);
  if (lastUsed === p) lastUsed = undefined;
}

function updateUi(): void {
  const ed = vscode.window.activeTextEditor;
  const s = session();
  statusBar.update(s?.status, !!ed && isTexDocument(ed.document));
  void vscode.commands.executeCommand('setContext', 'realtimeTex.running', !!s?.running);
}

async function withSession(fn: (s: Session) => unknown, evenIfStopped = false): Promise<void> {
  const session = current()?.session;
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
  const uris = await vscode.workspace.findFiles('**/*.tex', `{**/node_modules/**,**/.git/**,**/build/**,**/${PREVIEW_WRAPPER}}`, 500);
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

/** `alone`: preview the file itself, not the main file of its project. */
async function openPreview(uri: vscode.Uri | undefined, beside: boolean, alone = false): Promise<void> {
  const column = beside ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active;
  const show = (s: Screen) => {
    if (!spare) spare = PreviewPanel.create(ctx, panelHost, column, true);
    else spare.reveal(true);
    spare.showScreen(s);
  };

  if (!platformSupported()) {
    show({ screen: 'unsupported', message: `The rtex engine runs on Linux, macOS and Windows, not on ${process.platform}.` });
    return;
  }
  const doc = targetDocument(uri);
  if (!doc) {
    const p = current();
    if (p) await startFor(p.session.mainFile, column, p.session.preview);
    else show(noFileScreen());
    return;
  }
  if (alone) {
    await previewAlone(doc, column);
    return;
  }
  const main = await mainFileFor(doc);
  if (!main) {
    show({
      screen: 'noMain',
      message: `${path.basename(doc.fsPath)} has no \\documentclass, and no single main file includes it. Choose the main file of this project (you can also add "% !TEX root = main.tex" at the top of ${path.basename(doc.fsPath)}).`,
      actions: [
        { label: 'Choose Main File…', command: 'realtimeTex.selectMainFile', primary: true },
        { label: 'Preview This File Only', command: 'realtimeTex.previewFile' },
      ],
    });
    return;
  }
  await startFor(main, column);
}

/** Preview `doc` by itself: as its own main file when it has \documentclass, else wrapped in
 * realtimeTex.previewTemplate. */
async function previewAlone(doc: vscode.Uri, column: vscode.ViewColumn): Promise<void> {
  const file = doc.fsPath;
  if (isMainFile((await readText(file)) ?? '')) return startFor(file, column);
  // the wrapper sits in the project's main folder, so the file's own \input and
  // \includegraphics paths resolve as they do in the whole document
  const main = await mainFileFor(doc);
  const fromMain = main && path.relative(path.dirname(main), file);
  const root = fromMain && !fromMain.startsWith('..') && !path.isAbsolute(fromMain) ? path.dirname(main) : path.dirname(file);
  const text = previewWrapper(cfg(doc).get<string>('previewTemplate', ''), path.relative(root, file));
  await startFor(path.join(root, PREVIEW_WRAPPER), column, { file, text });
}

/** Start (or show) the preview of `main`. `target`: the panel to show it in, or the column
 * of a new one; none for an engine without a preview (autoStart). */
async function startFor(main: string, target?: vscode.ViewColumn | PreviewPanel, preview?: { file: string; text: string }): Promise<void> {
  let p = previews.get(main);
  const panel = p?.panel;
  if (p && p.session.preview?.text !== preview?.text) {
    // another wrapper of the same folder: it uses the same build directory, so it takes over
    await p.session.stop();
    endSession(p);
    p = undefined;
  }
  if (!p) {
    for (const q of [...previews.values()]) {
      if (q.panel) continue;
      await q.session.stop();
      endSession(q);
    }
    const diagnostics = vscode.languages.createDiagnosticCollection('realtime-tex');
    const session = new Session(ctx, main, log, diagnostics, preview);
    p = { session, panel, diagnostics, subs: [session.onStatus(() => updateUi())] };
    previews.set(main, p);
    // a wrapper is gone once its session ends, so a restored panel reopens the last main file
    if (!preview) void ctx.workspaceState.update('realtimeTex.lastMainFile', main);
  }
  if (target instanceof PreviewPanel) {
    if (spare === target) spare = undefined;
    bindPanel(p, target);
  } else if (target !== undefined) {
    if (!p.panel) {
      bindPanel(p, spare ?? PreviewPanel.create(ctx, panelHost, target, true));
      spare = undefined;
    }
    p.panel!.reveal(true);
  }
  p.panel?.attach(p.session);
  lastUsed = p;
  if (!p.session.running) await p.session.start();
  updateUi();
}

function bindPanel(p: Preview, panel: PreviewPanel): void {
  p.panel = panel;
  panel.attach(p.session);
  panel.panel.onDidChangeViewState((e) => {
    if (!e.webviewPanel.active) return;
    const now = [...previews.values()].find((q) => q.panel === panel);
    if (now) lastUsed = now;
    updateUi();
  });
}

async function maybeAutoStart(doc: vscode.TextDocument): Promise<void> {
  if (!cfg(doc.uri).get<boolean>('autoStart', false) || sessions().some((s) => s.running)) return;
  if (!platformSupported()) return;
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
  const p = current();
  if (!p?.session.running || !p.panel || !isTexDocument(editor.document)) return;
  if (!cfg().get<boolean>('syncCursor', true)) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void p.session.revealInPreview(editor.document, editor.selection.active, false), 150);
}

async function syncToPreview(force: boolean): Promise<void> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || !isTexDocument(ed.document)) return;
  const p = current();
  if (!p?.session.running || !p.panel) {
    await openPreview(ed.document.uri, true);
    return;
  }
  p.panel.reveal(true);
  const ok = await p.session.revealInPreview(ed.document, ed.selection.active, force);
  if (!ok) vscode.window.setStatusBarMessage('$(info) This part of the source has no position in the preview yet.', 3000);
}

async function openDebugFolder(): Promise<void> {
  const dir = debugDir(ctx);
  if (!dir) {
    const pick = await vscode.window.showInformationMessage(
      'Debugging is off. Turn it on to have rtex save a bundle (source, context, trace, TeX log) whenever the live engine hangs or crashes.',
      'Turn On Debugging',
    );
    if (pick) {
      await cfg().update('debug.enabled', true, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(`Debugging is on. Bundles go to ${debugDir(ctx)}.`);
    }
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir));
}

async function welcome(): Promise<void> {
  const key = 'realtimeTex.welcomed';
  if (ctx.globalState.get<boolean>(key)) return;
  await ctx.globalState.update(key, true);
  // let a preview that is being opened right now speak for itself
  await new Promise((r) => setTimeout(r, 3000));
  if (spare || [...previews.values()].some((p) => p.panel)) return;
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
