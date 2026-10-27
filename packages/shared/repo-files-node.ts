/**
 * The All files reader for working-tree files (`GET /api/repo-file`), server
 * only. Kept out of repo-files.ts, which the review page also imports, because
 * the guard below needs node:fs.
 *
 * Every working-tree file the explorer opens is read through `readRepoFile`
 * (repo-file.ts), the same guard code navigation uses: the real path must stay
 * inside the repository (a tracked `link -> /etc/hosts` or a folder symlinked
 * out is refused), only regular files are read (a FIFO never blocks the
 * server), and a file over the cap is refused before any byte is read.
 * Vendored to Pi, so both runtimes share it.
 */

import { readRepoFile } from "./repo-file";
import type { RepoFileRead } from "./repo-files";

/** Bytes looked at for a NUL, as `decodeRepoFileBytes` does. */
const BINARY_SNIFF_CHARS = 8192;

/**
 * Read one working-tree file. `root` is the repository (or a workspace
 * child's) root and `path` is relative to it.
 */
export function readRepoWorkingTreeFile(root: string, path: string, maxBytes: number): RepoFileRead {
  const result = readRepoFile(root, path, { maxBytes });
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
  // `readRepoFile` decodes UTF-8 leniently, so a binary file shows up as a
  // NUL near the start or as replacement characters for invalid sequences.
  const content = result.content;
  if (content.slice(0, BINARY_SNIFF_CHARS).includes("\0") || content.includes("�")) {
    return { kind: "binary" };
  }
  return { kind: "text", content };
}
