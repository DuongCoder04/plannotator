/**
 * GET /api/code-nav/file, dual-runtime (Bun + Pi): the code-navigation preview
 * reads only regular files whose realpath stays inside the review root, and
 * refuses a file over the 5 MB cap with `reason: "too-large"`.
 *
 * Before the fix both servers joined `${cwd}/${path}` after a string check, so
 * a symlink in the repo (to /etc/hosts, or a directory pointing out) served the
 * file outside it, an oversized file was read whole, and a FIFO hung the
 * request.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { MAX_REPO_FILE_BYTES } from "@plannotator/shared/repo-file";
import { startReviewServer as startBunReviewServer } from "./review";
import { startReviewServer as startPiReviewServer } from "../../apps/pi-extension/server";

const MINIMAL_HTML = "<html><body>Plannotator</body></html>";
const PATCH = "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-a\n+export const app = 1;\n";

const savedEnv: Record<string, string | undefined> = {};
function setEnv(key: string, value: string): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  process.env[key] = value;
}
function restoreEnv(): void {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
}

async function reservePiPort(): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  setEnv("PLANNOTATOR_PORT", String(port));
}

// Symlinks and FIFOs: POSIX only.
const describePosix = process.platform === "win32" ? describe.skip : describe;

describePosix("GET /api/code-nav/file guards", () => {
  let base = "";
  let repo = "";

  beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "pn-code-nav-file-")));
    repo = join(base, "repo");
    const outside = join(base, "outside");
    mkdirSync(join(repo, "src"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
    writeFileSync(join(outside, "secret.txt"), "TOP SECRET\n");
    symlinkSync("/etc/hosts", join(repo, "hosts"));
    symlinkSync(outside, join(repo, "escape-dir"));
    writeFileSync(join(repo, "big.txt"), Buffer.alloc(MAX_REPO_FILE_BYTES + 1, 0x61));
    expect(spawnSync("mkfifo", [join(repo, "pipe")]).status).toBe(0);
  });

  afterAll(() => {
    if (base) rmSync(base, { recursive: true, force: true });
  });

  for (const [runtime, startServer] of [
    ["Bun", startBunReviewServer],
    ["Pi", startPiReviewServer],
  ] as const) {
    describe(runtime, () => {
      let server: { url: string; stop: () => void } | null = null;

      beforeAll(async () => {
        setEnv("PLANNOTATOR_DATA_DIR", join(base, `data-${runtime}`));
        setEnv("PLANNOTATOR_BROWSER", NO_BROWSER);
        setEnv("PLANNOTATOR_UPDATE_CHECK", "0");
        if (runtime === "Pi") await reservePiPort();
        server = await startServer({
          rawPatch: PATCH,
          gitRef: "HEAD",
          agentCwd: repo,
          origin: runtime === "Pi" ? "pi" : "claude-code",
          htmlContent: MINIMAL_HTML,
        });
      });

      afterAll(() => {
        server?.stop();
        server = null;
        restoreEnv();
      });

      const get = async (path: string) => {
        const res = await fetch(`${server!.url}/api/code-nav/file?path=${encodeURIComponent(path)}`, {
          signal: AbortSignal.timeout(5000),
        });
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      };

      test("serves a file inside the repo", async () => {
        const ok = await get("src/app.ts");
        expect(ok.status).toBe(200);
        expect(ok.body.content).toBe("export const app = 1;\n");
      });

      test("refuses a symlink to /etc/hosts", async () => {
        const hosts = await get("hosts");
        expect(hosts.status).toBe(403);
        expect(hosts.body.reason).toBe("outside-root");
        expect(hosts.body.content).toBeUndefined();
      });

      test("refuses a path through a symlinked directory that leaves the repo", async () => {
        const escapeDir = await get("escape-dir/secret.txt");
        expect(escapeDir.status).toBe(403);
        expect(JSON.stringify(escapeDir.body)).not.toContain("TOP SECRET");
      });

      test("refuses .. traversal and absolute paths", async () => {
        for (const path of ["../outside/secret.txt", "/etc/hosts"]) {
          const refused = await get(path);
          expect(refused.status).toBe(400);
          expect(refused.body.reason).toBe("invalid-path");
        }
      });

      test("refuses a file over the cap with reason too-large", async () => {
        const big = await get("big.txt");
        expect(big.status).toBe(413);
        expect(big.body.reason).toBe("too-large");
        expect(big.body.size).toBe(MAX_REPO_FILE_BYTES + 1);
        expect(big.body.maxBytes).toBe(MAX_REPO_FILE_BYTES);
      });

      test("refuses a FIFO instead of hanging on it", async () => {
        // Before the fix the server opened the FIFO and waited for a writer, so
        // the request timed out instead of answering.
        const pipe = await get("pipe");
        expect(pipe.status).toBe(400);
        expect(pipe.body.reason).toBe("not-a-file");
      });
    });
  }
});
