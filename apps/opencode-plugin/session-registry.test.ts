/**
 * The review and annotate commands' servers are listed in `plannotator
 * sessions` only while they wait: the entry goes when the decision comes, and
 * when the wait throws.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideListed } from "./session-registry";

const saved = process.env.PLANNOTATOR_DATA_DIR;
let dataDir = "";
afterEach(() => {
  if (saved === undefined) delete process.env.PLANNOTATOR_DATA_DIR;
  else process.env.PLANNOTATOR_DATA_DIR = saved;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function sandbox(): string {
  dataDir = mkdtempSync(join(tmpdir(), "plannotator-opencode-sessions-"));
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
  return join(dataDir, "sessions", "opencode");
}

function stubServer(decide: (listed: string[]) => Promise<{ approved: boolean }>, dir: string) {
  const server = {
    port: 45123,
    url: "http://localhost:45123",
    stopped: false,
    waitForDecision: () => decide(readdirSync(dir)),
    stop: () => {
      server.stopped = true;
    },
  };
  return server;
}

test("listed while it waits, gone once the decision comes", async () => {
  const dir = sandbox();
  let seen: string[] = [];
  const server = stubServer(async (listed) => ((seen = listed), { approved: true }), dir);
  expect(await decideListed(server, "review", "p")).toEqual({ approved: true });
  expect(seen).toEqual([`${process.pid}-45123.json`]);
  expect(server.stopped).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});

test("a wait that throws still stops the server and removes the entry", async () => {
  const dir = sandbox();
  const failure = new Error("decision failed");
  const server = stubServer(async () => {
    throw failure;
  }, dir);
  await expect(decideListed(server, "annotate", "p")).rejects.toBe(failure);
  expect(server.stopped).toBe(true);
  expect(readdirSync(dir)).toEqual([]);
});
