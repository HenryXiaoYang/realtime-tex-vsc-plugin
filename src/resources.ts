// Loading the font and image files display lists refer to, for the webview.
// No vscode imports (driven from tests and scripts as well).
import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { fontKey, FontResource, ImageResource } from './fontKey';
import type { DisplayList, FontDesc } from './protocol';
import { MapEntry, parseEncFile, parseMapFile, type1Outlines } from './type1';

export class ResourceLoader {
  private kpseCache = new Map<string, Promise<string | undefined>>();
  private mapFile: Promise<Map<string, MapEntry>> | undefined;
  private fonts = new Map<string, Promise<FontResource>>();

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly log: (msg: string) => void = () => undefined,
  ) {}

  /** Font resources needed by `dls` that are not in `have`, keyed by fontKey. */
  async fontsFor(dls: readonly DisplayList[], have: ReadonlySet<string>): Promise<Map<string, FontResource>> {
    const want = new Map<string, FontDesc>();
    for (const dl of dls) {
      for (const desc of Object.values(dl.fonts ?? {})) {
        const k = fontKey(desc);
        if (!have.has(k) && !want.has(k)) want.set(k, desc);
      }
    }
    const out = new Map<string, FontResource>();
    await Promise.all(
      [...want].map(async ([k, desc]) => {
        out.set(k, await this.font(k, desc));
      }),
    );
    return out;
  }

  /** Image files referenced by `dls` (images_info) that are not in `have`, keyed by file name. */
  async imagesFor(dls: readonly DisplayList[], have: ReadonlySet<string>, projectRoot: string): Promise<Map<string, ImageResource>> {
    const want = new Set<string>();
    for (const dl of dls) {
      for (const info of Object.values(dl.images_info ?? {})) {
        // cached pictures live in the pass PDF, which draws their (degraded) page
        if (info.file && !info.cached_picture && !have.has(info.file)) want.add(info.file);
      }
    }
    const out = new Map<string, ImageResource>();
    await Promise.all([...want].map(async (f) => out.set(f, await this.image(f, projectRoot))));
    return out;
  }

  private font(key: string, desc: FontDesc): Promise<FontResource> {
    let p = this.fonts.get(key);
    if (!p) {
      p = this.loadFont(desc).catch((e: Error) => ({ kind: 'missing', reason: e.message }) as FontResource);
      this.fonts.set(key, p);
    }
    return p;
  }

  private async loadFont(desc: FontDesc): Promise<FontResource> {
    if (desc.filename) {
      const file = await this.locate(desc.filename);
      if (!file) return { kind: 'missing', reason: `font file not found: ${desc.filename}` };
      const lower = file.toLowerCase();
      if (lower.endsWith('.otf') || lower.endsWith('.ttf')) {
        return { kind: 'sfnt', data: new Uint8Array(await fs.readFile(file)) };
      }
      if (lower.endsWith('.pfb') || lower.endsWith('.pfa')) {
        const entry = desc.name ? (await this.map()).get(desc.name) : undefined;
        return this.loadType1(file, entry);
      }
      return { kind: 'missing', reason: `unsupported font format: ${path.basename(file)}` };
    }
    const name = desc.name ?? '';
    const entry = (await this.map()).get(name);
    if (!entry?.fontFile) return { kind: 'missing', reason: `no outline font for ${name} in pdftex.map` };
    const file = await this.locate(entry.fontFile);
    if (!file) return { kind: 'missing', reason: `font file not found: ${entry.fontFile}` };
    if (/\.(otf|ttf)$/i.test(file)) return { kind: 'missing', reason: `TFM font mapped to OpenType (${entry.fontFile})` };
    return this.loadType1(file, entry);
  }

  private async loadType1(file: string, entry: MapEntry | undefined): Promise<FontResource> {
    let encoding: string[] | undefined;
    if (entry?.encFile) {
      const encPath = await this.locate(entry.encFile);
      if (encPath) encoding = parseEncFile(await fs.readFile(encPath, 'latin1'));
    }
    const { upem, glyphs } = type1Outlines(new Uint8Array(await fs.readFile(file)), encoding);
    return { kind: 'type1', upem, glyphs, slant: entry?.slant, extend: entry?.extend };
  }

  private async image(file: string, projectRoot: string): Promise<ImageResource> {
    const candidates = path.isAbsolute(file) ? [file] : [path.join(projectRoot, file)];
    for (const c of candidates) {
      try {
        const data = new Uint8Array(await fs.readFile(c));
        const ext = path.extname(c).toLowerCase();
        if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', data };
        const mime = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : '';
        if (!mime) return { kind: 'missing', reason: `unsupported image format ${ext}` };
        return { kind: 'bitmap', mime, data };
      } catch {
        /* next */
      }
    }
    return { kind: 'missing', reason: `image not found: ${file}` };
  }

  private async map(): Promise<Map<string, MapEntry>> {
    if (!this.mapFile) {
      this.mapFile = (async () => {
        const file = await this.kpsewhich('pdftex.map');
        if (!file) {
          this.log('pdftex.map not found: Type1 (TFM) fonts will render from the PDF');
          return new Map<string, MapEntry>();
        }
        return parseMapFile(await fs.readFile(file, 'utf8'));
      })();
    }
    return this.mapFile;
  }

  private async locate(file: string): Promise<string | undefined> {
    if (path.isAbsolute(file)) {
      try {
        await fs.access(file);
        return file;
      } catch {
        return this.kpsewhich(path.basename(file));
      }
    }
    return this.kpsewhich(file);
  }

  kpsewhich(file: string): Promise<string | undefined> {
    let p = this.kpseCache.get(file);
    if (!p) {
      p = new Promise((resolve) => {
        execFile('kpsewhich', [file], { env: this.env, timeout: 10000 }, (err, stdout) => {
          const out = stdout?.trim().split('\n')[0];
          resolve(err || !out ? undefined : out);
        });
      });
      this.kpseCache.set(file, p);
    }
    return p;
  }
}
