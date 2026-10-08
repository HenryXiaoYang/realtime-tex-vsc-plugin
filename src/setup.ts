// Getting rtex and LuaLaTeX in place: the setup check, building rtex from source, installing
// a minimal TeX Live, and pointing at an existing binary.
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { cfg, managedCheckout, processEnv, resolveServer } from './config';

const REPO_URL = 'https://github.com/HenryXiaoYang/realtime-tex';

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv, timeout = 15000): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { env, timeout }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
  });
}

type CheckState = 'pass' | 'warn' | 'fail';

interface Check {
  title: string;
  state: CheckState;
  detail: string;
  fix?: { label: string; run: () => unknown };
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function runChecks(ctx: vscode.ExtensionContext): Promise<Check[]> {
  const checks: Check[] = [];
  const supported = process.platform === 'linux' || process.platform === 'darwin';
  checks.push({
    title: 'Operating system',
    state: supported ? 'pass' : 'fail',
    detail: supported ? `${process.platform} is supported` : 'rtex needs Linux or macOS. On Windows, open your folder in WSL.',
    fix: supported ? undefined : { label: 'Learn about WSL', run: () => vscode.env.openExternal(vscode.Uri.parse('https://code.visualstudio.com/docs/remote/wsl')) },
  });

  const server = resolveServer(ctx);
  if (!server) {
    checks.push({
      title: 'rtex engine',
      state: 'fail',
      detail: 'not found. Install it once (built from source with Rust), or locate an existing binary.',
      fix: { label: 'Install rtex', run: () => vscode.commands.executeCommand('realtimeTex.buildFromSource') },
    });
  } else {
    const v = await run(server.path, ['--version']);
    checks.push({
      title: 'rtex engine',
      state: v.ok ? 'pass' : 'fail',
      detail: v.ok ? `${v.stdout.trim()} — ${server.path}` : `cannot run ${server.path}: ${v.stderr.trim() || 'unknown error'}`,
      fix: v.ok ? undefined : { label: 'Reinstall rtex', run: () => vscode.commands.executeCommand('realtimeTex.buildFromSource') },
    });
  }

  const env = processEnv(ctx, server);
  const lua = await run('lualatex', ['--version'], env);
  if (!lua.ok) {
    checks.push({
      title: 'LuaLaTeX (TeX Live)',
      state: 'fail',
      detail: 'lualatex was not found. Install TeX Live 2026, or set the folder that contains lualatex.',
      fix: { label: 'Fix…', run: () => fixTexLive(ctx) },
    });
  } else {
    const first = lua.stdout.split('\n')[0].trim();
    const year = Number(/TeX Live (\d{4})/.exec(lua.stdout)?.[1] ?? 0);
    checks.push({
      title: 'LuaLaTeX (TeX Live)',
      state: year && year < 2026 ? 'warn' : 'pass',
      detail: year && year < 2026 ? `${first} — rtex is tested with TeX Live 2026; older versions may not work` : first,
      fix: year && year < 2026 ? { label: 'Fix…', run: () => fixTexLive(ctx) } : undefined,
    });
  }

  if (server) {
    const texDir = env.RTEX_TEXDIR;
    const guess = path.resolve(path.dirname(server.path), '..', '..', 'tex');
    const found = texDir ? existsSync(path.join(texDir, 'rtex-dl.lua')) : existsSync(path.join(guess, 'rtex-dl.lua'));
    checks.push({
      title: 'rtex TeX files',
      state: found ? 'pass' : texDir ? 'fail' : 'warn',
      detail: found
        ? (texDir ?? guess)
        : texDir
          ? `${texDir} has no rtex-dl.lua`
          : 'not next to the binary; rtex uses the folder it was built in (set "Tex Dir" if you moved it)',
      fix: found ? undefined : { label: 'Set tex/ folder', run: () => vscode.commands.executeCommand('workbench.action.openSettings', 'realtimeTex.texDir') },
    });
  }

  if (lua.ok) {
    const map = await run('kpsewhich', ['pdftex.map'], env);
    checks.push({
      title: 'Type1 font map',
      state: map.ok && map.stdout.trim() ? 'pass' : 'warn',
      detail:
        map.ok && map.stdout.trim()
          ? 'math in Computer Modern renders live'
          : 'pdftex.map not found: pages using classic Computer Modern math are shown from the PDF',
    });
  }
  return checks;
}

const STATE_ICON: Record<CheckState, string> = { pass: '$(pass-filled)', warn: '$(warning)', fail: '$(error)' };

export async function checkSetup(ctx: vscode.ExtensionContext): Promise<void> {
  const checks = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking Realtime TeX setup…' }, () => runChecks(ctx));
  const ok = checks.every((c) => c.state !== 'fail');
  type Item = vscode.QuickPickItem & { check?: Check; open?: boolean };
  const items: Item[] = checks.map((c) => ({
    label: `${STATE_ICON[c.state]} ${c.title}`,
    detail: c.detail,
    description: c.fix ? `→ ${c.fix.label}` : undefined,
    check: c,
  }));
  if (ok) items.push({ label: '$(open-preview) Open Live Preview', detail: 'Everything needed is in place.', open: true });
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = ok ? 'Realtime TeX is ready' : 'Realtime TeX setup — select an item to fix it';
  qp.items = items;
  qp.matchOnDetail = true;
  qp.onDidAccept(() => {
    const it = qp.selectedItems[0];
    qp.hide();
    if (it?.open) void vscode.commands.executeCommand('realtimeTex.openPreview');
    else void it?.check?.fix?.run();
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

async function fixTexLive(ctx: vscode.ExtensionContext): Promise<void> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '$(folder-opened) I have TeX Live — choose its bin folder…', id: 'choose' },
      { label: '$(cloud-download) Install a minimal TeX Live 2026 for rtex', description: '≈ 15 min, ≈ 1 GB, no admin rights', id: 'install' },
      { label: '$(link-external) Download TeX Live from tug.org', id: 'web' },
    ],
    { title: 'LuaLaTeX from TeX Live 2026 is needed' },
  );
  if (pick?.id === 'choose') {
    const uri = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, title: 'Folder that contains lualatex (…/texlive/2026/bin/<platform>)' });
    if (uri?.[0]) {
      if (!existsSync(path.join(uri[0].fsPath, 'lualatex'))) {
        void vscode.window.showWarningMessage(`There is no lualatex in ${uri[0].fsPath}.`);
        return;
      }
      await cfg().update('texliveBin', uri[0].fsPath, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage('TeX Live folder saved.');
    }
  } else if (pick?.id === 'install') {
    await installTexLive(ctx);
  } else if (pick?.id === 'web') {
    void vscode.env.openExternal(vscode.Uri.parse('https://tug.org/texlive/'));
  }
}

