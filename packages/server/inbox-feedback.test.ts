/**
 * The Feedback dialog's send through a running Inbox (temp data dir,
 * loopback) to a local fake feedback endpoint (never the real Worker): the
 * window's words go on with the version, the OS name and `surface: "inbox"`
 * and nothing else; the answer is `{ ok: true }`; a refused or unreachable
 * endpoint is a 502 the dialog can show; bad input never leaves the
 * computer; another site's page cannot send.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];
const fakes: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const fake of fakes.splice(0)) fake.stop(true);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A stand-in for the feedback Worker on 127.0.0.1: records each request and answers `status`. */
function fakeEndpoint(status = 201) {
  const received: { method: string; path: string; headers: Record<string, string>; body: unknown }[] = [];
  const fake = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received.push({ method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers), body: await req.json().catch(() => null) });
      return Response.json(status < 300 ? { ok: true } : { error: "Too many requests. Try again later." }, { status });
    },
  });
  fakes.push(fake);
  return { url: `http://127.0.0.1:${fake.port}/feedback`, received };
}

async function inbox(feedbackUrl: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-feedback-")));
  roots.push(root);
  const server = await startInboxServer({ dataDir: join(root, "data"), binaryPath: null, version: "0.28.33", feedbackUrl });
  servers.push(server);
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${server.port}/api/inbox/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  return { server, send };
}

describe("POST /api/inbox/feedback", () => {
  test("forwards exactly the words, version, OS and surface; answers { ok: true }", async () => {
    const endpoint = fakeEndpoint();
    const { send } = await inbox(endpoint.url);
    // The window's POSTs all carry `serverSession` (packages/inbox/api.ts); it is not forwarded.
    const res = await send({ message: "  The sidebar is lovely  ", category: "idea", contact: "me@example.com", serverSession: "srv_page" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(endpoint.received).toHaveLength(1);
    const [got] = endpoint.received;
    expect(got!.method).toBe("POST");
    expect(got!.path).toBe("/feedback");
    expect(got!.headers["content-type"]).toBe("application/json");
    // No cookie and no Origin: the Worker sees a server-side request.
    expect(got!.headers.cookie).toBeUndefined();
    expect(got!.headers.origin).toBeUndefined();
    const body = got!.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["category", "contact", "message", "os", "surface", "version"]);
    expect(body).toMatchObject({ message: "The sidebar is lovely", category: "idea", contact: "me@example.com", version: "0.28.33", surface: "inbox" });
    expect(["macOS", "Linux", "Windows", "other", "freebsd", "openbsd"]).toContain(body.os as string);
  });

  test("sends with no email and no category: only the message is required, and an empty email is left out", async () => {
    const endpoint = fakeEndpoint();
    const { send } = await inbox(endpoint.url);
    expect((await send({ message: "hi", contact: "   " })).status).toBe(200);
    expect(Object.keys(endpoint.received[0]!.body as object).sort()).toEqual(["message", "os", "surface", "version"]);
  });

  test("bad input is a 400 and never leaves this computer", async () => {
    const endpoint = fakeEndpoint();
    const { send } = await inbox(endpoint.url);
    for (const body of [{}, { message: "   " }, { message: "x".repeat(4001) }, { message: "hi", category: "rant" }, { message: "hi", thread: "msg_1" }, "not json", [1]]) {
      const res = await send(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe("validation_error");
    }
    expect(endpoint.received).toHaveLength(0);
  });

  test("a refusal from the endpoint is a 502 carrying its reason; an unreachable one says so", async () => {
    const refusing = fakeEndpoint(429);
    const first = await inbox(refusing.url);
    const res = await first.send({ message: "hi" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "Too many requests. Try again later.", code: "feedback_not_sent" });

    // A port nothing listens on: a fake that is already stopped.
    const gone = fakeEndpoint();
    fakes.pop()!.stop(true);
    const second = await inbox(gone.url);
    const down = await second.send({ message: "hi" });
    expect(down.status).toBe(502);
    expect(((await down.json()) as { error: string }).error).toBe("Could not reach the feedback service.");
  });

  test("another site's page cannot send (the window's same-origin rule)", async () => {
    const endpoint = fakeEndpoint();
    const { send } = await inbox(endpoint.url);
    const res = await send({ message: "hi" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(endpoint.received).toHaveLength(0);
  });

  test("only POST", async () => {
    const endpoint = fakeEndpoint();
    const { server } = await inbox(endpoint.url);
    const res = await fetch(`http://127.0.0.1:${server.port}/api/inbox/feedback`);
    expect(res.status).toBe(405);
    expect(endpoint.received).toHaveLength(0);
  });
});
