// Getting rtex and LuaLaTeX in place: the setup check, building rtex from source, installing
// a minimal TeX Live, and pointing at an existing binary.
import { execFile } from 'child_process';
import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { activeManaged, cfg, exe, installedRelease, managedBinary, managedCheckout, platformSupported, processEnv, resolveServer, setActiveManaged, texliveInstallerDir } from './config';
import { fetchRepoFile, installRelease, latestReleaseTag } from './prebuilt';
import { isNewer } from './release';

const REPO_URL = 'https://github.com/HenryXiaoYang/realtime-tex';
const BRANCH = 'main';

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

const WINDOWS = process.platform === 'win32';

/** A path quoted for bash. On Windows the path is written with forward slashes, which Git
 * Bash, git and cargo all read as the same Windows path. */
export const sq = (s: string) => `'${(WINDOWS ? s.replace(/\\/g, '/') : s).replace(/'/g, `'\\''`)}'`;

/** Git for Windows' bash, which runs the build and install scripts on Windows. Found next to
 * git itself, else in the usual install folders; never the bash.exe in System32 (that is WSL). */
async function gitBash(): Promise<string | undefined> {
  const roots: string[] = [];
  const execPath = await run('git', ['--exec-path']);
  // <root>/mingw64/libexec/git-core
  if (execPath.ok && execPath.stdout.trim()) roots.push(path.resolve(execPath.stdout.trim(), '..', '..', '..'));
  for (const v of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) if (process.env[v]) roots.push(path.join(process.env[v]!, 'Git'));
  if (process.env.LOCALAPPDATA) roots.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Git'));
  for (const root of roots) {
    for (const p of [path.join(root, 'bin', 'bash.exe'), path.join(root, 'usr', 'bin', 'bash.exe')]) if (existsSync(p)) return p;
  }
  return undefined;
}

/** The shell for the terminal tasks: bash, which on Windows is Git Bash. */
async function taskShell(): Promise<string | undefined> {
  return WINDOWS ? gitBash() : '/bin/bash';
}

export async function runChecks(ctx: vscode.ExtensionContext): Promise<Check[]> {
  const checks: Check[] = [];
  const supported = platformSupported();
  checks.push({
    title: 'Operating system',
    state: supported ? 'pass' : 'fail',
    detail: supported ? `${process.platform} is supported` : `rtex runs on Linux, macOS and Windows, not on ${process.platform}.`,
  });

  const server = resolveServer(ctx);
  if (!server) {
    checks.push({
      title: 'rtex engine',
      state: 'fail',
      detail: 'not found. Install it once (a download of a few MB), or locate an existing binary.',
      fix: { label: 'Install rtex', run: () => vscode.commands.executeCommand('realtimeTex.installRtex') },
    });
  } else {
    const v = await run(server.path, ['--version']);
    checks.push({
      title: 'rtex engine',
      state: v.ok ? 'pass' : 'fail',
      detail: v.ok
        ? `${v.stdout.trim()}${server.kind === 'release' ? ' (release)' : server.kind === 'source' ? ' (built from source)' : ''} — ${server.path}`
        : `cannot run ${server.path}: ${v.stderr.trim() || 'unknown error'}`,
      fix: v.ok ? undefined : { label: 'Reinstall rtex', run: () => vscode.commands.executeCommand('realtimeTex.installRtex') },
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
    // a release keeps them in <prefix>/share/rtex/tex, a source build in <checkout>/tex
    const guess =
      [path.resolve(path.dirname(server.path), '..', 'share', 'rtex', 'tex'), path.resolve(path.dirname(server.path), '..', '..', 'tex')].find((d) =>
        existsSync(path.join(d, 'rtex-dl.lua')),
      ) ?? path.resolve(path.dirname(server.path), '..', '..', 'tex');
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
      if (!existsSync(path.join(uri[0].fsPath, exe('lualatex')))) {
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

/** Run a bash script in a terminal task; resolves to whether it exited with 0. The script is
 * handed to bash as one argument (no shell in between), the same way on every platform. */
export async function runTask(name: string, cwd: string, script: string): Promise<boolean> {
  const shell = await taskShell();
  if (!shell) {
    void vscode.window.showErrorMessage(`${name} needs Git for Windows (it brings the bash that runs the setup scripts). Install it and try again.`);
    return false;
  }
  const task = new vscode.Task(
    { type: 'process', id: `realtimeTex.${name}` },
    vscode.TaskScope.Global,
    name,
    'Realtime TeX',
    new vscode.ProcessExecution(shell, ['-c', script], { cwd }),
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

/** Clone the managed checkout, or bring it to the latest realtime-tex main. The checkout belongs
 * to the extension; local changes in it stop the update instead of being thrown away. */
function cloneScript(dir: string): string {
  const d = sq(dir);
  return [
    `if [ -d ${sq(path.join(dir, '.git'))} ]; then`,
    `  if [ -n "$(git -C ${d} status --porcelain --untracked-files=no)" ]; then echo "${dir} has local changes; not updating it." >&2; exit 3; fi;`,
    `  git -C ${d} fetch --depth 1 origin ${BRANCH} && git -C ${d} reset --hard FETCH_HEAD;`,
    `else git clone --depth 1 --branch ${BRANCH} ${REPO_URL} ${d}; fi`,
  ].join(' ');
}

let building = false;

/** Check git and cargo; explain what is missing. */
async function buildToolsReady(action: string): Promise<boolean> {
  if (!platformSupported()) {
    void vscode.window.showErrorMessage(`rtex runs on Linux, macOS and Windows, not on ${process.platform}.`);
    return false;
  }
  if (building) {
    void vscode.window.showInformationMessage('rtex is already being built — see the terminal.');
    return false;
  }
  const [git, cargo] = await Promise.all([run('git', ['--version']), run('cargo', ['--version'])]);
  if (!git.ok) {
    void vscode.window.showErrorMessage(`${action} needs git${WINDOWS ? ' (Git for Windows)' : ''}. Install it and try again.`);
    return false;
  }
  if (WINDOWS && !(await gitBash())) {
    void vscode.window.showErrorMessage(`${action} needs the bash of Git for Windows, which was not found. Reinstall Git for Windows and try again.`);
    return false;
  }
  if (!cargo.ok) {
    const pick = await vscode.window.showErrorMessage(`rtex is built from source with Rust. Install Rust (cargo) first, then try "${action}" again.`, 'Install Rust');
    if (pick) void vscode.env.openExternal(vscode.Uri.parse(WINDOWS ? 'https://rustup.rs/#install-windows' : 'https://rustup.rs'));
    return false;
  }
  return true;
}

/** Clone or update the managed checkout and build rtex in a terminal task. */
async function buildManaged(ctx: vscode.ExtensionContext, title: string): Promise<boolean> {
  const dir = managedCheckout(ctx);
  await fs.mkdir(path.dirname(dir), { recursive: true });
  building = true;
  try {
    return await runTask(
      title,
      path.dirname(dir),
      `set -e; echo "${title}: ${dir}"; ${cloneScript(dir)}; cd ${sq(dir)}; git log -1 --format='realtime-tex %h %s'; cargo build --release -p rtex-cli; echo; echo "rtex built: ${managedBinary(ctx)}"`,
    );
  } finally {
    building = false;
  }
}

/** After rtex was installed or built: clear a custom binary path, make sure LuaLaTeX is there
 * too, then restart the engine on the new rtex. */
async function afterInstall(ctx: vscode.ExtensionContext, what: string, onDone: () => void): Promise<void> {
  if (cfg().get<string>('serverPath', '')) await cfg().update('serverPath', '', vscode.ConfigurationTarget.Global);
  const lua = await run('lualatex', ['--version'], processEnv(ctx, resolveServer(ctx)));
  if (!lua.ok) {
    const pick = await vscode.window.showWarningMessage(`${what} is installed. It also needs LuaLaTeX from TeX Live 2026, which was not found.`, 'Fix…');
    if (pick) await fixTexLive(ctx);
    return;
  }
  onDone();
  const pick = await vscode.window.showInformationMessage(`${what} is installed and ready.`, 'Open Live Preview');
  if (pick) void vscode.commands.executeCommand('realtimeTex.openPreview');
}

let downloading = false;

/** Download the latest prebuilt rtex (`tag` to pick one); false when that did not work. */
async function downloadRelease(ctx: vscode.ExtensionContext, title: string, onDone: () => void, tag?: string): Promise<boolean> {
  if (downloading) {
    void vscode.window.showInformationMessage('rtex is already being downloaded.');
    return false;
  }
  downloading = true;
  let res;
  try {
    res = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title }, (p) => installRelease(ctx, p, tag));
  } finally {
    downloading = false;
  }
  if (res.ok) {
    void ctx.globalState.update(LAST_CHECK, Date.now());
    await afterInstall(ctx, `rtex ${res.tag}`, onDone);
    return true;
  }
  const actions = res.unsupported ? ['Build from Source'] : ['Retry', 'Build from Source'];
  const pick = await vscode.window.showErrorMessage(`${title} failed. ${res.error}`, ...actions);
  if (pick === 'Retry') return downloadRelease(ctx, title, onDone, tag);
  if (pick === 'Build from Source') await buildFromSource(ctx, onDone);
  return false;
}

/** "Install rtex": download the prebuilt engine from the latest realtime-tex release, or build
 * it from source when `realtimeTex.installFrom` says so. */
export async function installRtex(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  if (!platformSupported()) {
    void vscode.window.showErrorMessage(`rtex runs on Linux, macOS and Windows, not on ${process.platform}.`);
    return;
  }
  if (cfg().get<string>('installFrom', 'release') === 'source') {
    await buildFromSource(ctx, onDone);
    return;
  }
  await downloadRelease(ctx, 'Installing rtex', onDone);
}

/** "Install rtex (Build from Source)": clone realtime-tex main and build it with cargo. */
export async function buildFromSource(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  if (!(await buildToolsReady('Install rtex'))) return;
  if (!(await buildManaged(ctx, 'Install rtex'))) {
    void vscode.window.showErrorMessage(
      WINDOWS
        ? 'Installing rtex failed. The terminal shows what went wrong. On Windows, Rust needs the Visual Studio C++ Build Tools to link rtex.'
        : 'Installing rtex failed. The terminal shows what went wrong.',
    );
    return;
  }
  await setActiveManaged(ctx, 'source');
  await afterInstall(ctx, 'rtex', onDone);
}

/** Update the managed rtex the way it was installed: the latest release, or realtime-tex main
 * rebuilt from source. */
export async function updateRtex(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  const kind = activeManaged(ctx);
  const custom = cfg().get<string>('serverPath', '');
  if (!kind || custom) {
    if (custom) {
      const pick = await vscode.window.showInformationMessage(
        `The rtex in use (${custom}) is not managed by the extension: update it where it came from. Or let the extension install and update its own copy.`,
        'Install Managed Copy',
      );
      if (pick) await installRtex(ctx, onDone);
    } else {
      await installRtex(ctx, onDone);
    }
    return;
  }
  if (kind === 'release') {
    const installed = installedRelease(ctx);
    let latest: string;
    try {
      latest = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Checking for a newer rtex…' }, () => latestReleaseTag());
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not reach GitHub to check for a newer rtex: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    void ctx.globalState.update(LAST_CHECK, Date.now());
    if (!isNewer(latest, installed)) {
      void vscode.window.showInformationMessage(`rtex is up to date (${installed}).`);
      return;
    }
    await downloadRelease(ctx, `Updating rtex to ${latest}`, onDone, latest);
    return;
  }
  if (!(await buildToolsReady('Update rtex'))) return;
  const dir = managedCheckout(ctx);
  const before = (await run('git', ['-C', dir, 'rev-parse', '--short', 'HEAD'])).stdout.trim();
  if (!(await buildManaged(ctx, 'Update rtex'))) {
    void vscode.window.showErrorMessage('Updating rtex failed. The terminal shows what went wrong; the previous build is unchanged if the build step did not start.');
    return;
  }
  void ctx.globalState.update(LAST_CHECK, Date.now());
  const after = (await run('git', ['-C', dir, 'log', '-1', '--format=%h %s'])).stdout.trim();
  onDone();
  void vscode.window.showInformationMessage(
    after.startsWith(before) ? `rtex is up to date (${after}).` : `rtex updated to ${after}. The engine was restarted.`,
  );
}

const LAST_CHECK = 'realtimeTex.lastUpdateCheck';
const DAY = 24 * 60 * 60 * 1000;

/** Look for a newer rtex (at most once a day) and act on `realtimeTex.updateCheck`: a newer
 * release for a downloaded rtex, new commits on main for one built from source. */
export async function checkForRtexUpdate(ctx: vscode.ExtensionContext, onDone: () => void): Promise<void> {
  const mode = cfg().get<string>('updateCheck', 'notify');
  const kind = activeManaged(ctx);
  if (mode === 'off' || !kind || cfg().get<string>('serverPath', '')) return;
  const last = ctx.globalState.get<number>(LAST_CHECK, 0);
  if (Date.now() - last < DAY) return;
  void ctx.globalState.update(LAST_CHECK, Date.now());
  let what: string;
  if (kind === 'release') {
    const latest = await latestReleaseTag().catch(() => undefined);
    if (!latest || !isNewer(latest, installedRelease(ctx))) return; // offline or up to date
    what = `rtex ${latest} is available`;
  } else {
    const dir = managedCheckout(ctx);
    const fetch = await run('git', ['-C', dir, 'fetch', '--depth', '1', 'origin', BRANCH], undefined, 30000);
    if (!fetch.ok) return; // offline: try again another day
    const [head, latest] = await Promise.all([run('git', ['-C', dir, 'rev-parse', 'HEAD']), run('git', ['-C', dir, 'rev-parse', 'FETCH_HEAD'])]);
    if (!head.ok || !latest.ok || head.stdout.trim() === latest.stdout.trim()) return;
    const subject = (await run('git', ['-C', dir, 'log', '-1', '--format=%s', 'FETCH_HEAD'])).stdout.trim();
    what = `A newer rtex engine is available${subject ? `: “${subject}”` : ''}`;
  }
  if (mode === 'auto') {
    await updateRtex(ctx, onDone);
    return;
  }
  const pick = await vscode.window.showInformationMessage(`${what}.`, 'Update Now', 'Later', "Don't Check");
  if (pick === 'Update Now') await updateRtex(ctx, onDone);
  else if (pick === "Don't Check") await cfg().update('updateCheck', 'off', vscode.ConfigurationTarget.Global);
}

/** Install a minimal TeX Live with realtime-tex's installer script, downloaded on its own (no
 * checkout needed). It installs into the extension's storage and writes the texlive.env that
 * processEnv reads. */
export async function installTexLive(ctx: vscode.ExtensionContext): Promise<void> {
  const dir = texliveInstallerDir(ctx);
  try {
    await fs.mkdir(path.join(dir, 'scripts'), { recursive: true });
    for (const f of ['install-texlive.sh', 'texlive.profile']) await fs.writeFile(path.join(dir, 'scripts', f), await fetchRepoFile(`scripts/${f}`));
  } catch (e) {
    void vscode.window.showErrorMessage(`Could not download the TeX Live installer script: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  const ok = await runTask('Install TeX Live for rtex', dir, `set -e; cd ${sq(dir)}; bash scripts/install-texlive.sh`);
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
  const uri = await vscode.window.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, title: `Select the rtex binary (target/release/${exe('rtex')})`,
    openLabel: 'Use this rtex',
    filters: WINDOWS ? { Programs: ['exe'] } : undefined,
  });
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
