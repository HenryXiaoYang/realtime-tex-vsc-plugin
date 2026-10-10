// Downloading and unpacking a prebuilt rtex from realtime-tex's GitHub releases.
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, promises as fs } from 'fs';
import * as https from 'https';
import * as path from 'path';
import * as vscode from 'vscode';
import { installedRelease, releaseBinary, releasesDir, setActiveManaged } from './config';
import { assetName, assetUrl, RELEASES_API, releaseTarget, sha256For } from './release';

const UA = { 'User-Agent': 'realtime-tex-vscode' };

/** GET `url` (following redirects); resolves to the final response. */
function get(url: string, headers: Record<string, string> = UA, redirects = 6): Promise<import('http').IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, timeout: 30000 }, (res) => {
      const loc = res.headers.location;
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`));
        return resolve(get(new URL(loc, url).toString(), headers, redirects - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url}: HTTP ${res.statusCode}`));
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error(`${url}: timed out`)));
    req.on('error', reject);
  });
}

async function getText(url: string, headers: Record<string, string> = UA): Promise<string> {
  const res = await get(url, headers);
  const chunks: Buffer[] = [];
  for await (const c of res) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** The tag of the latest realtime-tex release. The API is rate-limited without a token, so the
 * redirect of github.com/…/releases/latest is the fallback. */
export async function latestReleaseTag(): Promise<string> {
  try {
    const tag = JSON.parse(await getText(RELEASES_API, { ...UA, Accept: 'application/vnd.github+json' })).tag_name;
    if (typeof tag === 'string' && tag) return tag;
  } catch {
    /* fall back below */
  }
  return new Promise((resolve, reject) => {
    const req = https.request('https://github.com/HenryXiaoYang/realtime-tex/releases/latest', { method: 'HEAD', headers: UA, timeout: 30000 }, (res) => {
      res.resume();
      const tag = /\/releases\/tag\/([^/?#]+)/.exec(res.headers.location ?? '')?.[1];
      if (tag) resolve(decodeURIComponent(tag));
      else reject(new Error('could not find the latest realtime-tex release'));
    });
    req.on('timeout', () => req.destroy(new Error('github.com timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function download(url: string, file: string, onProgress: (fraction: number) => void): Promise<void> {
  const res = await get(url);
  const total = Number(res.headers['content-length'] ?? 0);
  let got = 0;
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    res.on('data', (c: Buffer) => {
      got += c.length;
      if (total) onProgress(got / total);
    });
    res.on('error', reject);
    out.on('error', reject);
    out.on('finish', () => resolve());
    res.pipe(out);
  });
}

async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  h.update(await fs.readFile(file));
  return h.digest('hex');
}

function run(cmd: string, args: string[], timeout = 60000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) =>
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => resolve({ ok: !err, out: `${stdout ?? ''}${stderr ?? ''}`.trim() || String(err ?? '') })),
  );
}

/** tar unpacks both archive kinds: GNU or BSD tar on Linux and macOS, and Windows' own bsdtar,
 * which reads .zip (named by full path: a Git Bash tar earlier on PATH cannot). */
function tarCommand(): string {
  return process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
}

export type InstallResult = { ok: true; tag: string; version: string } | { ok: false; unsupported?: boolean; error: string };

/**
 * Download release `tag` (default: the latest) for this machine, check its SHA-256, unpack it
 * into its own folder and make it the rtex in use. A running engine keeps its binary: the new
 * one is in another folder, and the old folder is removed when it can be.
 */
export async function installRelease(
  ctx: vscode.ExtensionContext,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  tag?: string,
): Promise<InstallResult> {
  const target = releaseTarget(process.platform, process.arch);
  if (!target) return { ok: false, unsupported: true, error: `There is no prebuilt rtex for ${process.platform}-${process.arch}.` };
  const root = releasesDir(ctx);
  await fs.mkdir(root, { recursive: true });
  try {
    progress.report({ message: 'finding the latest release…' });
    tag ??= await latestReleaseTag();
    const name = assetName(target);
    const archive = path.join(root, `.download-${name}`);
    let reported = 0;
    await download(assetUrl(tag, target), archive, (f) => {
      const pct = Math.floor(f * 80);
      if (pct > reported) {
        progress.report({ message: `downloading ${name} (${Math.round(f * 100)} %)`, increment: pct - reported });
        reported = pct;
      }
    });
    progress.report({ message: 'checking the download…' });
    const expected = sha256For(await getText(`${assetUrl(tag, target)}.sha256`), name);
    const actual = await sha256File(archive);
    if (!expected || expected !== actual) {
      await fs.rm(archive, { force: true });
      return { ok: false, error: `The download of ${name} does not match its published SHA-256 checksum.` };
    }
    progress.report({ message: 'unpacking…', increment: Math.max(0, 90 - reported) });
    const staging = path.join(root, `.unpack-${tag}`);
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    const tar = await run(tarCommand(), ['-xf', archive, '-C', staging, '--strip-components=1']);
    await fs.rm(archive, { force: true });
    if (!tar.ok) return { ok: false, error: `Unpacking ${name} failed: ${tar.out}` };
    const dest = path.join(root, tag);
    await fs.rm(dest, { recursive: true, force: true }).catch(() => undefined);
    // still there: the same release, its engine running (Windows keeps a running .exe)
    if (existsSync(dest)) await fs.rm(staging, { recursive: true, force: true });
    else await fs.rename(staging, dest);
    const v = await run(releaseBinary(ctx, tag), ['--version'], 15000);
    if (!v.ok) return { ok: false, error: `The downloaded rtex does not run on this computer: ${v.out}` };
    await fs.writeFile(path.join(root, 'current'), tag);
    await setActiveManaged(ctx, 'release');
    progress.report({ increment: 10 });
    await pruneReleases(ctx);
    return { ok: true, tag, version: v.out.split('\n')[0] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove downloaded releases other than the current one (best effort: one whose rtex is still
 * running stays until the next time). */
export async function pruneReleases(ctx: vscode.ExtensionContext): Promise<void> {
  const root = releasesDir(ctx);
  const current = installedRelease(ctx);
  if (!current || !existsSync(root)) return;
  for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (e.isDirectory() && e.name !== current) await fs.rm(path.join(root, e.name), { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Fetch a text file of realtime-tex `main` (for the TeX Live installer script). */
export function fetchRepoFile(rel: string): Promise<string> {
  return getText(`https://raw.githubusercontent.com/HenryXiaoYang/realtime-tex/main/${rel}`);
}
