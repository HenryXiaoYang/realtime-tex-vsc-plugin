// Settings and the locations derived from them.
import { existsSync, readFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export const SECTION = 'realtimeTex';

export function cfg(scope?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION, scope);
}

export function expandHome(p: string): string {
  return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}

const WINDOWS = process.platform === 'win32';

/** Platforms rtex runs on. */
export function platformSupported(): boolean {
  return process.platform === 'linux' || process.platform === 'darwin' || WINDOWS;
}

/** `name` as an executable file name on this platform (`rtex` → `rtex.exe` on Windows). */
export function exe(name: string): string {
  return WINDOWS && !/\.exe$/i.test(name) ? `${name}.exe` : name;
}

/** The checkout made by "Install rtex (Build from Source)". */
export function managedCheckout(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'realtime-tex');
}

/** The rtex binary built in the managed checkout. */
export function managedBinary(ctx: vscode.ExtensionContext): string {
  return path.join(managedCheckout(ctx), 'target', 'release', exe('rtex'));
}

/** Where "Install rtex" unpacks release archives: one folder per release tag, and a `current`
 * file naming the one in use. */
export function releasesDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'rtex-release');
}

/** The tag of the installed prebuilt rtex, if any. */
export function installedRelease(ctx: vscode.ExtensionContext): string | undefined {
  try {
    const tag = readFileSync(path.join(releasesDir(ctx), 'current'), 'utf8').trim();
    return tag && existsSync(releaseBinary(ctx, tag)) ? tag : undefined;
  } catch {
    return undefined;
  }
}

export function releaseBinary(ctx: vscode.ExtensionContext, tag: string): string {
  return path.join(releasesDir(ctx), tag, 'bin', exe('rtex'));
}

export type ManagedKind = 'release' | 'source';

const ACTIVE = 'realtimeTex.activeManaged';

/** Which managed rtex is in use: the one installed last, else whichever exists. */
export function activeManaged(ctx: vscode.ExtensionContext): ManagedKind | undefined {
  const has = { release: installedRelease(ctx) !== undefined, source: existsSync(managedBinary(ctx)) };
  const chosen = ctx.globalState.get<ManagedKind>(ACTIVE);
  if (chosen && has[chosen]) return chosen;
  return has.release ? 'release' : has.source ? 'source' : undefined;
}

export function setActiveManaged(ctx: vscode.ExtensionContext, kind: ManagedKind): Thenable<void> {
  return ctx.globalState.update(ACTIVE, kind);
}

/** Where "Install TeX Live" runs realtime-tex's installer (and where it installs). */
export function texliveInstallerDir(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'texlive');
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const file of WINDOWS ? [exe(name), name] : [name]) {
      const p = path.join(dir, file);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
}

/** The key of PATH in `env`: a copy of process.env keeps Windows' spelling (`Path`), and a
 * second `PATH` next to it would leave the child's search path to chance. */
function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
}

export interface ServerLocation {
  path: string;
  source: 'setting' | 'managed' | 'PATH';
  /** For a managed rtex: downloaded from a release or built from source. */
  kind?: ManagedKind;
}

/** The rtex binary: the setting, else the managed copy (downloaded or built), else `rtex` on
 * PATH. */
export function resolveServer(ctx: vscode.ExtensionContext): ServerLocation | undefined {
  const configured = cfg().get<string>('serverPath', '').trim();
  if (configured) {
    const p = expandHome(configured);
    if (path.isAbsolute(p)) return existsSync(p) ? { path: p, source: 'setting' } : undefined;
    const found = onPath(p);
    return found ? { path: found, source: 'setting' } : undefined;
  }
  const kind = activeManaged(ctx);
  if (kind === 'release') return { path: releaseBinary(ctx, installedRelease(ctx)!), source: 'managed', kind };
  if (kind === 'source') return { path: managedBinary(ctx), source: 'managed', kind };
  const found = onPath('rtex');
  return found ? { path: found, source: 'PATH' } : undefined;
}

/** Variables from a `texlive.env` written by realtime-tex's scripts/install-texlive.sh. */
function texliveEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^export\s+([A-Z_]+)="([^"]*)"/.exec(line.trim());
    if (m && m[1] !== 'PATH') out[m[1]] = m[2];
  }
  return out;
}

