// Prebuilt rtex from realtime-tex's GitHub releases: which archive fits this machine, and the
// version and checksum arithmetic around it. Pure module.

export const RELEASES_API = 'https://api.github.com/repos/HenryXiaoYang/realtime-tex/releases/latest';
export const RELEASE_DOWNLOAD = 'https://github.com/HenryXiaoYang/realtime-tex/releases/download';

export interface ReleaseTarget {
  /** Rust target triple, as in the asset name `rtex-<triple>.<ext>`. */
  triple: string;
  ext: 'tar.gz' | 'zip';
}

/** The release archive for `platform`/`arch` (Node's names); undefined where no prebuilt exists. */
export function releaseTarget(platform: string, arch: string): ReleaseTarget | undefined {
  const triple: Record<string, string> = {
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const t = triple[`${platform}-${arch}`];
  return t ? { triple: t, ext: platform === 'win32' ? 'zip' : 'tar.gz' } : undefined;
}

export function assetName(t: ReleaseTarget): string {
  return `rtex-${t.triple}.${t.ext}`;
}

export function assetUrl(tag: string, t: ReleaseTarget): string {
  return `${RELEASE_DOWNLOAD}/${encodeURIComponent(tag)}/${assetName(t)}`;
}

/** `v0.0.2` → [0, 0, 2]; undefined when the tag is not a version. */
export function parseVersion(tag: string): number[] | undefined {
  const m = /^v?(\d+(?:\.\d+)*)/.exec(tag.trim());
  return m ? m[1].split('.').map(Number) : undefined;
}

/** Whether release `tag` is newer than `installed` (unknown versions are never newer). */
export function isNewer(tag: string, installed: string | undefined): boolean {
  const a = parseVersion(tag);
  if (!a) return false;
  const b = installed ? parseVersion(installed) : undefined;
  if (!b) return true;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The hex digest in a `<sha256>  <file>` (or `<sha256> *<file>`) line for `file`, or the only
 * digest of a one-line `.sha256` file. */
export function sha256For(text: string, file: string): string | undefined {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = /^([0-9a-fA-F]{64})(?:\s+\*?(.+))?$/.exec(l);
    if (m && (m[2] === undefined ? lines.length === 1 : m[2].trim() === file)) return m[1].toLowerCase();
  }
  return undefined;
}
