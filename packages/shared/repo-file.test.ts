/**
 * readRepoFile: the one guard both review servers use to read a working-tree
 * file for code navigation. Each test is a way the server could hand out a
 * file it must not, or hang or bloat on one it cannot afford. The old string
 * check (`validateFilePath`) let both symlink cases through.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_REPO_FILE_BYTES, isContainedPath, readRepoFile, validateRepoFilePath } from "./repo-file";

const posixOnly = process.platform === "win32" ? test.skip : test;

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
	test("reads a file inside the root", () => {
		const result = readRepoFile(root, "src/alpha.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("export const a = 1;\n");
	});

	posixOnly("refuses a symlink to /etc/hosts", () => {
		expect(existsSync("/etc/hosts")).toBe(true);
		const result = readRepoFile(root, "hosts");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	posixOnly("refuses a path through a symlinked directory that leaves the root", () => {
		const result = readRepoFile(root, "escape-dir/secret.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("outside-root");
	});

	posixOnly("still reads a symlink that stays inside the root", () => {
		const result = readRepoFile(root, "inside-link.ts");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.content).toBe("export const a = 1;\n");
	});

	posixOnly("reports a dangling symlink as not-found, not as an escape", () => {
		const result = readRepoFile(root, "dangling.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-found");
	});

	test("refuses .. traversal and absolute paths before touching the filesystem", () => {
		for (const candidate of [
			"../outside/secret.txt",
			"src/../../outside/secret.txt",
			"..\\outside\\secret.txt",
			join(outside, "secret.txt"),
			"/etc/hosts",
			"C:/Windows/win.ini",
		]) {
			const result = readRepoFile(root, candidate);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("invalid-path");
		}
	});

	test("accepts a filename that merely contains two dots", () => {
		// The old substring check refused this legitimate name.
		expect(validateRepoFilePath("src/foo..bar.ts")).toEqual({ ok: true, path: "src/foo..bar.ts" });
	});

	test("a sibling directory sharing the root's name prefix is not inside it", () => {
		expect(isContainedPath("/repo-evil/x", "/repo")).toBe(false);
		expect(isContainedPath("/repo/x", "/repo")).toBe(true);
	});
});

describe("readRepoFile non-regular files", () => {
	test("refuses a directory", () => {
		const result = readRepoFile(root, "src");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-a-file");
	});

	posixOnly("refuses a FIFO without blocking on it", () => {
		const fifo = join(root, "pipe");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		try {
			// Without O_NONBLOCK and the regular-file check this open never
			// returns, because no writer ever arrives.
			const result = readRepoFile(root, "pipe");
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe("not-a-file");
		} finally {
			rmSync(fifo, { force: true });
		}
	});

	posixOnly("refuses a device when the root itself contains it", () => {
		// Root /dev: containment passes, so only the regular-file check stands
		// between the request and an endless read of /dev/zero.
		const result = readRepoFile("/dev", "zero");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("not-a-file");
	});
});

describe("readRepoFile size cap", () => {
	test("refuses a file one byte over the cap and reports its size", () => {
		const big = join(root, "big.txt");
		writeFileSync(big, Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
		try {
			const result = readRepoFile(root, "big.txt");
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

	test("reads a file exactly at the cap", () => {
		const atCap = join(root, "atcap.txt");
		writeFileSync(atCap, Buffer.alloc(MAX_REPO_FILE_BYTES, 0x62));
		try {
			const result = readRepoFile(root, "atcap.txt");
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.content.length).toBe(MAX_REPO_FILE_BYTES);
		} finally {
			rmSync(atCap, { force: true });
		}
	});

	test("honors a smaller per-caller cap (hover reads stop at 1 MB)", () => {
		const result = readRepoFile(root, "src/alpha.ts", { maxBytes: 4 });
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toBe("too-large");
	});
});
