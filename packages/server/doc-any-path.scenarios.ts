/**
 * `/api/doc` outside the project (#2291), driven over HTTP against real plan
 * and annotate servers. Shared by the Bun suite (doc-any-path.test.ts) and
 * the Pi mirror (apps/pi-extension/server/doc-any-path.test.ts), so both
 * runtimes answer the same scenarios.
 *
 * A tab on this machine opens any document: one in a folder added under
 * Settings → Files, and one the current document links outside the project.
 * Another site's page is refused, and so is a reader that may be on another
 * machine (remote mode, or a request forwarded from a non-loopback address),
 * which keeps the session's roots.
 *
 * Requests go through node:http so Host, Origin, Sec-Fetch-Site and
 * X-Forwarded-For are exactly the ones under test. Every test runs under a
 * temp PLANNOTATOR_DATA_DIR and HOME; nothing touches the real ~/.plannotator.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { createTestEnvironment } from "../../tests/helpers/environment";
import { closeServer, occupyConsecutivePorts } from "../../tests/helpers/ports";

export interface DocScenarioServer {
  url: string;
  stop: () => void;
}

export type DocScenarioKind = "plan" | "annotate";

export type StartDocScenarioServer = (
  kind: DocScenarioKind,
  options: { docPath: string; htmlContent: string },
) => Promise<DocScenarioServer>;

const HTML = "<!doctype html><html><body>doc-any-path-app</body></html>";

interface Answer {
  status: number;
  body: Record<string, unknown> | null;
}

function get(server: DocScenarioServer, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  const port = new URL(server.url).port;
  return new Promise((resolve, reject) => {
    const req = request(
      `http://127.0.0.1:${port}${path}`,
      { method: "GET", headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          let body: Record<string, unknown> | null = null;
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = null;
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

const docUrl = (path: string, base?: string) =>
  `/api/doc?path=${encodeURIComponent(path)}${base ? `&base=${encodeURIComponent(base)}` : ""}&doc=1`;

export function defineDocAnyPathScenarios(runtime: string, start: StartDocScenarioServer): void {
  const environment = createTestEnvironment(
    [
      "HOME",
      "PLANNOTATOR_PORT",
      "PLANNOTATOR_REMOTE",
      "PLANNOTATOR_DATA_DIR",
      "PLANNOTATOR_AI",
      "PLANNOTATOR_INBOX_CONNECT",
      "PLANNOTATOR_URL_HOST",
      "PLANNOTATOR_PUBLIC_URL",
      "PLANNOTATOR_ALLOWED_HOSTS",
      "SSH_TTY",
      "SSH_CONNECTION",
    ],
    "plannotator-doc-any-path-",
  );

  /** The session's own document, inside the project. */
  let docPath = "";
  let project = "";
  /** A folder added under Settings → Files, outside the project. */
  let added = "";
  /** A folder beside the project that the session's document links into. */
  let shared = "";
  const servers: DocScenarioServer[] = [];

  async function isolate(options: { remote?: boolean } = {}): Promise<void> {
    environment.reset();
    const dir = realpathSync(environment.makeTempDir());
    process.env.HOME = join(dir, "home");
    process.env.PLANNOTATOR_DATA_DIR = join(dir, "data");
    process.env.PLANNOTATOR_AI = "disabled";
    process.env.PLANNOTATOR_INBOX_CONNECT = "0";
    process.env.PLANNOTATOR_REMOTE = options.remote ? "1" : "0";
    if (options.remote) {
      // Remote mode would otherwise bind the fixed 19432.
      const { start: port, servers: held } = await occupyConsecutivePorts(1);
      await closeServer(held[0]);
      process.env.PLANNOTATOR_PORT = String(port);
    }
    mkdirSync(process.env.HOME, { recursive: true });
    project = join(dir, "demo-app");
    added = join(dir, "reference-docs");
    shared = join(dir, "shared");
    mkdirSync(project, { recursive: true });
    mkdirSync(join(added, "guides"), { recursive: true });
    mkdirSync(shared, { recursive: true });
    docPath = join(project, "notes.md");
    writeFileSync(docPath, "# Notes\n\nSee [linked](../shared/linked.md).\n");
    writeFileSync(join(added, "intro.md"), "# Reference intro\n\nADDED-FOLDER-BODY\n");
    writeFileSync(join(added, "guides/setup.md"), "# Setup\n\nADDED-SIBLING-BODY\n");
    writeFileSync(join(shared, "linked.md"), "# Linked\n\nLINKED-OUTSIDE-BODY\n");
  }

  async function open(kind: DocScenarioKind): Promise<DocScenarioServer> {
    const server = await start(kind, { docPath, htmlContent: HTML });
    servers.push(server);
    return server;
  }

  afterEach(() => {
    for (const server of servers.splice(0)) server.stop();
    environment.restore();
  });

  for (const kind of ["plan", "annotate"] as const) {
    describe(`${runtime} ${kind} server: /api/doc outside the project (#2291)`, () => {
      test("opens a document in a folder added under Settings → Files, and one it links", async () => {
        await isolate();
        const server = await open(kind);
        // What the Files sidebar sends: the absolute path, its folder as base.
        const doc = await get(server, docUrl(join(added, "intro.md"), added));
        expect(doc.status).toBe(200);
        expect(String(doc.body?.markdown)).toContain("ADDED-FOLDER-BODY");
        // A relative link inside that document resolves from its folder.
        const sibling = await get(server, docUrl("guides/setup.md", added));
        expect(sibling.status).toBe(200);
        expect(String(sibling.body?.markdown)).toContain("ADDED-SIBLING-BODY");
      });

      test("opens a document the current one links by a relative path outside the project", async () => {
        await isolate();
        const server = await open(kind);
        const linked = await get(server, docUrl("../shared/linked.md", project));
        expect(linked.status).toBe(200);
        expect(String(linked.body?.markdown)).toContain("LINKED-OUTSIDE-BODY");
        expect(linked.body?.filepath).toBe(join(shared, "linked.md"));
      });

      test("refuses another site's page", async () => {
        await isolate();
        const server = await open(kind);
        for (const headers of <Record<string, string>[]>[
          { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          { origin: "https://evil.example" },
          { "sec-fetch-site": "same-site" },
        ]) {
          const answer = await get(server, docUrl(join(added, "intro.md"), added), headers);
          expect([headers, answer.status]).toEqual([headers, 403]);
          expect(answer.body?.code).toBe("cross_origin");
          expect(JSON.stringify(answer.body)).not.toContain("ADDED-FOLDER-BODY");
        }
      });

      test("a reader that may be on another machine keeps the session's roots", async () => {
        await isolate();
        const server = await open(kind);
        // A proxy forwarding a non-loopback client (tailscale serve, a LAN reverse proxy).
        const forwarded = await get(server, docUrl(join(added, "intro.md"), added), {
          "x-forwarded-for": "100.101.102.103",
        });
        expect(forwarded.status).toBe(403);
        expect(JSON.stringify(forwarded.body)).not.toContain("ADDED-FOLDER-BODY");
        const linked = await get(server, docUrl("../shared/linked.md", project), {
          "x-forwarded-for": "192.168.1.20",
        });
        // 403 where the base is a root (annotate), 404 where it is not trusted (plan).
        expect(linked.status).not.toBe(200);
        expect(JSON.stringify(linked.body)).not.toContain("LINKED-OUTSIDE-BODY");
        // A local reverse proxy (loopback hops only) is still this machine.
        const local = await get(server, docUrl(join(added, "intro.md"), added), {
          "x-forwarded-for": "127.0.0.1",
        });
        expect(local.status).toBe(200);
      });

      test("remote mode keeps the session's roots", async () => {
        await isolate({ remote: true });
        const server = await open(kind);
        const doc = await get(server, docUrl(join(added, "intro.md"), added));
        expect(doc.status).toBe(403);
        expect(JSON.stringify(doc.body)).not.toContain("ADDED-FOLDER-BODY");
        const linked = await get(server, docUrl("../shared/linked.md", project));
        expect(linked.status).not.toBe(200);
        expect(JSON.stringify(linked.body)).not.toContain("LINKED-OUTSIDE-BODY");
      });
    });
  }
}
