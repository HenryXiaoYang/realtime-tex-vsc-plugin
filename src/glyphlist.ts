import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';

export type GlyphList = Map<string, string>;

export function parseGlyphList(text: string): GlyphList {
  const out: GlyphList = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const split = line.indexOf(';');
    if (split <= 0) continue;
    const name = line.slice(0, split).trim();
    const codes = line.slice(split + 1).split(',')[0].trim().split(/\s+/).filter(Boolean);
    if (!name || !codes.length) continue;
    try {
      const value = String.fromCodePoint(...codes.map((code) => parseInt(code, 16))).normalize('NFKC');
      if (!out.has(name)) out.set(name, value);
    } catch {
    }
  }
  return out;
}

const FILES = ['texglyphlist.txt', 'glyphlist.txt', 'pdfglyphlist.txt'];

function kpsewhich(file: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn('kpsewhich', [file], { env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const found = out.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(found || undefined);
    });
  });
}

export async function loadGlyphList(env: NodeJS.ProcessEnv = process.env): Promise<GlyphList> {
  const merged: GlyphList = new Map();
  for (const name of FILES) {
    const file = await kpsewhich(name, env);
    if (!file) continue;
    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (!text) continue;
    for (const [key, value] of parseGlyphList(text)) if (!merged.has(key)) merged.set(key, value);
  }
  return merged;
}
