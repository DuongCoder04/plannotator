/**
 * The session registry: writes are atomic, and the read-only lister the
 * update advert runs on every page payload never deletes a file.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listLiveSessions, listSessions, registerSession, sessionKey, unregisterSession, type SessionInfo } from "./sessions";

let dataDir: string;
let saved: string | undefined;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-sessions-"));
  saved = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  rmSync(dataDir, { recursive: true, force: true });
});

const info = (pid: number): SessionInfo => ({
  pid,
  port: 1234,
  url: "http://localhost:1234",
  mode: "review",
  project: "p",
  startedAt: new Date().toISOString(),
  label: "review-p",
});

/** A pid that has exited. */
function deadPid(): number {
  const proc = Bun.spawnSync(["true"]);
  return proc.pid;
}

test("registerSession writes through a temp file: only the finished .json is left", () => {
  registerSession(info(process.pid));
  const dir = join(dataDir, "sessions");
  expect(readdirSync(dir)).toEqual([`${process.pid}.json`]);
  expect(listLiveSessions().map((s) => s.pid)).toEqual([process.pid]);
});

test("listLiveSessions reads only: a half-written or dead entry is skipped, never deleted", () => {
  const dir = join(dataDir, "sessions");
  mkdirSync(dir, { recursive: true });
  registerSession(info(process.pid));
  writeFileSync(join(dir, "424242.json"), '{"pid": 424242, "port"');
  const dead = deadPid();
  writeFileSync(join(dir, `${dead}.json`), JSON.stringify(info(dead)));
  writeFileSync(join(dir, "99.json.abc.tmp"), "{");

  for (let i = 0; i < 3; i++) expect(listLiveSessions().map((s) => s.pid)).toEqual([process.pid]);
  expect(readdirSync(dir).sort()).toEqual([`${dead}.json`, "424242.json", `${process.pid}.json`, "99.json.abc.tmp"].sort());

  // listSessions keeps its cleanup (plannotator sessions); the temp file is not its business either.
  expect(listSessions().map((s) => s.pid)).toEqual([process.pid]);
  expect(readdirSync(dir).sort()).toEqual([`${process.pid}.json`, "99.json.abc.tmp"].sort());
});

test("listLiveSessions on a data dir with no sessions folder answers nothing and creates nothing", () => {
  expect(listLiveSessions()).toEqual([]);
  expect(existsSync(join(dataDir, "sessions"))).toBe(false);
});

test("registerSession never throws when the data dir can't be written (a file in its place)", () => {
  const blocked = join(dataDir, "not-a-dir");
  writeFileSync(blocked, "x");
  process.env.PLANNOTATOR_DATA_DIR = blocked;
  expect(() => registerSession(info(process.pid))).not.toThrow();
});

function baseInfo(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    pid: process.pid,
    port: 19432,
    url: "http://127.0.0.1:19432",
    mode: "plan",
    project: "demo",
    startedAt: new Date().toISOString(),
    label: "plan-demo",
    ...overrides,
  };
}

describe("session registry", () => {
  test("sessionKey prefers an explicit id over the pid", () => {
    expect(sessionKey({ pid: 42 })).toBe("42");
    expect(sessionKey({ id: "42-19432", pid: 42 })).toBe("42-19432");
  });

  test("registers a pid-keyed session when no id is given", () => {
    registerSession(baseInfo());
    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].port).toBe(19432);
  });

  test("keeps concurrent sessions from one process separate", () => {
    registerSession(baseInfo({ id: `${process.pid}-19432`, port: 19432, label: "plan-a" }));
    registerSession(baseInfo({ id: `${process.pid}-19433`, port: 19433, label: "plan-b" }));

    const sessions = listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.port).sort()).toEqual([19432, 19433]);
  });

  test("unregisterSession removes only the matching key", () => {
    registerSession(baseInfo({ id: `${process.pid}-19432`, port: 19432 }));
    registerSession(baseInfo({ id: `${process.pid}-19433`, port: 19433 }));

    unregisterSession(`${process.pid}-19432`);

    const sessions = listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].port).toBe(19433);
  });

  test("unregisterSession defaults to the pid key", () => {
    registerSession(baseInfo());
    unregisterSession();
    expect(listSessions()).toHaveLength(0);
  });

  test("listSessions drops entries whose process is gone", () => {
    registerSession(baseInfo({ id: "dead", pid: 2147483646 }));
    expect(listSessions()).toHaveLength(0);
  });
});
