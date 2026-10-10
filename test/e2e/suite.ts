// Integration suite, run inside the VS Code extension host by runTest.ts.
import { execFile } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { Api } from '../../src/extension';
import { runTask, sq } from '../../src/setup';

const shots = process.env.RTEX_E2E_OUT ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 60000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function screenshot(name: string): Promise<void> {
  if (!shots || !process.env.DISPLAY) return Promise.resolve();
  mkdirSync(shots, { recursive: true });
  return new Promise((resolve) => execFile('import', ['-window', 'root', path.join(shots, name)], () => resolve()));
}

async function insertAfter(doc: vscode.TextDocument, needle: string, text: string): Promise<void> {
  const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  const at = doc.positionAt(doc.getText().indexOf(needle) + needle.length);
  await editor.edit((e) => e.insert(at, text));
}

export async function run(): Promise<void> {
  try {
    await steps();
  } catch (e) {
    const s = vscode.extensions.getExtension<Api>('henryxiaoyang.realtime-tex')?.exports.session();
    console.log('[e2e] status at failure:', JSON.stringify(s?.status));
    await screenshot('failure.png');
    throw e;
  }
}

async function steps(): Promise<void> {
  const ext = vscode.extensions.getExtension<Api>('henryxiaoyang.realtime-tex')!;
  const api = await ext.activate();
  const folder = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const steps: string[] = [];
  const step = (s: string) => {
    steps.push(s);
    console.log(`[e2e] ✓ ${s}`);
  };

  // a clean window for the screenshots
  for (const c of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closeSidebar', 'workbench.action.closePanel']) {
    await vscode.commands.executeCommand(c).then(undefined, () => undefined);
  }

  // 1. open an included file and the preview: the main file is found through \input
  const intro = await vscode.workspace.openTextDocument(path.join(folder, 'intro.tex'));
  await vscode.window.showTextDocument(intro, vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('a session', () => api.session() !== undefined, 10000);
  const s = api.session()!;
  if (path.basename(s.mainFile) !== 'main.tex') throw new Error(`main file ${s.mainFile}`);
  step('main file found through \\input');
  await waitFor('the first layout', () => s.status.phase === 'live' && s.model.hasLayout, 120000);
  step(`first layout: ${s.model.pagesTotal} page(s)`);
  await sleep(1500);
  await vscode.commands.executeCommand('notifications.clearAll');
  await screenshot('1-preview.png');

  // 2. a keystroke in the main file takes the fast path
  const main = await vscode.workspace.openTextDocument(path.join(folder, 'main.tex'));
  await insertAfter(main, 'This paragraph is typeset', ' live and instantly');
  await waitFor('a fast update', () => s.status.lastFastMs !== undefined && s.model.overlays.size > 0, 30000);
  step(`fast update in ${s.status.lastFastMs!.toFixed(2)} ms`);
  await sleep(800);
  await screenshot('2-fast-edit.png');
  // the gutter marks the edited paragraph live and the preamble as waiting for the full compile
  const marks = await s.liveMarks(main);
  const at = (needle: string) => {
    const b = Buffer.byteLength(main.getText().slice(0, main.getText().indexOf(needle)));
    return marks.find((m) => m.span.range.start <= b && b < m.span.range.end)?.kind;
  };
  if (at('This paragraph is typeset') !== 'live') throw new Error(`edited paragraph marked ${at('This paragraph is typeset')}`);
  if (at('\\documentclass') !== 'full') throw new Error(`preamble marked ${at('\\documentclass')}`);
  step(`gutter: ${marks.filter((m) => m.kind === 'live').length} live part(s), ${marks.filter((m) => m.kind === 'full').length} on the full compile`);

  // 3. cursor → preview and preview → source
  const editor = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const pos = main.positionAt(main.getText().indexOf('A second paragraph') + 5);
  editor.selection = new vscode.Selection(pos, pos);
  if (!(await s.revealInPreview(main, pos, true))) throw new Error('revealInPreview failed');
  step('cursor position shown in the preview');
  const placements = s.placements();
  const [parId, frags] = [...placements].find(([, f]) => f.length > 0)!;
  const f = frags[0];
  if (!(await s.jumpToSource(f.page, f.xs[0], f.baselines[0]))) throw new Error('jumpToSource failed');
  const active = vscode.window.activeTextEditor!;
  step(`preview click on unit ${parId} opened ${path.basename(active.document.fileName)}:${active.selection.active.line + 1}`);

  // 4. an error shows up in the Problems panel, and goes away when fixed
  await insertAfter(main, 'A second paragraph refers', ' \\undefinedmacroxyz{}');
  await waitFor('an error diagnostic', () => vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 60000);
  step('LaTeX error reported as a diagnostic');
  await sleep(500);
  await screenshot('3-error.png');
  const ed2 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
  const start = main.getText().indexOf(' \\undefinedmacroxyz{}');
  await ed2.edit((e) => e.delete(new vscode.Range(main.positionAt(start), main.positionAt(start + ' \\undefinedmacroxyz{}'.length))));
  await waitFor('the error to clear', () => !vscode.languages.getDiagnostics(main.uri).some((d) => d.severity === vscode.DiagnosticSeverity.Error), 60000);
  step('diagnostic cleared after the fix');

  // 5. a TikZ page is shown from the PDF (pdf.js under the webview's CSP)
  if (s.model.pagesTotal >= 2) {
    const pageTwo = s.model.pages.get(2);
    if (pageTwo?.exact) throw new Error('the TikZ page should be degraded');
    await api.panel()!.panel.webview.postMessage({ type: 'reveal', page: 2, x: 0, y: 0, force: true });
    await sleep(2500);
    await screenshot('4-pdf-fallback.png');
    step('TikZ page shown from the PDF');
  }

  // 6. export
  const pdf = await s.exportPdf();
  if (!pdf || !existsSync(pdf)) throw new Error(`export produced no PDF (${pdf})`);
  step(`exported ${path.basename(pdf)}`);

  // 7. a full compile that fails after the first layout keeps the pages. RTEX_E2E_SKIP_FAILED_PASS=1
  // skips it: rtex (e5cab6a through b858819) reports the body-only pass after a breaking preamble edit as Ok
  // with the previous pages
  if (!process.env.RTEX_E2E_SKIP_FAILED_PASS) {
    const pagesBefore = s.model.pagesTotal;
    await insertAfter(main, '\\usepackage{tikz}', '\n\\stop');
    await waitFor('a failed full compile', () => s.status.compile?.state === 'Failed', 120000);
    if (s.model.pagesTotal !== pagesBefore) throw new Error(`pages dropped: ${pagesBefore} -> ${s.model.pagesTotal}`);
    step(`failed compile kept the ${pagesBefore} page(s) on screen`);
    await sleep(800);
    await screenshot('4b-failed-pass-banner.png');
    const ed3 = await vscode.window.showTextDocument(main, vscode.ViewColumn.One);
    const bad = main.getText().indexOf('\n\\stop');
    await ed3.edit((e) => e.delete(new vscode.Range(main.positionAt(bad), main.positionAt(bad + '\n\\stop'.length))));
    await waitFor('a good full compile again', () => s.status.compile?.state === 'Ok', 120000);
    step('recovered after the preamble was fixed');
  }

  // 8. closing the preview stops the engine
  api.panel()!.panel.dispose();
  await waitFor('the engine to stop', () => !s.running, 10000);
  step('engine stopped when the preview closed');

  // 9. a document whose first compile fails explains why instead of waiting forever
  const broken = path.join(folder, 'broken.tex');
  await vscode.workspace.fs.writeFile(
    vscode.Uri.file(broken),
    // \stop ends the run in the preamble: no page at all
    Buffer.from('\\documentclass{article}\n\\stop\n\\begin{document}\nHello\n\\end{document}\n'),
  );
  await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(broken), vscode.ViewColumn.One);
  await vscode.commands.executeCommand('realtimeTex.openPreview');
  await waitFor('a session for broken.tex', () => api.session()?.mainFile === broken, 10000);
  const sb = api.session()!;
  await waitFor('the failure screen', () => sb.screen.screen === 'error', 120000);
  if (sb.screen.title !== 'The document produced no pages' || !sb.screen.message) throw new Error(`unexpected screen: ${JSON.stringify(sb.screen)}`);
  step(`failed first compile explained: ${sb.screen.message}`);
  await sleep(800);
  await screenshot('5-first-compile-failed.png');

  // 10. the terminal tasks of Install rtex / Install TeX Live reach bash intact (Git Bash on
  // Windows): quotes, command substitution and a path with a space
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'rtex task ')), "it's here.txt");
  if (!(await runTask('Realtime TeX task check', path.dirname(out), `set -e; v="it's ok"; echo "$v $(echo nested)" > ${sq(out)}`))) throw new Error('the task failed');
  const got = existsSync(out) ? readFileSync(out, 'utf8').trim() : '(no file)';
  if (got !== "it's ok nested") throw new Error(`the task wrote ${got}`);
  step(`setup task ran in ${process.platform === 'win32' ? 'Git Bash' : 'bash'}`);
  console.log(`[e2e] all ${steps.length} steps passed`);
}
