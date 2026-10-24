/**
 * A repository file the Guide tab may open or read: inside the head's root
 * once every symlink is followed. A change can add a symlink
 * (`notes.md -> ~/.aws/credentials`); it is never followed out of the
 * repository. No `vscode`.
 */

import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" ? false : !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * The real path of `path` (repo-relative) under `root`, or null when it is
 * not there, leaves the root (`..`, an absolute path, a symlink anywhere on
 * the way that points outside), or is not a regular file.
 */
export function realFileInside(root: string, path: string): string | null {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..") || path.includes("\0")) return null;
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(root, path));
    if (!inside(realRoot, real)) return null;
    return lstatSync(real).isFile() ? real : null;
  } catch {
    return null;
  }
}

/**
 * The bytes of a repository file when it is a regular file of its own (not a
 * symlink, even one pointing inside), for hashing what was asked about.
 */
export function readOwnFile(root: string, path: string): Buffer | null {
  const real = realFileInside(root, path);
  if (!real) return null;
  try {
    if (lstatSync(join(root, path)).isSymbolicLink()) return null;
    return readFileSync(real);
  } catch {
    return null;
  }
}
