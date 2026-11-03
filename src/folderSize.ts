// Size of the folder rtex copies into its build directory.
import { promises as fs } from 'fs';
import * as path from 'path';

/** Whether the files rtex's snapshot copies from `dir` add up to more than `limit` bytes. Walks
 * the folder as the engine does (background.rs `copy_tree`: no dot entries, `build`, `target`
 * or `skip`, at most 8 levels down) and stops as soon as the limit is passed. */
export async function folderExceeds(dir: string, limit: number, skip?: string): Promise<boolean> {
  let total = 0;
  const walk = async (d: string, depth: number): Promise<boolean> => {
    if (depth > 8) return false;
    const entries = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'build' || e.name === 'target') continue;
      const p = path.join(d, e.name);
      if (skip && p === skip) continue;
      if (e.isDirectory()) {
        if (await walk(p, depth + 1)) return true;
      } else if (e.isFile()) {
        total += (await fs.stat(p).catch(() => ({ size: 0 }))).size;
        if (total > limit) return true;
      }
    }
    return false;
  };
  return walk(dir, 0);
}
