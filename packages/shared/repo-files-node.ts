/**
 * The All files reader for working-tree files (`GET /api/repo-file`), server
 * only. Kept out of repo-files.ts, which the review page also imports, because
 * the guard below needs node:fs.
 *
 * Every working-tree file the explorer opens is read through `readRepoFile`
 * (repo-file.ts), the same guard code navigation uses: the real path must stay
 * inside the repository, before and after the open (a tracked
 * `link -> /etc/hosts` or a folder symlinked out is refused), only regular
 * files are read (a FIFO never blocks the server), and a file over the cap is
 * refused before any byte is read. Vendored to Pi, so both runtimes share it.
 */

import { readRepoFile } from "./repo-file";
import { decodeRepoFileBytes, type RepoFileRead } from "./repo-files";

/**
 * Read one working-tree file. `root` is the repository (or a workspace
 * child's) root and `path` is relative to it. The bytes are decoded the way a
 * file read from git is (`decodeRepoFileBytes`: a NUL or invalid UTF-8 is a
 * binary file), so the answer does not depend on where the file came from.
 */
export async function readRepoWorkingTreeFile(root: string, path: string, maxBytes: number): Promise<RepoFileRead> {
  let bytes: Uint8Array | null = null;
  const result = await readRepoFile(root, path, {
    maxBytes,
    decode: (read) => {
      bytes = read;
      return "";
    },
  });
  if (!result.ok) {
    switch (result.reason) {
      case "too-large":
        return { kind: "too-large", size: result.size ?? maxBytes + 1 };
      case "not-found":
        return { kind: "missing" };
      // Outside the repository, not a regular file, or a path the guard
      // refuses: nothing to show, and nothing said about what is out there.
      default:
        return { kind: "unavailable" };
    }
  }
  if (!bytes) return { kind: "unavailable" };
  const decoded = decodeRepoFileBytes(bytes);
  return "content" in decoded ? { kind: "text", content: decoded.content } : { kind: "binary" };
}
