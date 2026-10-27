/**
 * readRepoFile and readRepoWorkingTreeEntry: the one guard both review
 * servers use to read a working-tree file for code navigation and for diff
 * expansion. Each test is a way the server could hand out a file it must not,
 * or hang or bloat on one it cannot afford. The old string check
 * (`validateFilePath`) let both symlink cases through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	MAX_REPO_FILE_BYTES,
	isContainedPath,
	readRepoFile,
	readRepoWorkingTreeEntry,
	validateRepoFilePath,
} from "./repo-file";

const posixOnly = process.platform === "win32" ? test.skip : test;
const describePosix = process.platform === "win32" ? describe.skip : describe;
const REPO_FILE_MODULE = join(import.meta.dir, "repo-file.ts");
/** A blocked child is killed here; the test's own timeout sits above it. */
const CHILD_TIMEOUT_MS = 10_000;
const CHILD_TEST_TIMEOUT_MS = 20_000;

/**
 * Run `body` in a child Bun process and return the JSON it prints last. A
 * read that blocks (a FIFO opened without O_NONBLOCK) would block this whole
 * test process; in a child it is killed at the timeout and the test fails.
 */
function runInChild(body: string): unknown {
	const source = `const m = await import(${JSON.stringify(REPO_FILE_MODULE)});\n${body}`;
	const child = spawnSync(process.execPath, ["--eval", source], { encoding: "utf-8", timeout: CHILD_TIMEOUT_MS });
	if (child.signal || child.error) throw new Error(`child read did not finish (blocked?): ${child.signal ?? child.error}`);
	if (child.status !== 0) throw new Error(`child failed: ${child.stderr}`);
	return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "null");
}

let base = "";
let root = "";
let outside = "";

beforeAll(() => {
	// realpath the temp dir: on macOS /tmp is itself a symlink to /private/tmp.
	base = realpathSync(mkdtempSync(join(tmpdir(), "pn-repo-file-")));
	root = join(base, "repo");
	outside = join(base, "outside");
	mkdirSync(join(root, "src"), { recursive: true });
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(root, "src", "alpha.ts"), "export const a = 1;\n");
	writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
	if (process.platform !== "win32") {
		symlinkSync("/etc/hosts", join(root, "hosts"));
		symlinkSync(outside, join(root, "escape-dir"));
		symlinkSync(join(root, "src", "alpha.ts"), join(root, "inside-link.ts"));
		symlinkSync(join(outside, "nope.txt"), join(root, "dangling.txt"));
	}
});

afterAll(() => {
	if (base) rmSync(base, { recursive: true, force: true });
});