/** Environment for rtex and the TeX tools it runs. */
export function processEnv(ctx: vscode.ExtensionContext, server?: ServerLocation): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // a TeX Live installed by "Install TeX Live" (realtime-tex's scripts/install-texlive.sh), in
  // its own folder or, from earlier versions, next to the managed checkout
  const envFile = [texliveInstallerDir(ctx), managedCheckout(ctx)].map((d) => path.join(d, 'build', 'texlive.env')).find((f) => existsSync(f));
  const managedTl = envFile ? texliveEnvFile(envFile) : {};
  let bin = expandHome(cfg().get<string>('texliveBin', '').trim());
  if (!bin && managedTl.RTEX_TEXLIVE_BIN) {
    bin = managedTl.RTEX_TEXLIVE_BIN;
    Object.assign(env, managedTl);
  }
  if (bin) {
    env.RTEX_TEXLIVE_BIN = bin;
    const key = pathKey(env);
    env[key] = `${bin}${path.delimiter}${env[key] ?? ''}`;
  }
  const texDir = expandHome(cfg().get<string>('texDir', '').trim());
  if (texDir) env.RTEX_TEXDIR = texDir;
  else if (server) {
    // a binary built in a checkout finds <checkout>/tex by itself; one copied elsewhere does
    // not, so point at a checkout's tex/ when it sits next to the binary's target dir
    const guess = path.resolve(path.dirname(server.path), '..', '..', 'tex');
    if (existsSync(path.join(guess, 'rtex-dl.lua'))) env.RTEX_TEXDIR = guess;
  }
  return env;
}

export function buildDirFor(ctx: vscode.ExtensionContext, mainFile: string): string {
  const configured = expandHome(cfg(vscode.Uri.file(mainFile)).get<string>('buildDir', '').trim());
  if (configured) return path.isAbsolute(configured) ? configured : path.join(path.dirname(mainFile), configured);
  const base = ctx.storageUri?.fsPath ?? ctx.globalStorageUri.fsPath;
  // one directory per main file
  const id = Buffer.from(mainFile).toString('base64url').slice(-48);
  return path.join(base, 'build', id);
}

export function exportPathFor(mainFile: string): string {
  const tmpl = cfg(vscode.Uri.file(mainFile)).get<string>('exportPath', '${mainDir}/${mainName}.pdf') || '${mainDir}/${mainName}.pdf';
  const mainDir = path.dirname(mainFile);
  const mainName = path.basename(mainFile, path.extname(mainFile));
  const wsFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(mainFile))?.uri.fsPath ?? mainDir;
  const p = expandHome(
    tmpl.replace(/\$\{mainDir\}/g, mainDir).replace(/\$\{mainName\}/g, mainName).replace(/\$\{workspaceFolder\}/g, wsFolder),
  );
  return path.isAbsolute(p) ? p : path.join(mainDir, p);
}

export function isTexDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file' && (doc.languageId === 'latex' || doc.languageId === 'tex' || /\.tex$/i.test(doc.fileName));
}

/** `rtex serve` options from the realtimeTex.engine.* settings. Only values that differ from
 * rtex's defaults are passed, so an older rtex without these options still starts. */
export function engineArgs(scope?: vscode.Uri): string[] {
  const c = cfg(scope);
  const args: string[] = [];
  const eligibility = c.get<string>('engine.eligibility', 'probe');
  if (eligibility && eligibility !== 'probe') args.push('--eligibility', eligibility);
  const budget = Math.round(c.get<number>('engine.fastBudgetMs', 50));
  if (budget > 0 && budget !== 50) args.push('--fast-budget-ms', String(budget));
  if (!c.get<boolean>('engine.pictureCache', true)) args.push('--no-picture-cache');
  return args;
}

/** The rtex debug directory when realtimeTex.debug.enabled is on (rtex reads it from
 * RTEX_DEBUG_DIR; versions without debug support ignore the variable). */
export function debugDir(ctx: vscode.ExtensionContext): string | undefined {
  if (!cfg().get<boolean>('debug.enabled', false)) return undefined;
  const configured = expandHome(cfg().get<string>('debug.directory', '').trim());
  return configured || path.join(ctx.globalStorageUri.fsPath, 'debug');
}
