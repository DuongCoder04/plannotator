/**
 * Contained, capped reads of one file from a review working tree.
 *
 * Runtime-agnostic (node:fs and node:path only), so the Bun review server and
 * the Pi review server send every code-navigation file read and every
 * working-tree read for diff expansion through this one guard. Pi gets a copy
 * through `apps/pi-extension/vendor.sh`.
 *
 * Why it exists: the old defense was `validateFilePath`, a string check that
 * refuses `..` and a leading `/`. A string check cannot see a symlink, so a
 * repo holding `link -> /etc/hosts` (or `dir -> /etc`) passed it and the server
 * read the target. `/api/code-nav/file` also had no size cap, and reading a
 * FIFO blocked the server forever.
 *
 * The boundary is realpath containment: resolve the root and the candidate
 * through the filesystem, and require the real candidate to sit under the real
 * root. The file is then opened without following a final symlink and without
 * waiting on a FIFO, and checked on the open descriptor (regular file, size
 * under the cap) before any byte is read. Every byte comes from that
 * descriptor; nothing reopens the path.
 *
 * Swaps between the check and the open: `O_NOFOLLOW` covers only the final
 * component, so a directory on the way swapped for a symlink after realpath
 * ran would make open() land outside the root. After the open the path is
 * resolved again, must still be contained, and must name the same inode
 * (dev + ino) as the descriptor; otherwise the read is refused. Node has no
 * openat() or descriptor-to-path call, so this is a recheck by path, not an
 * atomic walk: a writer who flips a directory back and forth at exactly the
 * three right moments (open, realpath, stat) could still win in theory.
 * Without it the escape was easy to hit (several per 50k reads); with it the
 * same race script hits none.
 *
 * Hard links: a hard link inside the repo to a file outside it is the same
 * inode at a contained path, so it cannot be told apart and is read. Git never
 * creates hard links, so a cloned repo cannot carry one; making one needs
 * local write access to both places, which is the same as copying the file.
 */

