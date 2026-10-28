/**
 * readFileCapped / readRepoFile (repo-file.ts): the cap is checked before
 * reading, and a FIFO or directory is refused at once instead of blocking.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileCapped, readRepoFile } from "./repo-file";

let dir = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "pn-repo-file-unit-"));
	writeFileSync(join(dir, "ten.txt"), "0123456789");
});

afterAll(() => {
	if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("readFileCapped", () => {
	test("reads a file exactly at the cap and refuses one byte over, with its size", async () => {
		expect(await readFileCapped(join(dir, "ten.txt"), { maxBytes: 10 })).toMatchObject({ ok: true, content: "0123456789" });
		expect(await readFileCapped(join(dir, "ten.txt"), { maxBytes: 9 })).toMatchObject({
			ok: false,
			reason: "too-large",
			size: 10,
			maxBytes: 9,
		});
	});

	test("refuses a directory as not a file", async () => {
		expect(await readFileCapped(dir)).toMatchObject({ ok: false, reason: "not-a-file" });
	});

	(process.platform === "win32" ? test.skip : test)("refuses a FIFO at once instead of waiting for a writer", async () => {
		const fifo = join(dir, "pipe");
		expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
		const timeout = new Promise((resolve) => setTimeout(() => resolve("blocked"), 2000));
		expect(await Promise.race([readFileCapped(fifo), timeout])).toMatchObject({ ok: false, reason: "not-a-file" });
	});
});

describe("readRepoFile", () => {
	test("keeps the path string checks: absolute, .. and NUL are invalid; a missing file is not found", async () => {
		for (const path of ["/etc/hosts", "../ten.txt", "a/../ten.txt", "ten.txt\0", ""]) {
			expect(await readRepoFile(dir, path)).toMatchObject({ ok: false, reason: "invalid-path" });
		}
		expect(await readRepoFile(dir, "nope.txt")).toMatchObject({ ok: false, reason: "not-found" });
		expect(await readRepoFile(dir, "ten.txt")).toMatchObject({ ok: true, content: "0123456789" });
	});
});
