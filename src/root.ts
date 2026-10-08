// Finding the main file of a LaTeX project. Pure module (file access is injected).
import * as path from 'path';

const MAGIC_ROOT = /^[ \t]*%[ \t]*!\s*TE?X\s+root\s*=\s*(.+?)\s*$/im;
const DOCUMENTCLASS = /^[^%\n]*\\documentclass\b/m;

/** The `% !TEX root = …` target in the first lines of `text`, if any. */
export function magicRoot(text: string): string | undefined {
  const head = text.split('\n', 30).join('\n');
  const m = MAGIC_ROOT.exec(head);
  return m ? m[1] : undefined;
}

/** Whether `text` has an uncommented `\documentclass`. */
export function isMainFile(text: string): boolean {
  return DOCUMENTCLASS.test(text);
}

/** Whether `mainText` includes `file` (\input, \include, \subfile, \import) given its path
 * relative to the main file's directory. */
export function includes(mainText: string, relPath: string): boolean {
  const noExt = relPath.replace(/\.tex$/i, '').split(path.sep).join('/');
  const re = /\\(?:input|include|subfile|subimport\*?\{[^}]*\}|import\*?\{[^}]*\})\s*\{([^}]+)\}/g;
  for (const line of mainText.split('\n')) {
    const code = stripComment(line);
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(code))) {
      const target = m[1].trim().replace(/\.tex$/i, '').replace(/^\.\//, '');
      if (target === noExt || noExt.endsWith('/' + target)) return true;
    }
  }
  return false;
}

function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) return line.slice(0, i);
  }
  return line;
}

export interface RootQuery {
  /** Absolute path of the file the user is editing. */
  activeFile: string;
  /** Absolute path from the `realtimeTex.mainFile` setting, if set. */
  configured?: string;
  /** Absolute paths of the `.tex` files in the workspace (for the fallback search). */
  candidates: string[];
  readFile(file: string): Promise<string | undefined>;
}

/** Resolve the main file: setting, then `% !TEX root` (followed up to 5 times), then the active
 * file if it has `\documentclass`, then a workspace file with `\documentclass` that includes the
 * active file, then the only workspace file with `\documentclass`. Undefined when ambiguous. */
export async function findMainFile(q: RootQuery): Promise<string | undefined> {
  if (q.configured) return q.configured;
  let file = q.activeFile;
  for (let hop = 0; hop < 5; hop++) {
    const text = await q.readFile(file);
    if (text === undefined) break;
    const root = magicRoot(text);
    if (root) {
      const next = path.resolve(path.dirname(file), root.endsWith('.tex') ? root : root + '.tex');
      if (next === file) break;
      file = next;
      continue;
    }
    if (isMainFile(text)) return file;
    break;
  }
  const mains: { file: string; text: string }[] = [];
  for (const c of q.candidates) {
    const text = await q.readFile(c);
    if (text !== undefined && isMainFile(text)) mains.push({ file: c, text });
  }
  const including = mains.filter((m) => includes(m.text, path.relative(path.dirname(m.file), q.activeFile)));
  if (including.length === 1) return including[0].file;
  if (including.length > 1) {
    // the nearest one up the directory tree
    including.sort((a, b) => b.file.length - a.file.length);
    return including[0].file;
  }
  if (mains.length === 1) return mains[0].file;
  return undefined;
}