import {
	type BigIntStats,
	closeSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	readlinkSync,
	readSync,
	realpathSync,
	statSync,
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

/**
 * Turns the bytes read from the descriptor into text. Each runtime supplies
 * its own so its output does not change: Node's `readFileSync(path, "utf8")`
 * keeps a leading BOM ({@link decodeUtf8}, the default), while Bun's
 * `Bun.file().text()` strips it and also sniffs a UTF-16 BOM (the Bun server
 * passes its own decoder).
 */
export type RepoFileDecoder = (bytes: Uint8Array) => string | Promise<string>;

/** Node's `readFileSync(path, "utf8")`: bad bytes become U+FFFD, a BOM stays. */
export const decodeUtf8: RepoFileDecoder = (bytes) =>
	Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8");

/**
 * Test seam, never set in production: `beforeOpen` runs after the path check
 * and before the open, `afterOpen` after the open and before the identity
 * recheck. Tests swap a directory there to prove the recheck refuses it.
 */
export interface RepoFileReadHooks {
	beforeOpen?: () => void;
	afterOpen?: () => void;
}

export interface RepoFileReadOptions {
	/** Cap in bytes; default {@link MAX_REPO_FILE_BYTES}. */
	maxBytes?: number;
	/** Default {@link decodeUtf8}. */
	decode?: RepoFileDecoder;
	hooks?: RepoFileReadHooks;
}

/**
 * What a caller may pass to a runtime's `readWorkingTreeEntry`: the decoder
 * is the runtime's own, never the caller's.
 */
export type RepoWorkingTreeReadOptions = Omit<RepoFileReadOptions, "decode">;

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

const OUTSIDE_ROOT = (): RepoFileFailure => fail("outside-root", "Path is outside the repository");

function tooLarge(size: number, maxBytes: number): RepoFileFailure {
	return {
		ok: false,
		reason: "too-large",
		message: `File is too large to open (${size} bytes; the limit is ${maxBytes} bytes)`,
		size,
		maxBytes,
	};
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

function sameInode(a: BigIntStats, b: BigIntStats): boolean {
	return a.dev === b.dev && a.ino === b.ino;
}

/** Real candidate under an already-real root, or why it is refused. */
function containedRealPath(
	realRoot: string,
	relativePath: string,
): { ok: true; path: string } | RepoFileFailure {
	const realCandidate = realpathOrNull(resolve(realRoot, relativePath));
	// Missing file and dangling symlink both read as not-found, so the answer
	// never confirms what exists outside the repo.
	if (realCandidate === null) return fail("not-found", "File not found");
	if (!isContainedPath(realCandidate, realRoot)) return OUTSIDE_ROOT();
	return { ok: true, path: realCandidate };
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

	const contained = containedRealPath(realRoot, validated.path);
	if (!contained.ok) return contained;
	return { ok: true, filePath: validated.path, absolutePath: contained.path };
}

// O_NONBLOCK keeps open() from waiting on a FIFO with no writer; O_NOFOLLOW
// refuses a final component swapped for a symlink after the check. Both are
// 0 where the platform does not define them (Windows).
const OPEN_FLAGS =
	fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0) | (fsConstants.O_NOFOLLOW ?? 0);

function openForRead(path: string): { ok: true; fd: number } | RepoFileFailure {
	try {
		return { ok: true, fd: openSync(path, OPEN_FLAGS) };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// ELOOP: the final component became a symlink after the check.
		if (code === "ELOOP") return OUTSIDE_ROOT();
		if (code === "EISDIR") return fail("not-a-file", "Path is not a regular file");
		return fail("not-found", "File not found");
	}
}

/**
 * Read a checked regular file from its descriptor, refusing it when larger
 * than `maxBytes`. Reads one byte past the cap: a file that grew after fstat
 * is caught without reading all of it.
 */
function readCappedFromFd(fd: number, stats: BigIntStats, maxBytes: number): { ok: true; bytes: Buffer } | RepoFileFailure {
	// Directories, FIFOs, sockets and devices are all refused.
	if (!stats.isFile()) return fail("not-a-file", "Path is not a regular file");
	const size = Number(stats.size);
	if (size > maxBytes) return tooLarge(size, maxBytes);
	const buffer = Buffer.alloc(Math.min(size, maxBytes) + 1);
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
	return { ok: true, bytes: buffer.subarray(0, length) };
}

/**
 * Open `path`, check the descriptor, and read it. `recheck` runs after the
 * open with the descriptor's stats and must confirm the path still names the
 * same contained inode.
 */
function readCheckedPath(
	path: string,
	maxBytes: number,
	hooks: RepoFileReadHooks | undefined,
	recheck: (opened: BigIntStats) => RepoFileFailure | null,
): { ok: true; bytes: Buffer } | RepoFileFailure {
	hooks?.beforeOpen?.();
	const opened = openForRead(path);
	if (!opened.ok) return opened;
	try {
		const stats = fstatSync(opened.fd, { bigint: true });
		hooks?.afterOpen?.();
		const refused = recheck(stats);
		if (refused) return refused;
		return readCappedFromFd(opened.fd, stats, maxBytes);
	} catch {
		return fail("not-found", "File could not be read");
	} finally {
		closeSync(opened.fd);
	}
}

/**
 * Read one file from a review working tree: contained by realpath, regular
 * files only, and refused when larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}). The checks run on the open descriptor before
 * any read, so an oversized file never lands in memory.
 */
export async function readRepoFile(
	root: string,
	rawPath: unknown,
	options: RepoFileReadOptions = {},
): Promise<RepoFileResult> {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;
	const realRoot = realpathOrNull(root);
	if (realRoot === null) return fail("not-found", "Repository root is unavailable");
	const contained = containedRealPath(realRoot, validated.path);
	if (!contained.ok) return contained;

	const read = readCheckedPath(contained.path, maxBytes, options.hooks, (opened) => {
		// The path must still resolve inside the root, to the inode we hold.
		const again = containedRealPath(realRoot, validated.path);
		if (!again.ok) return again.reason === "not-found" ? again : OUTSIDE_ROOT();
		return sameInode(statSync(again.path, { bigint: true }), opened) ? null : OUTSIDE_ROOT();
	});
	if (!read.ok) return read;
	return {
		ok: true,
		filePath: validated.path,
		absolutePath: contained.path,
		content: await (options.decode ?? decodeUtf8)(read.bytes),
		size: read.bytes.length,
	};
}

export type RepoWorkingTreeEntry =
	| { ok: true; kind: "symlink"; filePath: string; linkTarget: string }
	| { ok: true; kind: "file"; filePath: string; absolutePath: string; content: string; size: number };

/**
 * The working-tree path of an entry, without following a final symlink:
 * every directory on the way resolved by realpath and required inside the
 * root, the last name joined on unresolved.
 */
function containedLeaf(realRoot: string, relativePath: string): { ok: true; path: string } | RepoFileFailure {
	const candidate = resolve(realRoot, relativePath);
	const realParent = realpathOrNull(dirname(candidate));
	if (realParent === null) return fail("not-found", "File not found");
	if (!isContainedPath(realParent, realRoot)) return OUTSIDE_ROOT();
	return { ok: true, path: join(realParent, basename(candidate)) };
}

/** After a read: the leaf must still be contained and be the same inode. */
function leafStillSame(realRoot: string, relativePath: string, expected: BigIntStats): RepoFileFailure | null {
	const again = containedLeaf(realRoot, relativePath);
	if (!again.ok) return again.reason === "not-found" ? again : OUTSIDE_ROOT();
	return sameInode(lstatSync(again.path, { bigint: true }), expected) ? null : OUTSIDE_ROOT();
}

/**
 * Read one working-tree entry for diff context expansion, with git's view of
 * a symlink: a link's content is its target string, read without following
 * it. Every directory on the way must resolve inside the root, so a path
 * through a symlinked directory that points out is refused. Otherwise the
 * entry must be a regular file no larger than `maxBytes` (default
 * {@link MAX_REPO_FILE_BYTES}); FIFOs and devices are refused.
 *
 * The bytes come from the checked descriptor, never from reopening the path,
 * so a FIFO or a bigger file swapped in after the check cannot block the
 * server or slip past the cap. `decode` keeps each runtime's text output as
 * it was (Bun and Node decode a BOM differently).
 */
export async function readRepoWorkingTreeEntry(
	root: string,
	rawPath: unknown,
	options: RepoFileReadOptions = {},
): Promise<RepoWorkingTreeEntry | RepoFileFailure> {
	const maxBytes = options.maxBytes ?? MAX_REPO_FILE_BYTES;
	const validated = validateRepoFilePath(rawPath);
	if (!validated.ok) return validated;
	const realRoot = realpathOrNull(root);
	if (realRoot === null) return fail("not-found", "Repository root is unavailable");
	const leaf = containedLeaf(realRoot, validated.path);
	if (!leaf.ok) return leaf;

	let before: BigIntStats;
	try {
		before = lstatSync(leaf.path, { bigint: true });
	} catch {
		return fail("not-found", "File not found");
	}

	if (before.isSymbolicLink()) {
		try {
			options.hooks?.beforeOpen?.();
			const linkTarget = readlinkSync(leaf.path);
			options.hooks?.afterOpen?.();
			// A link has no descriptor to compare, so the recheck reads it a
			// second time through the rechecked path and needs the same answer.
			const refused = leafStillSame(realRoot, validated.path, before);
			if (refused) return refused;
			const again = containedLeaf(realRoot, validated.path);
			if (!again.ok || readlinkSync(again.path) !== linkTarget) return OUTSIDE_ROOT();
			return { ok: true, kind: "symlink", filePath: validated.path, linkTarget };
		} catch {
			return fail("not-found", "File could not be read");
		}
	}
	// Refuse what is plainly not a small regular file before opening it.
	if (!before.isFile()) return fail("not-a-file", "Path is not a regular file");
	if (Number(before.size) > maxBytes) return tooLarge(Number(before.size), maxBytes);

	const read = readCheckedPath(leaf.path, maxBytes, options.hooks, (opened) =>
		leafStillSame(realRoot, validated.path, opened),
	);
	if (!read.ok) return read;
	return {
		ok: true,
		kind: "file",
		filePath: validated.path,
		absolutePath: leaf.path,
		content: await (options.decode ?? decodeUtf8)(read.bytes),
		size: read.bytes.length,
	};
}
