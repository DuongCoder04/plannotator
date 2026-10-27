/**
 * Contained, capped reads of one file from a review working tree.
 *
 * Runtime-agnostic (node:fs and node:path only), so the Bun review server and
 * the Pi review server send every code-navigation file read through this one
 * guard. Pi gets a copy through `apps/pi-extension/vendor.sh`.
 *
 * Why it exists: the old defense was `validateFilePath`, a string check that
 * refuses `..` and a leading `/`. A string check cannot see a symlink, so a
 * repo holding `link -> /etc/hosts` (or `dir -> /etc`) passed it and the server
 * read the target. `/api/code-nav/file` also had no size cap, and reading a
 * FIFO blocked the server forever.
 *
 * The boundary is realpath containment: resolve the root and the candidate
 * through the filesystem, and require the real candidate to sit under the real
 * root. The file is then opened without following a final symlink and checked
 * on the open descriptor (regular file, size under the cap) before any byte is
 * read.
 */

import {
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { MAX_REVIEW_FILE_CONTENT_BYTES } from "./review-core";

/**
 * Default cap: the same 5 MB that diff context expansion uses, so a file the
 * diff can expand can also be previewed whole.
 */
export const MAX_REPO_FILE_BYTES = MAX_REVIEW_FILE_CONTENT_BYTES;

export type RepoFileFailureReason =
	| "invalid-path"
	| "outside-root"
	| "not-found"
	| "not-a-file"
	| "too-large";

export interface RepoFileSuccess {
	ok: true;
	/** The request path in repo-relative POSIX form. */
	filePath: string;
	/** Real on-disk path, after symlink resolution. */
	absolutePath: string;
	content: string;
	size: number;
}

export interface RepoFileFailure {
	ok: false;
	reason: RepoFileFailureReason;
	message: string;
	/** Present on "too-large" so the client can show the real size. */
	size?: number;
	/** Present on "too-large": the cap that was applied. */
	maxBytes?: number;
}

export type RepoFileResult = RepoFileSuccess | RepoFileFailure;

/** HTTP status for each failure. Shared so both runtimes answer alike. */
export const REPO_FILE_ERROR_STATUS: Record<RepoFileFailureReason, number> = {
	"invalid-path": 400,
	"outside-root": 403,
	"not-found": 404,
	"not-a-file": 400,
	"too-large": 413,
};

/** The JSON error body both servers send for a failed read. */
export function repoFileErrorBody(failure: RepoFileFailure): {
	error: string;
	reason: RepoFileFailureReason;
	size?: number;
	maxBytes?: number;
} {
	return {
		error: failure.message,
		reason: failure.reason,
		...(failure.size !== undefined && { size: failure.size }),
		...(failure.maxBytes !== undefined && { maxBytes: failure.maxBytes }),
	};
}

function fail(reason: RepoFileFailureReason, message: string): RepoFileFailure {
	return { ok: false, reason, message };
}

/**
 * Shape check for a client-supplied repo-relative path. A cheap pre-filter,
 * not the security boundary (containment is): it refuses hostile input before
 * the filesystem is touched, and keeps "invalid path" apart from "not found".
 */
export function validateRepoFilePath(
	rawPath: unknown,
): { ok: true; path: string } | RepoFileFailure {
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		return fail("invalid-path", "Missing path");
	}
	if (rawPath.includes("\0")) return fail("invalid-path", "Invalid path");
	const normalized = rawPath.replace(/\\/g, "/");
	if (isAbsolute(rawPath) || normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
		return fail("invalid-path", "Path must be relative to the repository");
	}
	if (normalized.split("/").some((segment) => segment === "..")) {
		return fail("invalid-path", "Invalid path");
	}
	// Split the returned path on "/" only: on POSIX a backslash is a legal
	// filename character, so `a\b.txt` must stay one name.
	const cleaned = rawPath.split("/").filter((segment) => segment.length > 0 && segment !== ".");
	if (cleaned.length === 0) return fail("invalid-path", "Invalid path");
	return { ok: true, path: cleaned.join("/") };
}

/**
 * True when `candidate` is `root` or lies under it. Both must already be real
 * paths. The trailing separator stops `/repo-evil` matching root `/repo`.
 */
export function isContainedPath(candidate: string, root: string): boolean {
	if (candidate === root) return true;
	const rootWithSep = root.endsWith(sep) ? root : `${root}${sep}`;
	return candidate.startsWith(rootWithSep);
}

function realpathOrNull(target: string): string | null {
	try {
		return realpathSync(target);
	} catch {
		return null;
	}
}

/**
 * Resolve a repo-relative path to a real, contained absolute path without
 * reading it.
 */
