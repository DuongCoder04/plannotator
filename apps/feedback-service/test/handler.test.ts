/**
 * The feedback Worker's handler against an in-memory store (no wrangler, no
 * Cloudflare account, no network): one route that only writes, strict
 * validation, a bounded JSON body, the per-IP limits, the origin rule, and an
 * answer that carries no data.
 */
import { describe, expect, test } from "bun:test";
import { FEEDBACK_PATH, handleRequest, MAX_BODY_BYTES, type HandlerDeps, type RateLimiter } from "../core/handler";
import type { FeedbackEntry, FeedbackStore } from "../core/storage";
import { createThrottle } from "../core/throttle";

class MemoryStore implements FeedbackStore {
  rows: FeedbackEntry[] = [];
  fail = false;
  async insert(entry: FeedbackEntry): Promise<void> {
    if (this.fail) throw new Error("db down");
    this.rows.push(entry);
  }
}

const URL_BASE = "https://feedback.example";

function deps(overrides: Partial<HandlerDeps> = {}): HandlerDeps & { store: MemoryStore } {
  return {
    store: new MemoryStore(),
    throttle: createThrottle({ limit: 100, windowMs: 60_000 }),
    ip: "203.0.113.7",
    now: () => new Date("2026-10-27T12:00:00.000Z"),
    ...overrides,
  } as HandlerDeps & { store: MemoryStore };
}

function post(body: unknown, init: { headers?: Record<string, string>; path?: string; raw?: string } = {}): Request {
  return new Request(`${URL_BASE}${init.path ?? FEEDBACK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
}

describe("the one route", () => {
  test("a valid POST is saved and answered with only {ok:true}", async () => {
    const d = deps();
    const res = await handleRequest(
      post({ message: "  The sidebar is great  ", category: "idea", contact: "me@example.com", version: "0.28.33", os: "macOS", surface: "inbox" }),
      d,
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
    expect(d.store.rows).toEqual([
      { message: "The sidebar is great", category: "idea", contact: "me@example.com", version: "0.28.33", os: "macOS", surface: "inbox", created_at: "2026-10-27T12:00:00.000Z" },
    ]);
    // Nothing identifying is stored: the IP the Worker saw is not in the row.
    expect(JSON.stringify(d.store.rows)).not.toContain("203.0.113.7");
    // No cookie is ever set.
    expect(res.headers.get("Set-Cookie")).toBeNull();
  });

  test("only the message is required: no email, no category, no version is a 201", async () => {
    const d = deps();
    const res = await handleRequest(post({ message: "hi" }), d);
    expect(res.status).toBe(201);
    expect(d.store.rows[0]).toMatchObject({ message: "hi", category: null, contact: null, version: null, os: null, surface: null });
  });

  test("every other path is 404 and every other method on /feedback is 405; neither reads or writes", async () => {
    const d = deps();
    for (const path of ["/", "/feedback/1", "/admin/list", "/health", "/feedbacks", "/feedback.json"]) {
      for (const method of ["GET", "POST", "DELETE"]) {
        const res = await handleRequest(new Request(`${URL_BASE}${path}`, { method, ...(method === "POST" ? { body: "{}", headers: { "Content-Type": "application/json" } } : {}) }), d);
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: "Not found" });
      }
    }
    for (const method of ["GET", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const res = await handleRequest(new Request(`${URL_BASE}${FEEDBACK_PATH}`, { method }), d);
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST, OPTIONS");
    }
    expect(d.store.rows).toHaveLength(0);
  });

  test("a store failure is a 500 with no detail", async () => {
    const d = deps();
    d.store.fail = true;
    const res = await handleRequest(post({ message: "hi" }), d);
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("db down");
  });
});

describe("validation", () => {
  const cases: [string, unknown][] = [
    ["no message", {}],
    ["an empty message", { message: "   " }],
    ["a message that is not a string", { message: 42 }],
    ["a message over 4000 characters", { message: "x".repeat(4001) }],
    ["an unknown field", { message: "hi", ip: "1.2.3.4" }],
    ["an unknown category", { message: "hi", category: "rant" }],
    ["an unknown surface", { message: "hi", surface: "browser" }],
    ["a contact over 200 characters", { message: "hi", contact: "c".repeat(201) }],
    ["a version that is not a label", { message: "hi", version: "<script>" }],
    ["a long os", { message: "hi", os: "o".repeat(41) }],
    ["an array body", [{ message: "hi" }]],
    ["a JSON string", "hi"],
  ];
  for (const [name, body] of cases) {
    test(`refuses ${name} with 400 and writes nothing`, async () => {
      const d = deps();
      const res = await handleRequest(post(body), d);
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { error: unknown }).error).toBe("string");
      expect(d.store.rows).toHaveLength(0);
    });
  }

  test("4000 characters (emoji counted once) is accepted", async () => {
    const d = deps();
    const res = await handleRequest(post({ message: "🙂".repeat(4000) }), d);
    expect(res.status).toBe(201);
  });

  test("control characters are stripped, newlines kept", async () => {
    const d = deps();
    await handleRequest(post({ message: "line one\u0000\nline two\u0007" }), d);
    expect(d.store.rows[0]!.message).toBe("line one\nline two");
  });
});

describe("body", () => {
  test("only JSON: another Content-Type is 415", async () => {
    const d = deps();
    const res = await handleRequest(post(null, { raw: "message=hi", headers: { "Content-Type": "application/x-www-form-urlencoded" } }), d);
    expect(res.status).toBe(415);
    expect(d.store.rows).toHaveLength(0);
  });

  test("malformed JSON is 400", async () => {
    const res = await handleRequest(post(null, { raw: "{\"message\":" }), deps());
    expect(res.status).toBe(400);
  });

  test("a body over 16 KB is 413, by its declared length or by what arrives", async () => {
    const d = deps();
    const big = JSON.stringify({ message: "x".repeat(MAX_BODY_BYTES) });
    expect((await handleRequest(post(null, { raw: big }), d)).status).toBe(413);
    // A stream with no Content-Length is cut off at the cap too.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(big));
        controller.close();
      },
    });
    const streamed = new Request(`${URL_BASE}${FEEDBACK_PATH}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: stream });
    expect(streamed.headers.get("Content-Length")).toBeNull();
    expect((await handleRequest(streamed, d)).status).toBe(413);
    expect(d.store.rows).toHaveLength(0);
  });
});

