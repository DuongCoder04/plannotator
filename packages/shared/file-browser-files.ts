/**
 * The annotate file browser's listing of one folder (`/api/reference/files`),
 * shared by the Bun server and the Pi mirror.
 *
 * The cap (`PLANNOTATOR_FILE_BROWSER_MAX_FILES`, default 5,000) counts
 * supported files only; heavy folders (node_modules, .git, dist, …) are
 * skipped before anything is counted (`isFileBrowserExcludedPath`).
 *
 * The walk is breadth-first, with each folder's entries in name order: when a
 * folder holds more files than the cap, the files near the top (READMEs,
 * docs/, a plan beside the code) are the ones listed, and the same files are
 * listed on every run. A depth-first walk filled the cap with whatever deep
 * folder the filesystem happened to return first. Under the cap the set of
 * files is the same either way.
 *
 * `seed` (the user's modified and untracked files) is added before the walk,
 * so the files someone just touched are never the ones left out.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { isFileBrowserExcludedPath } from "./reference-common";
import { getAnnotatableDocRegex, getFileBrowserMaxFiles } from "./resolve-file";

export interface FileBrowserListing {
	/** Root-relative paths with `/` separators, sorted. */
	files: string[];
	/** True when supported files were left out because the cap was reached. */
	truncated: boolean;
	/** The cap that applied. */
	limit: number;
}

export interface ListFileBrowserFilesOptions {
	seed?: Iterable<string>;
	limit?: number;
	docRegex?: RegExp;
}

function byName(a: Dirent, b: Dirent): number {
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

export async function listFileBrowserFiles(
	root: string,
	options: ListFileBrowserFilesOptions = {},
): Promise<FileBrowserListing> {
	const limit = options.limit ?? getFileBrowserMaxFiles();
	const docRegex = options.docRegex ?? getAnnotatableDocRegex();
	const files = new Set<string>();
	let truncated = false;

	const add = (relativePath: string): void => {
		if (files.has(relativePath)) return;
		if (files.size >= limit) {
			truncated = true;
			return;
		}
		files.add(relativePath);
	};

	for (const path of options.seed ?? []) {
		add(path);
		if (truncated) break;
	}

	// Folders as root-relative paths ("" is the root), visited level by level.
	const queue: string[] = [""];
	for (let next = 0; next < queue.length && !truncated; next++) {
		const relativeDir = queue[next];
		let entries: Dirent[];
		try {
			entries = (await readdir(relativeDir ? join(root, relativeDir) : root, {
				withFileTypes: true,
			})) as Dirent[];
		} catch {
			continue;
		}
		entries.sort(byName);
		for (const entry of entries) {
			const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				if (!isFileBrowserExcludedPath(relativePath)) queue.push(relativePath);
			} else if (entry.isFile() && docRegex.test(entry.name)) {
				if (isFileBrowserExcludedPath(relativePath)) continue;
				add(relativePath);
				if (truncated) break;
			}
		}
	}

	return { files: [...files].sort(), truncated, limit };
}
