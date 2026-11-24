import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import type { DisplayList } from '../src/protocol';
import { ResourceLoader } from '../src/resources';

function withImage(file: string): DisplayList {
  return { kind: 'paragraph', fonts: {}, lines: [], other: [], flags: [], width: 0, height: 0, depth: 0, images_info: { '1': { file } } };
}

async function put(file: string, text: string, mtime: number): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await utimes(file, mtime, mtime);
}

test('a relative image is looked up in the project, then in the newest output directory', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'rtex-images-'));
  try {
    const project = path.join(root, 'project');
    const serve = path.join(root, 'build', 'serve');
    const pass0 = path.join(root, 'build', 'bg', 'pass-0');
    const pass1 = path.join(root, 'build', 'bg', 'pass-1');
    // like ltmermaid's PDFs: written to the engines' output directories, not the project
    await put(path.join(serve, 'mermaid', 'rtex-serve-g1-mermaid-1.pdf'), '%PDF live', 100);
    await put(path.join(pass0, 'mermaid', 'main-mermaid-1.pdf'), '%PDF old pass', 100);
    await put(path.join(pass1, 'mermaid', 'main-mermaid-1.pdf'), '%PDF new pass', 200);
    await put(path.join(project, 'figure.png'), 'project png', 100);
    await put(path.join(pass1, 'figure.png'), 'output png', 300);
    const loader = new ResourceLoader(process.env);
    const dirs = { project, outputs: [serve, pass0, pass1] };
    const got = await loader.imagesFor(
      [withImage('mermaid/rtex-serve-g1-mermaid-1.pdf'), withImage('mermaid/main-mermaid-1.pdf'), withImage('figure.png'), withImage('gone.png')],
      new Set(),
      dirs,
    );
    const text = (f: string) => {
      const r = got.get(f);
      return r && r.kind !== 'missing' ? new TextDecoder().decode(r.data) : r?.kind;
    };
    assert.equal(text('mermaid/rtex-serve-g1-mermaid-1.pdf'), '%PDF live');
    assert.equal(text('mermaid/main-mermaid-1.pdf'), '%PDF new pass');
    assert.equal(text('figure.png'), 'project png', 'the project wins');
    assert.equal(text('gone.png'), 'missing');
    // only the project: the engines' output is not found
    const projectOnly = await loader.imagesFor([withImage('mermaid/main-mermaid-1.pdf')], new Set(), { project, outputs: [] });
    assert.equal(projectOnly.get('mermaid/main-mermaid-1.pdf')?.kind, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
