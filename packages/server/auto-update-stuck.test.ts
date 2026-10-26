/**
 * "No user ever stuck on a version" (QA item 30): the install path's ways to
 * hang or hide. A lock whose wrapper was killed outright, a lock or snooze
 * stamped while the clock was wrong, and auto-update meeting a check that
 * keeps failing. Every case ends bounded or visible.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireUpdateLock,
  autoUpdatePaths,
  installerCommand,
  isUpdateLockHeld,
  reapDeadUpdateLock,
  runAutoUpdateCheck,
  UPDATE_LOCK_HANDOFF_MS,
  type AutoUpdateDeps,
  type InstallerLaunch,
} from "./auto-update";
import { readUpdateState, writeUpdateState, type FetchReleaseResult } from "@plannotator/shared/update-check";

const NOW = 1_800_000_000_000;
let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-stuck-"));
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A pid that is certainly not running: a child of ours that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", "0"], { stdio: "ignore" });
  await new Promise((r) => child.on("exit", r));
  return child.pid!;
}

function backdate(path: string, ms: number) {
  const at = (Date.now() - ms) / 1000;
  utimesSync(path, at, at);
}

describe("update.lock never holds Updating… for good", () => {
  test("a lock whose holder is gone is released at once after the handoff window, and the install reads as failed", async () => {
    const paths = autoUpdatePaths(dataDir);
    writeUpdateState({ pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: NOW, by: "person" } }, dataDir);
    writeFileSync(paths.lock, String(await deadPid()));
    // Inside the handoff window (the wrapper may not have written its pid yet): still held.
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 5_000);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
    expect(reapDeadUpdateLock(dataDir)).toBe(true);
    expect(existsSync(paths.lock)).toBe(false);
    expect(JSON.parse(readFileSync(paths.result, "utf-8"))).toEqual({ version: "0.28.32", exitCode: -1 });
    // The next attempt takes the lock.
    expect(acquireUpdateLock(paths.lock)).toBe(true);
  });

  test("a live holder keeps it (and a lock whose content is not a pid is bounded by its hour)", () => {
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, String(process.ppid));
    backdate(paths.lock, 10 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    expect(reapDeadUpdateLock(dataDir)).toBe(false);
    writeFileSync(paths.lock, "not a pid");
    backdate(paths.lock, 10 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(true);
    backdate(paths.lock, 61 * 60_000);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
  });

  test("a lock stamped more than an hour in the future (the clock moved back) is not held", () => {
    const paths = autoUpdatePaths(dataDir);
    writeFileSync(paths.lock, String(process.ppid));
    const future = (Date.now() + 5 * 60 * 60_000) / 1000;
    utimesSync(paths.lock, future, future);
    expect(isUpdateLockHeld(dataDir)).toBe(false);
    expect(acquireUpdateLock(paths.lock)).toBe(true);
  });
});

describe.skipIf(process.platform === "win32" || !Bun.which("curl"))("the detached wrapper names itself in the lock", () => {
  test("killed outright mid-install: the lock names the wrapper, so the failure shows at once", async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('echo "fake installer started"\nsleep 30\n') });
    const paths = autoUpdatePaths(dataDir);
    writeUpdateState({ pending: { version: "0.28.32", fromVersion: "0.28.31", startedAt: NOW, by: "person" } }, dataDir);
    // Taken by this process (the Inbox's Update now), as acquireUpdateLock writes it.
    writeFileSync(paths.lock, String(process.pid));
    try {
      const { file, args } = installerCommand("linux", []);
      const child = spawn(file, args, {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          TMPDIR: dataDir,
          PLANNOTATOR_UPDATE_VERSION: "v0.28.32",
          PLANNOTATOR_UPDATE_RESULT: paths.result,
          PLANNOTATOR_UPDATE_LOCK: paths.lock,
          PLANNOTATOR_UPDATE_SCRIPT_URL: `http://127.0.0.1:${server.port}/install.sh`,
        },
      });
      let out = "";
      child.stdout!.on("data", (c) => (out += c));
      const exited = new Promise((r) => child.on("close", r));
      const deadline = Date.now() + 20_000;
      while (!out.includes("fake installer started") && Date.now() < deadline) await Bun.sleep(20);
      expect(readFileSync(paths.lock, "utf-8").trim()).toBe(String(child.pid));
      // SIGKILL: no trap runs, nothing records a result or removes the lock.
      process.kill(-child.pid!, "SIGKILL");
      await exited;
      expect(existsSync(paths.lock)).toBe(true);
      backdate(paths.lock, UPDATE_LOCK_HANDOFF_MS + 1_000);
      expect(isUpdateLockHeld(dataDir)).toBe(false);
      expect(reapDeadUpdateLock(dataDir)).toBe(true);
      expect(JSON.parse(readFileSync(paths.result, "utf-8")).exitCode).toBe(-1);
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe("auto-update while the check keeps failing", () => {
  function deps(overrides: Partial<AutoUpdateDeps> = {}): AutoUpdateDeps & { launches: InstallerLaunch[] } {
    const launches: InstallerLaunch[] = [];
    return {
      currentVersion: "0.28.30",
      execPath: "/home/u/.local/bin/plannotator",
      platform: "linux",
      pid: 100,
      dataDir,
      now: () => NOW,
      enabled: () => true,
      isManaged: () => true,
      fetchReleasePage: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "HTTP 200" }),
      fetchRelease: async (): Promise<FetchReleaseResult> => ({ ok: false, error: "HTTP 403", rateLimited: true }),
      listSessions: () => [],
      launchInstaller: (launch) => {
        launches.push(launch);
      },
      launches,
      ...overrides,
    };
  }

  test("installs the newer release an earlier check named, instead of staying 'active' and installing nothing", async () => {
    // A check two hours ago named 0.28.31; GitHub has refused every check since.
    writeUpdateState({ latestRelease: { tag: "0.28.31", fetchedAt: NOW - 2 * 60 * 60_000 } }, dataDir);
    const d = deps();
    expect(await runAutoUpdateCheck(d)).toBe("launched");
    expect(d.launches.map((l) => l.version)).toEqual(["v0.28.31"]);
    expect(readFileSync(autoUpdatePaths(dataDir).log, "utf-8")).toContain("installing 0.28.31, the newest one known");
  });

  test("nothing newer known: no install, and the 24 h window is given back", async () => {
    writeUpdateState({ latestRelease: { tag: "0.28.30", fetchedAt: NOW - 2 * 60 * 60_000 } }, dataDir);
    const d = deps();
    expect(await runAutoUpdateCheck(d)).toBe("no-release");
    expect(d.launches).toEqual([]);
    expect(readUpdateState(dataDir).lastCheckAt).toBeUndefined();
  });
});