async function runTask(name: string, cwd: string, script: string): Promise<boolean> {
  const task = new vscode.Task(
    { type: 'shell', id: `realtimeTex.${name}` },
    vscode.TaskScope.Global,
    name,
    'Realtime TeX',
    new vscode.ShellExecution(script, { cwd, executable: '/bin/bash', shellArgs: ['-c'] }),
  );
  task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, panel: vscode.TaskPanelKind.Dedicated, clear: true };
  const exec = await vscode.tasks.executeTask(task);
  return new Promise((resolve) => {
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== exec) return;
      sub.dispose();
      resolve(e.exitCode === 0);
    });
  });
}

function cloneScript(dir: string): string {
  return `if [ -d ${sq(path.join(dir, '.git'))} ]; then git -C ${sq(dir)} pull --ff-only; else git clone --depth 1 ${REPO_URL} ${sq(dir)}; fi`;
}

let building = false;

export async function buildFromSource(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    void vscode.window.showErrorMessage('rtex runs on Linux and macOS. On Windows, open your folder in WSL and install it there.');
    return;
  }
  if (building) {
    void vscode.window.showInformationMessage('rtex is already being installed — see the terminal.');
    return;
  }
  const [git, cargo] = await Promise.all([run('git', ['--version']), run('cargo', ['--version'])]);
  if (!git.ok) {
    void vscode.window.showErrorMessage('Installing rtex needs git. Install git and try again.');
    return;
  }
  if (!cargo.ok) {
    const pick = await vscode.window.showErrorMessage(
      'rtex is built from source with Rust. Install Rust (cargo) first, then run "Install rtex" again.',
      'Install Rust',
    );
    if (pick) void vscode.env.openExternal(vscode.Uri.parse('https://rustup.rs'));
    return;
  }
  const dir = managedCheckout(ctx);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  building = true;
  try {
    const ok = await runTask(
      'Install rtex',
      path.dirname(dir),
      `set -e; echo "Installing rtex into ${dir}"; ${cloneScript(dir)}; cd ${sq(dir)}; cargo build --release -p rtex-cli; echo; echo "rtex installed: ${path.join(dir, 'target', 'release', 'rtex')}"`,
    );
    if (!ok) {
      void vscode.window.showErrorMessage('Installing rtex failed. The terminal shows what went wrong.');
      return;
    }
  } finally {
    building = false;
  }
  if (cfg().get<string>('serverPath', '')) await cfg().update('serverPath', '', vscode.ConfigurationTarget.Global);
  const lua = await run('lualatex', ['--version'], processEnv(ctx, resolveServer(ctx)));
  if (!lua.ok) {
    const pick = await vscode.window.showWarningMessage('rtex is installed. It also needs LuaLaTeX from TeX Live 2026, which was not found.', 'Fix…');
    if (pick) await fixTexLive(ctx);
    return;
  }
  onDone();
  const pick = await vscode.window.showInformationMessage('rtex is installed and ready.', 'Open Live Preview');
  if (pick) void vscode.commands.executeCommand('realtimeTex.openPreview');
}

export async function installTexLive(ctx: vscode.ExtensionContext): Promise<void> {
  const dir = managedCheckout(ctx);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  const ok = await runTask('Install TeX Live for rtex', path.dirname(dir), `set -e; ${cloneScript(dir)}; cd ${sq(dir)}; bash scripts/install-texlive.sh`);
  if (ok) {
    if (cfg().get<string>('texliveBin', '')) await cfg().update('texliveBin', '', vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage('TeX Live is installed and will be used by the live preview.', 'Open Live Preview').then((p) => {
      if (p) void vscode.commands.executeCommand('realtimeTex.openPreview');
    });
  } else {
    void vscode.window.showErrorMessage('Installing TeX Live failed. The terminal shows what went wrong.');
  }
}

export async function selectServerPath(): Promise<boolean> {
  const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, title: 'Select the rtex binary (target/release/rtex)', openLabel: 'Use this rtex' });
  if (!uri?.[0]) return false;
  const v = await run(uri[0].fsPath, ['--version']);
  if (!v.ok) {
    void vscode.window.showErrorMessage(`${uri[0].fsPath} does not look like rtex (it did not answer --version).`);
    return false;
  }
  await cfg().update('serverPath', uri[0].fsPath, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(`Using ${v.stdout.trim()}.`);
  return true;
}
