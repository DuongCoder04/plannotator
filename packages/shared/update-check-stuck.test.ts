/**
 * "No user ever stuck on a version" (QA item 30): the release check against a
 * fake GitHub on loopback (page redirect and API, the shapes
 * PLANNOTATOR_UPDATE_LATEST_URL / PLANNOTATOR_UPDATE_API_URL point at), with
 * an injected clock. Every failure ends either in the update shown, or in the
 * check saying plainly that it is failing, with the install command.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUpdateCheckFailing,
  fetchLatestFromPage,
  fetchLatestRelease,
  isSnoozed,
  readUpdateState,
  RELEASE_CHECK_FAILING_AFTER_MS,
  RELEASE_CHECK_RETRY_MS,
  releaseCheckFailing,
  runReleaseCheck,
  takeUpdateHint,
  UPDATE_SNOOZE_MS,
  versionFromLatestRedirect,
  writeUpdateState,
} from "./update-check";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

let dataDir: string;
let server: ReturnType<typeof Bun.serve>;
/** What the fake answers for the release page and for the API. */
let page: () => Response;
let api: () => Response;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-stuck-"));
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => (new URL(req.url).pathname.startsWith("/api/") ? api() : page()),
  });
});
afterEach(() => {
  server.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

const base = () => `http://127.0.0.1:${server.port}`;
const pageUrl = () => `${base()}/backnotprop/plannotator/releases/latest`;
const check = (now: number) =>
  runReleaseCheck({
    dataDir,
    enabled: () => true,
    now: () => now,
    fetchReleasePage: () => fetchLatestFromPage(pageUrl()),
    fetchRelease: () => fetchLatestRelease(`${base()}/api/repos/backnotprop/plannotator/releases/latest`),
  });

const redirectTo = (version: string, path = "/backnotprop/plannotator/releases/tag/") => () =>
  new Response(null, { status: 302, headers: { location: `${base()}${path}v${version}` } });
const captivePortal = () => new Response("<html>Sign in to the Wi-Fi</html>", { status: 200, headers: { "content-type": "text/html" } });
const rateLimited = () => new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } });

describe("both sources failing: never silent, never unbounded", () => {
  test("a captive portal on the page and a rate-limited API: after 3 hours of failures the check says so, with since and why", async () => {
    page = captivePortal;
    api = rateLimited;
    // The machine checks every 10 minutes (each trigger the retry allows).
    let t = NOW;
    for (; t < NOW + RELEASE_CHECK_FAILING_AFTER_MS; t += RELEASE_CHECK_RETRY_MS) {
      expect((await check(t)).outcome).toBe("failed");
      // Quiet while it may still be a laptop waking up or a short outage.
      expect(releaseCheckFailing(readUpdateState(dataDir), t)).toBeNull();
    }
    expect((await check(t)).outcome).toBe("failed");
    const failing = releaseCheckFailing(readUpdateState(dataDir), t);
    expect(failing?.since).toBe(NOW);
    expect(failing?.error).toContain("page: HTTP 200");
    // The surfaces carry it with the command that always works.
    expect(buildUpdateCheckFailing(readUpdateState(dataDir), t, "curl -fsSL https://plannotator.ai/install.sh | bash")).toEqual({
      since: new Date(NOW).toISOString(),
      error: failing!.error,
      command: "curl -fsSL https://plannotator.ai/install.sh | bash",
    });
  });

  test("the run of failures survives the claim of each next attempt (no flicker while a check is in flight)", async () => {
    page = captivePortal;
    api = rateLimited;
    for (let t = NOW; t <= NOW + 3 * HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    const now = NOW + 3 * HOUR + RELEASE_CHECK_RETRY_MS;
    // A check in flight: the page hangs while the claim is already written.
    let release!: () => void;
    page = () => {
      throw new Error("unreachable");
    };
    const hanging = runReleaseCheck({
      dataDir,
      enabled: () => true,
      now: () => now,
      fetchReleasePage: () => new Promise((resolve) => (release = () => resolve({ ok: false, error: "offline" }))),
      fetchRelease: async () => ({ ok: false, error: "offline" }),
    });
    await Bun.sleep(10);
    expect(releaseCheckFailing(readUpdateState(dataDir), now)?.since).toBe(NOW);
    release();
    await hanging;
    expect(releaseCheckFailing(readUpdateState(dataDir), now)?.since).toBe(NOW);
  });

  test("one success ends it, and the release it names is known", async () => {
    page = captivePortal;
    api = rateLimited;
    let t = NOW;
    for (; t <= NOW + 4 * HOUR; t += RELEASE_CHECK_RETRY_MS) await check(t);
    expect(releaseCheckFailing(readUpdateState(dataDir), t)).not.toBeNull();
    page = redirectTo("0.28.32");
    expect(await check(t)).toEqual({ outcome: "checked", version: "0.28.32" });
    expect(releaseCheckFailing(readUpdateState(dataDir), t)).toBeNull();
    expect(readUpdateState(dataDir).releaseCheck?.failingSince).toBeUndefined();
  });

  test("a stamp in the future (the clock moved back) is no failure", () => {
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, failingSince: NOW + 10 * HOUR, error: "offline" } }, dataDir);
    expect(releaseCheckFailing(readUpdateState(dataDir), NOW + 5 * HOUR)).toBeNull();
  });

  test("a success another process recorded since (one that predates failingSince) ends it too", () => {
    writeUpdateState(
      {
        latestRelease: { tag: "0.28.32", fetchedAt: NOW + 4 * HOUR },
        releaseCheck: { attemptedAt: NOW + 4 * HOUR, failingSince: NOW, error: "offline" },
      },
      dataDir,
    );
    expect(releaseCheckFailing(readUpdateState(dataDir), NOW + 5 * HOUR)).toBeNull();
  });
});

