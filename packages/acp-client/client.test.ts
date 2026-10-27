import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpClient, AcpStartAbortedError, MAX_CLIENT_READ_BYTES, readTextFileForAgent } from "./client";

const dir = mkdtempSync(join(tmpdir(), "pn-client-read-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("fs/read_text_file for an agent that calls it", () => {
  it("reads a file, or the lines asked for", async () => {
    const p = join(dir, "a.ts");
    writeFileSync(p, "one\ntwo\nthree\n");
    expect(await readTextFileForAgent({ path: p })).toEqual({ content: "one\ntwo\nthree\n" });
    expect(await readTextFileForAgent({ path: p, line: 2, limit: 1 })).toEqual({ content: "two" });
  });

  it("refuses a relative path, a folder, and a file over 10 MB", async () => {
    await expect(readTextFileForAgent({ path: "a.ts" })).rejects.toThrow();
    await expect(readTextFileForAgent({ path: dir })).rejects.toThrow("is not a file");
    const big = join(dir, "big.log");
    writeFileSync(big, "");
    truncateSync(big, MAX_CLIENT_READ_BYTES + 1);
    await expect(readTextFileForAgent({ path: big })).rejects.toThrow("reads files up to");
  });
});

describe("start: an agent that hangs in initialize can be stopped", () => {
  // Never answers initialize, ignores SIGTERM and stdin's end; writes its pid to PID_OUT.
  const HANG = "require('node:fs').writeFileSync(process.env.PID_OUT, String(process.pid)); process.on('SIGTERM', () => {}); process.stdin.on('data', () => {}); process.stdin.on('end', () => {}); setInterval(() => {}, 1000);";
  const pids: number[] = [];
  afterEach(() => {
    for (const pid of pids.splice(0)) {
      try {
        process.kill(pid, "SIGKILL"); // own child (the hanging stand-in), whatever the test asserted
      } catch {
        // Already gone.
      }
    }
  });
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0); // own child
      return true;
    } catch {
      return false;
    }
  };
  const handlers = { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }) };
  const info = { name: "test", title: "Test", version: "0" };
  async function pidOf(out: string): Promise<number> {
    for (let i = 0; i < 100 && !existsSync(out); i++) await Bun.sleep(20);
    const pid = Number(readFileSync(out, "utf8"));
    pids.push(pid);
    return pid;
  }
  async function gone(pid: number, ms: number): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (!alive(pid)) return true;
      await Bun.sleep(50);
    }
    return !alive(pid);
  }

  it("a time limit rejects the start and stops its process group (SIGTERM, then SIGKILL)", async () => {
    const out = join(dir, "pid-timeout");
    const started = AcpClient.start({ command: process.execPath, args: ["-e", HANG], env: { PID_OUT: out } }, handlers, info, { initializeTimeoutMs: 500, augmentPath: false });
    await expect(started).rejects.toBeInstanceOf(AcpStartAbortedError);
    expect(await gone(await pidOf(out), 6000)).toBe(true);
  }, 15_000);

  it('an abort with "kill" rejects the start and kills its process group at once', async () => {
    const out = join(dir, "pid-abort");
    const controller = new AbortController();
    const started = AcpClient.start({ command: process.execPath, args: ["-e", HANG], env: { PID_OUT: out } }, handlers, info, { signal: controller.signal, augmentPath: false });
    const pid = await pidOf(out);
    controller.abort("kill");
    await expect(started).rejects.toBeInstanceOf(AcpStartAbortedError);
    expect(await gone(pid, 1000)).toBe(true);
  }, 15_000);
});