describe("origins", () => {
  test("no Origin (the Inbox's server, the CLI) is allowed and gets no CORS headers", async () => {
    const res = await handleRequest(post({ message: "hi" }), deps());
    expect(res.status).toBe(201);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("loopback and tailnet origins are allowed, with CORS for that origin and never credentials", async () => {
    for (const origin of ["http://localhost:59812", "http://127.0.0.1:3000", "http://[::1]:8080", "https://mac.tail1234.ts.net", "https://mac.tail1234.ts.net:8443"]) {
      const res = await handleRequest(post({ message: "hi" }, { headers: { Origin: origin } }), deps());
      expect(res.status).toBe(201);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    }
  });

  test("a preflight from an allowed origin is 204; any other origin is 403 and writes nothing", async () => {
    const pre = await handleRequest(new Request(`${URL_BASE}${FEEDBACK_PATH}`, { method: "OPTIONS", headers: { Origin: "http://localhost:59812" } }), deps());
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    const d = deps();
    for (const origin of ["https://evil.example", "null", "http://localhost.evil.example", "https://ts.net.evil.example", "http://mac.tail1234.ts.net"]) {
      const res = await handleRequest(post({ message: "hi" }, { headers: { Origin: origin } }), d);
      expect(res.status).toBe(403);
    }
    expect(d.store.rows).toHaveLength(0);
  });

  test("ALLOWED_ORIGINS adds an origin", async () => {
    const res = await handleRequest(post({ message: "hi" }, { headers: { Origin: "https://plannotator.ai" } }), deps({ extraOrigins: ["https://plannotator.ai"] }));
    expect(res.status).toBe(201);
  });
});

describe("abuse limits", () => {
  test("the per-IP throttle answers 429 past its limit, per IP", async () => {
    const d = deps({ throttle: createThrottle({ limit: 2, windowMs: 60_000 }) });
    expect((await handleRequest(post({ message: "1" }), d)).status).toBe(201);
    expect((await handleRequest(post({ message: "2" }), d)).status).toBe(201);
    expect((await handleRequest(post({ message: "3" }), d)).status).toBe(429);
    expect((await handleRequest(post({ message: "4" }), { ...d, ip: "198.51.100.1" })).status).toBe(201);
    expect(d.store.rows.map((r) => r.message)).toEqual(["1", "2", "4"]);
  });

  test("the throttle forgets a key after its window", () => {
    let now = 0;
    const throttle = createThrottle({ limit: 1, windowMs: 1000, now: () => now });
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.allow("a")).toBe(false);
    now = 1000;
    expect(throttle.allow("a")).toBe(true);
  });

  test("the throttle holds at most maxKeys keys", () => {
    const throttle = createThrottle({ limit: 1, windowMs: 60_000, maxKeys: 2 });
    throttle.allow("a");
    throttle.allow("b");
    throttle.allow("c"); // forgets "a"
    expect(throttle.allow("a")).toBe(true);
    expect(throttle.allow("c")).toBe(false);
  });

  test("the Cloudflare rate-limit binding, keyed by IP, answers 429 before the body is read", async () => {
    const keys: string[] = [];
    const limiter: RateLimiter = {
      async limit({ key }) {
        keys.push(key);
        return { success: false };
      },
    };
    const d = deps({ rateLimiter: limiter });
    // Malformed JSON: a 429 (not a 400) proves the limit runs first.
    const res = await handleRequest(post(null, { raw: "{" }), d);
    expect(res.status).toBe(429);
    expect(keys).toEqual(["203.0.113.7"]);
    expect(d.store.rows).toHaveLength(0);
  });

  test("a failing rate-limit binding fails open (the throttle still applies)", async () => {
    const limiter: RateLimiter = {
      async limit() {
        throw new Error("binding down");
      },
    };
    const res = await handleRequest(post({ message: "hi" }), deps({ rateLimiter: limiter }));
    expect(res.status).toBe(201);
  });
});