export function resolveRepoFilePath(
	root: string,
	rawPath: unknown,
): { ok: true; filePath: string; absolutePath: string } | RepoFileFailure {
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;

	const realRoot = realpathOrNull(root);
	if (realRoot === null) return fail("not-found", "Repository root is unavailable");

	const realCandidate = realpathOrNull(resolve(realRoot, validated.path));
	// Missing file and dangling symlink both read as not-found, so the answer
	// never confirms what exists outside the repo.
	if (realCandidate === null) return fail("not-found", "File not found");

	if (!isContainedPath(realCandidate, realRoot)) {
		return fail("outside-root", "Path is outside the repository");
	}
	return { ok: true, filePath: validated.path, absolutePath: realCandidate };
}

// O_NONBLOCK keeps open() from waiting on a FIFO with no writer; O_NOFOLLOW
// refuses a final component swapped for a symlink after realpath ran. Both are
// 0 where the platform does not define them (Windows).
const OPEN_FLAGS =
	fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Read one file from a review working tree: contained by realpath, regular
 * files only, and refused when larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}). The checks run on the open descriptor before
 * any read, so an oversized file never lands in memory.
 */
export function readRepoFile(
	root: string,
	rawPath: unknown,
	options: { maxBytes?: number } = {},
): RepoFileResult {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const resolved = resolveRepoFilePath(root, rawPath);
	if (!resolved.ok) return resolved;

	let fd: number;
	try {
		fd = openSync(resolved.absolutePath, OPEN_FLAGS);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ELOOP: the final component became a symlink after realpath.
		if (code === "ELOOP") return fail("outside-root", "Path is outside the repository");
		if (code === "EISDIR") return fail("not-a-file", "Path is not a regular file");
		return fail("not-found", "File not found");
	}
	try {
		const stats = fstatSync(fd);
		// Directories, FIFOs, sockets and devices are all refused.
		if (!stats.isFile()) return fail("not-a-file", "Path is not a regular file");
		if (stats.size > maxBytes) {
			return {
				ok: false,
				reason: "too-large",
				message: `File is too large to open (${stats.size} bytes; the limit is ${maxBytes} bytes)`,
				size: stats.size,
				maxBytes,
			};
		}
		// Read one byte past the stat size: a file that grew past the cap after
		// fstat is caught without reading all of it.
		const buffer = Buffer.alloc(Math.min(stats.size, maxBytes) + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > maxBytes) {
			return {
				ok: false,
				reason: "too-large",
				message: `File is too large to open (over ${maxBytes} bytes)`,
				size: length,
				maxBytes,
			};
		}
		return {
			ok: true,
			filePath: resolved.filePath,
			absolutePath: resolved.absolutePath,
			content: buffer.toString("utf8", 0, length),
			size: length,
		};
	} catch {
		return fail("not-found", "File could not be read");
	} finally {
		closeSync(fd);
	}
}

export type RepoWorkingTreeEntry =
	| { ok: true; kind: "symlink"; filePath: string; linkTarget: string }
	| { ok: true; kind: "file"; filePath: string; absolutePath: string; size: number };

/**
 * Check one working-tree path for diff context expansion, with git's view of
 * a symlink: a link's content is its target string, read without following
 * it. Every directory on the way must resolve inside the root, so a path
 * through a symlinked directory that points out is refused. Otherwise the
 * entry must be a regular file no larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}); FIFOs and devices are refused.
 *
 * Returns the checked absolute path rather than the content, so each caller
 * keeps reading through its own runtime (Bun and Node decode a BOM
 * differently, and diff expansion output must not change).
 */
export function resolveRepoWorkingTreeEntry(
	root: string,
	rawPath: unknown,
	options: { maxBytes?: number } = {},
): RepoWorkingTreeEntry | RepoFileFailure {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;

	const realRoot = realpathOrNull(root);
	if (realRoot === null) return fail("not-found", "Repository root is unavailable");

	const candidate = resolve(realRoot, validated.path);
	const realParent = realpathOrNull(dirname(candidate));
	if (realParent === null) return fail("not-found", "File not found");
	if (!isContainedPath(realParent, realRoot)) {
		return fail("outside-root", "Path is outside the repository");
	}

	// The parent is real and inside the root, so the leaf is too unless it is
	// itself a symlink, which is read as its target string, never followed.
	const leaf = join(realParent, basename(candidate));
	let stats: ReturnType<typeof lstatSync>;
	try {
		stats = lstatSync(leaf);
	} catch {
		return fail("not-found", "File not found");
	}
	if (stats.isSymbolicLink()) {
		try {
			return { ok: true, kind: "symlink", filePath: validated.path, linkTarget: readlinkSync(leaf) };
		} catch {
			return fail("not-found", "File could not be read");
		}
	}
	if (!stats.isFile()) return fail("not-a-file", "Path is not a regular file");
	if (stats.size > maxBytes) {
		return {
			ok: false,
			reason: "too-large",
			message: `File is too large to open (${stats.size} bytes; the limit is ${maxBytes} bytes)`,
			size: stats.size,
			maxBytes,
		};
	}
	return { ok: true, kind: "file", filePath: validated.path, absolutePath: leaf, size: stats.size };
}