describe("GitHub changing the redirect's spelling", () => {
  test("the owner or repository in another case is still read", async () => {
    page = redirectTo("0.28.32", "/BackNotProp/Plannotator/releases/tag/");
    api = rateLimited;
    expect(versionFromLatestRedirect(pageUrl(), `${base()}/BackNotProp/Plannotator/releases/tag/v0.28.32`)).toBe("0.28.32");
    expect(await check(NOW)).toEqual({ outcome: "checked", version: "0.28.32" });
  });

  test("another host or another path is still refused (and falls to the API, then to the failing state)", () => {
    expect(versionFromLatestRedirect(pageUrl(), "https://evil.example/backnotprop/plannotator/releases/tag/v9.9.9")).toBeNull();
    expect(versionFromLatestRedirect(pageUrl(), `${base()}/backnotprop/plannotator/releases`)).toBeNull();
  });
});

describe("Remind me tomorrow never hides an update for longer than a day", () => {
  test("a snooze written while the clock was ahead ends a day from now at most", () => {
    const state = { snooze: { version: "0.28.32", until: NOW + 30 * 24 * HOUR } };
    expect(isSnoozed(state, "0.28.32", NOW)).toBe(false);
    expect(isSnoozed({ snooze: { version: "0.28.32", until: NOW + UPDATE_SNOOZE_MS } }, "0.28.32", NOW)).toBe(true);
    expect(isSnoozed({ snooze: { version: "0.28.32", until: NOW - 1 } }, "0.28.32", NOW)).toBe(false);
    expect(isSnoozed({ snooze: { version: "0.28.31", until: NOW + HOUR } }, "0.28.32", NOW)).toBe(false);
  });
});

describe("the terminal hint while checking fails", () => {
  test("says checking is failing, with the install command, once a day; a known newer release still wins", () => {
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failedAt: NOW, failingSince: NOW - 4 * HOUR, error: "page: HTTP 200" } }, dataDir);
    const line = takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW, dataDir, platform: "linux" });
    expect(line).toContain("can't check for updates");
    expect(line).toContain("page: HTTP 200");
    expect(line).toContain("curl -fsSL https://plannotator.ai/install.sh | bash");
    expect(takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW + HOUR, dataDir, platform: "linux" })).toBeNull();
    // Off: nothing at all.
    writeUpdateState({ releaseCheck: { attemptedAt: NOW, failingSince: NOW - 4 * HOUR, error: "x" } }, dataDir);
    expect(takeUpdateHint({ current: "0.28.31", enabled: false, now: NOW, dataDir })).toBeNull();
    writeUpdateState({ latestRelease: { tag: "0.28.32", fetchedAt: NOW - 5 * HOUR }, releaseCheck: { attemptedAt: NOW, failingSince: NOW - 4 * HOUR, error: "x" } }, dataDir);
    expect(takeUpdateHint({ current: "0.28.31", enabled: true, now: NOW, dataDir })).toContain("0.28.32 is available");
  });
});
