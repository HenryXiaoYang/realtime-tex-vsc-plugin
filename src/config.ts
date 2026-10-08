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

/** The checkout made by "Install rtex (Build from Source)". */
export function managedCheckout(ctx: vscode.ExtensionContext): string {
  return path.join(ctx.globalStorageUri.fsPath, 'realtime-tex');
}

function onPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (existsSync(p)) return p;
  }
  return undefined;
}

export interface ServerLocation {
  path: string;
  source: 'setting' | 'managed' | 'PATH';
}

/** The rtex binary: the setting, else the managed build, else `rtex` on PATH. */
export function resolveServer(ctx: vscode.ExtensionContext): ServerLocation | undefined {
  const configured = cfg().get<string>('serverPath', '').trim();
  if (configured) {
    const p = expandHome(configured);
    if (path.isAbsolute(p)) return existsSync(p) ? { path: p, source: 'setting' } : undefined;
    const found = onPath(p);
    return found ? { path: found, source: 'setting' } : undefined;
  }
  const managed = path.join(managedCheckout(ctx), 'target', 'release', 'rtex');
  if (existsSync(managed)) return { path: managed, source: 'managed' };
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
  const checkout = managedCheckout(ctx);
  // a TeX Live installed next to the managed checkout (scripts/install-texlive.sh)
  const managedTl = texliveEnvFile(path.join(checkout, 'build', 'texlive.env'));
  let bin = expandHome(cfg().get<string>('texliveBin', '').trim());
  if (!bin && managedTl.RTEX_TEXLIVE_BIN) {
    bin = managedTl.RTEX_TEXLIVE_BIN;
    Object.assign(env, managedTl);
  }
  if (bin) {
    env.RTEX_TEXLIVE_BIN = bin;
    env.PATH = `${bin}${path.delimiter}${env.PATH ?? ''}`;
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
  const budget = Math.round(c.get<number>('engine.fastBudgetMs', 5));
  if (budget > 0 && budget !== 5) args.push('--fast-budget-ms', String(budget));
  if (!c.get<boolean>('engine.pictureCache', true)) args.push('--no-picture-cache');
  return args;
}
