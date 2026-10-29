/**
 * One release's notes fetched by its tag (fetchReleaseNotesFor), for a
 * version installed before the release check saw it, against a fake release API
 * on loopback (never GitHub): the request, the saved notes, the knob, the
 * per-version throttle, and stored notes without a "What's New" part.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_RELEASE_API_URL,
  fetchReleaseNotesFor,
  readReleaseNotes,
  readUpdateState,
  RELEASE_ASSETS_FETCH_INTERVAL_MS,
  RELEASE_ASSETS_FETCH_RETRY_MS,
  RELEASE_CHECK_RETRY_MS,
  RELEASE_NOTES_PENDING_RETRY_MS,
  RELEASE_NOTES_YOUNG_MS,
  releaseTagApiUrl,
  writeReleaseNotes,
} from "./update-check";

const NOW = 1_800_000_000_000;

const bodyFor = (version: string) =>
  [
    "| [v0.28.18](https://x/v0.28.18) | The Inbox's search |",
    "",
    `## What's New in v${version}`,
    "",
    "Notes the person reads.",
    "",
    "## Install / Update",
    "",
    "curl ...",
  ].join("\n");

interface Seen {
  path: string;
  userAgent: string | null;
}

let dataDir: string;
let seen: Seen[];
let answer: (path: string) => Response;
let server: ReturnType<typeof Bun.serve>;
let savedUrl: string | undefined;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-update-notes-"));
  seen = [];
  answer = (path) => {
    const m = /\/tags\/v(\d+\.\d+\.\d+)$/.exec(path);
    return m
      ? Response.json({ tag_name: `v${m[1]}`, published_at: "2026-10-14T09:00:00Z", body: bodyFor(m[1]!) })
      : new Response("not found", { status: 404 });
  };
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      seen.push({ path, userAgent: req.headers.get("user-agent") });
      return answer(path);
    },
  });
  savedUrl = process.env.PLANNOTATOR_UPDATE_API_URL;
  process.env.PLANNOTATOR_UPDATE_API_URL = `http://127.0.0.1:${server.port}/repos/backnotprop/plannotator/releases/latest`;
});

afterEach(() => {
  server.stop(true);
  if (savedUrl === undefined) delete process.env.PLANNOTATOR_UPDATE_API_URL;
  else process.env.PLANNOTATOR_UPDATE_API_URL = savedUrl;
  rmSync(dataDir, { recursive: true, force: true });
});

const fetchNotes = (version: string, overrides: { now?: number; enabled?: boolean } = {}) =>
  fetchReleaseNotesFor({ version, dataDir, now: () => overrides.now ?? NOW, enabled: () => overrides.enabled ?? true });

describe("the tag URL", () => {
  test("GitHub's releases/tags/vX by default, and beside an override's latest", () => {
    expect(releaseTagApiUrl("0.28.19", {})).toBe(DEFAULT_RELEASE_API_URL.replace(/latest$/, "tags/v0.28.19"));
    expect(releaseTagApiUrl("v0.28.19", { PLANNOTATOR_UPDATE_API_URL: "http://127.0.0.1:9/releases/latest" })).toBe(
      "http://127.0.0.1:9/releases/tags/v0.28.19",
    );
    expect(releaseTagApiUrl("../x", {})).toBeNull();
  });
});

describe("fetchReleaseNotesFor", () => {
  test("a version with no saved notes is asked for once by its tag, and the notes are saved", async () => {
    expect(readReleaseNotes("0.28.19", dataDir)).toBeNull();
    const first = await fetchNotes("0.28.19");
    expect(first.outcome).toBe("fetched");
    expect(seen).toEqual([{ path: "/repos/backnotprop/plannotator/releases/tags/v0.28.19", userAgent: "plannotator-update-check" }]);
    const saved = readReleaseNotes("0.28.19", dataDir)!;
    expect(saved.notes).toBe("Notes the person reads.");
    expect(saved.publishedAt).toBe("2026-10-14T09:00:00Z");
    expect(saved.highlights.map((h) => h.version)).toEqual(["0.28.18"]);
    expect((await fetchNotes("0.28.19")).outcome).toBe("present");
    expect(seen.length).toBe(1);
  });

  test("update checks off: no request at all", async () => {
    expect((await fetchNotes("0.28.19", { enabled: false })).outcome).toBe("disabled");
    expect(seen.length).toBe(0);
    expect(readUpdateState(dataDir).notesFetch).toBeUndefined();
  });

  test("a failure waits 6 h before the next try; never a loop", async () => {
    answer = () => new Response("rate limited", { status: 403 });
    expect(await fetchNotes("0.28.19")).toEqual({ outcome: "failed", error: "HTTP 403" });
    expect(readUpdateState(dataDir).notesFetch?.["0.28.19"]).toMatchObject({ attemptedAt: NOW, failedAt: NOW, error: "HTTP 403" });
    expect((await fetchNotes("0.28.19", { now: NOW + 60_000 })).outcome).toBe("not-due");
    // Notes keep their own back-off, not the hourly release check's.
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_CHECK_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_ASSETS_FETCH_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
    answer = (path) => Response.json({ tag_name: "v0.28.19", body: bodyFor("0.28.19"), path });
    expect((await fetchNotes("0.28.19", { now: NOW + RELEASE_ASSETS_FETCH_RETRY_MS })).outcome).toBe("fetched");
    expect(seen.length).toBe(2);
  });

  test("an answer for another tag is a failure and saves nothing", async () => {
    answer = () => Response.json({ tag_name: "v0.28.18", body: bodyFor("0.28.18") });
    expect((await fetchNotes("0.28.19")).outcome).toBe("failed");
    expect(readReleaseNotes("0.28.19", dataDir)).toBeNull();
  });

  test("notes saved before the release body was edited (no What's New part) are fetched again, once a day at most", async () => {
    // What the release check saved from GitHub's generated notes, before the body was replaced.
    writeReleaseNotes({ version: "0.28.19", notes: "", highlights: [] }, dataDir);
    expect((await fetchNotes("0.28.19")).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.19", dataDir)!.notes).toBe("Notes the person reads.");
    expect(seen.length).toBe(1);

    // A release that really has no What's New part is not asked for again within 24 h.
    writeReleaseNotes({ version: "0.28.20", notes: "", highlights: [] }, dataDir);
    answer = () => Response.json({ tag_name: "v0.28.20", body: "## What's Changed\n\n* a PR" });
    expect((await fetchNotes("0.28.20")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.20", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);
  });

  // The 0.28.37 bug: CI publishes GitHub's generated body and the written
  // notes replace it minutes later. An Inbox that asked in between waited a
  // day, so its "What's new" link never showed for that run.
  test("a young release answered without a What's New part is asked again after 15 minutes, not a day", async () => {
    const generated = "## What's Changed\n\n* a PR by someone";
    const publishedAt = new Date(NOW - 60_000).toISOString();
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: generated });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.37", dataDir)!.notes).toBe("");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);

    // Still the generated body: asked again on the same quick cadence.
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(2);

    // The written notes are in now: the next try saves them, and nothing more is asked.
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: bodyFor("0.28.37") });
    expect((await fetchNotes("0.28.37", { now: NOW + 2 * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("fetched");
    expect(readReleaseNotes("0.28.37", dataDir)!.notes).toBe("Notes the person reads.");
    expect((await fetchNotes("0.28.37", { now: NOW + 3 * RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("present");
    expect(seen.length).toBe(3);
  });

  test("a release over 2 days old answered without a What's New part keeps the 24 h back-off", async () => {
    const publishedAt = new Date(NOW - RELEASE_NOTES_YOUNG_MS).toISOString();
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: publishedAt, body: "## What's Changed\n" });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS - 1 })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_ASSETS_FETCH_INTERVAL_MS })).outcome).toBe("fetched");
    expect(seen.length).toBe(2);
  });

  test("the quick retry stops once the release turns 2 days old", async () => {
    const published = NOW - RELEASE_NOTES_YOUNG_MS + RELEASE_NOTES_PENDING_RETRY_MS;
    answer = () => Response.json({ tag_name: "v0.28.37", published_at: new Date(published).toISOString(), body: "" });
    expect((await fetchNotes("0.28.37")).outcome).toBe("fetched");
    // Due 15 minutes later, when the release is exactly 2 days old: no longer young, so a day.
    expect((await fetchNotes("0.28.37", { now: NOW + RELEASE_NOTES_PENDING_RETRY_MS })).outcome).toBe("not-due");
    expect(seen.length).toBe(1);
  });

  test("not a version: nothing asked", async () => {
    expect((await fetchNotes("../../etc/passwd")).outcome).toBe("failed");
    expect(seen.length).toBe(0);
  });
});