describe("readRepoFile containment", () => {
	test("reads a file inside the root", async () => {
		const result = await readRepoFile(root, "src/alpha.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("export const a = 1;\n");
	});

	posixOnly("refuses a symlink to /etc/hosts", async () => {
		expect(existsSync("/etc/hosts")).toBe(true);
		const result = await readRepoFile(root, "hosts");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	posixOnly("refuses a path through a symlinked directory that leaves the root", async () => {
		const result = await readRepoFile(root, "escape-dir/secret.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	posixOnly("still reads a symlink that stays inside the root", async () => {
		const result = await readRepoFile(root, "inside-link.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("export const a = 1;\n");
	});

	posixOnly("reports a dangling symlink as not-found, not as an escape", async () => {
		const result = await readRepoFile(root, "dangling.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-found");
	});

	test("refuses .. traversal and absolute paths before touching the filesystem", async () => {
		for (const candidate of [
			"../outside/secret.txt",
			"src/../../outside/secret.txt",
			"..\\outside\\secret.txt",
			join(outside, "secret.txt"),
			"/etc/hosts",
			"C:/Windows/win.ini",
		]) {
			const result = await readRepoFile(root, candidate);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("invalid-path");
		}
	});

	test("accepts a filename that merely contains two dots", async () => {
		// The old substring check refused this legitimate name.
		expect(validateRepoFilePath("src/foo..bar.ts")).toEqual({ ok: true, path: "src/foo..bar.ts" });
	});

	posixOnly("keeps a backslash inside a POSIX filename", async () => {
		// Diff expansion must still find a file literally named `a\b.txt`.
		expect(validateRepoFilePath("src/a\\b.txt")).toEqual({ ok: true, path: "src/a\\b.txt" });
	});

	test("a sibling directory sharing the root's name prefix is not inside it", async () => {
		expect(isContainedPath("/repo-evil/x", "/repo")).toBe(false);
		expect(isContainedPath("/repo/x", "/repo")).toBe(true);
	});
});

describe("readRepoFile non-regular files", () => {
	test("refuses a directory", async () => {
		const result = await readRepoFile(root, "src");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-a-file");
	});

	posixOnly("refuses a FIFO without blocking on it", async () => {
		const fifo = join(root, "pipe");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		try {
			// Without O_NONBLOCK and the regular-file check this open never
			// returns, because no writer ever arrives; the child is killed.
			const result = runInChild(
				`console.log(JSON.stringify(await m.readRepoFile(${JSON.stringify(root)}, "pipe")));`,
			);
			expect(result).toMatchObject({ ok: false, reason: "not-a-file" });
		} finally {
			rmSync(fifo, { force: true });
		}
	}, CHILD_TEST_TIMEOUT_MS);

	posixOnly("refuses a device when the root itself contains it", async () => {
		// Root /dev: containment passes, so only the regular-file check stands
		// between the request and an endless read of /dev/zero.
		const result = await readRepoFile("/dev", "zero");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-a-file");
	});
});

describe("readRepoFile size cap", () => {
	test("refuses a file one byte over the cap and reports its size", async () => {
		const big = join(root, "big.txt");
		writeFileSync(big, Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
		try {
			const result = await readRepoFile(root, "big.txt");
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.reason).toBe("too-large");
				expect(result.size).toBe(MAX_REPO_FILE_BYTES + 1);
				expect(result.maxBytes).toBe(MAX_REPO_FILE_BYTES);
			}
		} finally {
			rmSync(big, { force: true });
		}
	});

	test("reads a file exactly at the cap", async () => {
		const atCap = join(root, "atcap.txt");
		writeFileSync(atCap, Buffer.alloc(MAX_REPO_FILE_BYTES, 0x62));
		try {
			const result = await readRepoFile(root, "atcap.txt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.content.length).toBe(MAX_REPO_FILE_BYTES);
		} finally {
			rmSync(atCap, { force: true });
		}
	});

	test("honors a smaller per-caller cap (hover reads stop at 1 MB)", async () => {
		const result = await readRepoFile(root, "src/alpha.ts", { maxBytes: 4 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("too-large");
	});
});

describe("readRepoWorkingTreeEntry (diff context expansion)", () => {
	test("reads a regular file inside the root", async () => {
		const entry = await readRepoWorkingTreeEntry(root, "src/alpha.ts");
		expect(entry).toMatchObject({
			ok: true,
			kind: "file",
			absolutePath: join(root, "src", "alpha.ts"),
			content: "export const a = 1;\n",
		});
	});

	posixOnly("refuses a path through a symlinked directory that leaves the root", async () => {
		const entry = await readRepoWorkingTreeEntry(root, "escape-dir/secret.txt");
		expect(entry.ok).toBe(false);
		if (!entry.ok) expect(entry.reason).toBe("outside-root");
	});

	posixOnly("reads a final symlink as its target string, the way git stores it", async () => {
		// Never followed, so the target's content is not read even when it is
		// outside the root.
		expect(await readRepoWorkingTreeEntry(root, "hosts")).toEqual({
			ok: true,
			kind: "symlink",
			filePath: "hosts",
			linkTarget: "/etc/hosts",
		});
	});

	posixOnly("refuses a FIFO", async () => {
		const fifo = join(root, "pipe-entry");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		try {
			const entry = await readRepoWorkingTreeEntry(root, "pipe-entry");
			expect(entry.ok).toBe(false);
			if (!entry.ok) expect(entry.reason).toBe("not-a-file");
		} finally {
			rmSync(fifo, { force: true });
		}
	});

	posixOnly("refuses a FIFO swapped in after the check, without blocking", () => {
		// The lstat sees a regular file; the hook then replaces it with a FIFO.
		// Reopening the path with readFileSync (the old reader) would wait for
		// a writer forever; the child is killed and the test fails.
		const swapped = join(root, "becomes-fifo.txt");
		writeFileSync(swapped, "regular\n");
		try {
			const result = runInChild(`
				const { rmSync } = await import("node:fs");
				const { spawnSync } = await import("node:child_process");
				const path = ${JSON.stringify(swapped)};
				let swaps = 0;
				const entry = await m.readRepoWorkingTreeEntry(${JSON.stringify(root)}, "becomes-fifo.txt", {
					hooks: { beforeOpen() { rmSync(path); spawnSync("mkfifo", [path]); swaps++; } },
				});
				console.log(JSON.stringify({ swaps, entry }));
			`);
			expect(result).toMatchObject({ swaps: 1, entry: { ok: false, reason: "not-a-file" } });
		} finally {
			rmSync(swapped, { force: true });
		}
	}, CHILD_TEST_TIMEOUT_MS);

	test("refuses a file over the cap", async () => {
		const entry = await readRepoWorkingTreeEntry(root, "src/alpha.ts", { maxBytes: 4 });
		expect(entry.ok).toBe(false);
		if (!entry.ok) expect(entry.reason).toBe("too-large");
	});

	test("refuses a file that grew past the cap after the check", async () => {
		const growing = join(root, "grows.txt");
		writeFileSync(growing, "abc");
		try {
			const entry = await readRepoWorkingTreeEntry(root, "grows.txt", {
				maxBytes: 8,
				hooks: { beforeOpen: () => writeFileSync(growing, "x".repeat(64)) },
			});
			expect(entry).toMatchObject({ ok: false, reason: "too-large" });
		} finally {
			rmSync(growing, { force: true });
		}
	});
});

/**
 * A directory on the path swapped for a symlink to the outside between the
 * check and the open. O_NOFOLLOW covers only the last component, so without
 * the identity recheck open() follows the swapped directory and reads the
 * outside file. The swap runs in the read's own test hooks, so it lands at
 * the exact moment, every run.
 */
describePosix("a directory swapped for an outside symlink during the read", () => {
	let dir = "";
	let repo = "";
	let toOutside: () => void = () => {};
	let toInside: () => void = () => {};

	beforeAll(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "pn-repo-file-swap-")));
		repo = join(dir, "repo");
		const away = join(dir, "outside");
		mkdirSync(join(repo, "sub"), { recursive: true });
		mkdirSync(away);
		writeFileSync(join(repo, "sub", "f.txt"), "inside\n");
		writeFileSync(join(away, "f.txt"), "TOP SECRET\n");
		symlinkSync("inside-target", join(repo, "sub", "link"));
		symlinkSync("/outside-secret-target", join(away, "link"));
		symlinkSync(away, join(repo, "evil"));
		toOutside = () => {
			renameSync(join(repo, "sub"), join(repo, "sub-real"));
			renameSync(join(repo, "evil"), join(repo, "sub"));
		};
		toInside = () => {
			renameSync(join(repo, "sub"), join(repo, "evil"));
			renameSync(join(repo, "sub-real"), join(repo, "sub"));
		};
	});

	afterAll(() => {
		if (dir) rmSync(dir, { recursive: true, force: true });
	});

	/** Run `read` with the swap in its hooks, and always restore the tree. */
	async function withSwap<T>(
		swapBack: boolean,
		read: (hooks: { beforeOpen: () => void; afterOpen: () => void }) => Promise<T>,
	): Promise<T> {
		let swapped = false;
		try {
			return await read({
				beforeOpen: () => {
					toOutside();
					swapped = true;
					// The swap really does point the same path outside.
					expect(readFileSync(join(repo, "sub", "f.txt"), "utf-8")).toBe("TOP SECRET\n");
				},
				afterOpen: () => {
					if (swapBack && swapped) {
						toInside();
						swapped = false;
					}
				},
			});
		} finally {
			if (swapped) toInside();
		}
	}

	test("readRepoFile reads the file when nothing is swapped", async () => {
		const result = await readRepoFile(repo, "sub/f.txt");
		expect(result).toMatchObject({ ok: true, content: "inside\n" });
	});

	test("readRepoFile refuses when the path resolves outside after the open", async () => {
		const result = await withSwap(false, (hooks) => readRepoFile(repo, "sub/f.txt", { hooks }));
		expect(result).toMatchObject({ ok: false, reason: "outside-root" });
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});

	test("readRepoFile refuses when the swap is undone before the recheck (inode differs)", async () => {
		// The path is contained again by the time it is rechecked, so only the
		// dev/ino comparison with the open descriptor catches this.
		const result = await withSwap(true, (hooks) => readRepoFile(repo, "sub/f.txt", { hooks }));
		expect(result).toMatchObject({ ok: false, reason: "outside-root" });
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});

	test("readRepoWorkingTreeEntry reads the file when nothing is swapped", async () => {
		const entry = await readRepoWorkingTreeEntry(repo, "sub/f.txt");
		expect(entry).toMatchObject({ ok: true, kind: "file", content: "inside\n" });
	});

	for (const swapBack of [false, true]) {
		const when = swapBack ? "undone before the recheck" : "still in place at the recheck";
		test(`readRepoWorkingTreeEntry refuses a file read through the swap (${when})`, async () => {
			const entry = await withSwap(swapBack, (hooks) => readRepoWorkingTreeEntry(repo, "sub/f.txt", { hooks }));
			expect(entry).toMatchObject({ ok: false, reason: "outside-root" });
			expect(JSON.stringify(entry)).not.toContain("SECRET");
		});

		test(`readRepoWorkingTreeEntry refuses a link target read through the swap (${when})`, async () => {
			const entry = await withSwap(swapBack, (hooks) => readRepoWorkingTreeEntry(repo, "sub/link", { hooks }));
			expect(entry).toMatchObject({ ok: false, reason: "outside-root" });
			expect(JSON.stringify(entry)).not.toContain("outside-secret-target");
		});
	}
});

describe("text decoding", () => {
	const BOM_FILE = "bom.txt";

	beforeAll(() => {
		writeFileSync(join(root, BOM_FILE), Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69, 0x0a]));
	});

	test("the default decoder keeps a BOM, as Node's readFileSync(path, 'utf-8') does", async () => {
		const expected = readFileSync(join(root, BOM_FILE), "utf-8");
		expect(expected.charCodeAt(0)).toBe(0xfeff);
		expect(await readRepoFile(root, BOM_FILE)).toMatchObject({ ok: true, content: expected });
		expect(await readRepoWorkingTreeEntry(root, BOM_FILE)).toMatchObject({ ok: true, content: expected });
	});

	test("a caller's decoder gets the file's bytes", async () => {
		const decode = (bytes: Uint8Array) => Promise.resolve(Array.from(bytes).join(","));
		expect(await readRepoFile(root, BOM_FILE, { decode })).toMatchObject({ content: "239,187,191,104,105,10" });
		expect(await readRepoWorkingTreeEntry(root, BOM_FILE, { decode })).toMatchObject({
			content: "239,187,191,104,105,10",
		});
	});
});
