/**
 * The live HTML embed's boundary (approval "inbox-inline-html"). What
 * regresses if these fail:
 * - the frame gains `allow-same-origin` (or any other sandbox token): the
 *   page would share the Inbox's origin and could read and write its API;
 * - the document's own policy stops sandboxing it, lists `'self'` or plain
 *   http (the Inbox on this computer), or lets it post a form;
 * - the bootstrap no longer runs before the agent's own markup, so a page
 *   that writes a doctype, `<html>` or `<head>` would paint before the theme;
 * - the message reader accepts something other than a height, a web link or
 *   Escape, or an unbounded height;
 * - the frame is no longer served from the other loopback name (a busy page
 *   would freeze the window in Chromium), or is served there to a window at
 *   another name;
 * - a page's link to the Inbox, this computer or the private network is
 *   offered to the person;
 * - the bootstrap acts on a click, pointer move or theme from any window but
 *   the Inbox's (another embed could click this page's buttons).
 */
import { describe, expect, test } from "bun:test";
import {
  buildEmbedDocument,
  EMBED_BOOTSTRAP,
  EMBED_MAX_HEIGHT,
  EMBED_REMOTE_SOURCES,
  EMBED_RESPONSE_CSP,
  EMBED_SANDBOX,
  embedFragment,
  embedFrameAncestors,
  embedFrameUrl,
  embedLinkOffer,
  embedLinkOpenable,
  embedLoopbackOrigins,
  embedResponseCsp,
  readEmbedMessage,
} from "./html-embed";

const directives = new Map(
  EMBED_RESPONSE_CSP.split(";").map((part) => {
    const [name, ...values] = part.trim().split(/\s+/);
    return [name!, values] as const;
  }),
);

describe("the embed's sandbox and policy", () => {
  test("the frame's sandbox is allow-scripts and nothing else (never widen it)", () => {
    // Pinned on purpose: any added token (allow-same-origin above all) is a security decision, not a refactor.
    expect(EMBED_SANDBOX).toBe("allow-scripts");
  });

  test("the response sandboxes the document the same way, so its URL opened as a tab is opaque too", () => {
    expect(directives.get("sandbox")).toEqual(["allow-scripts"]);
  });

  test("no directive lets the page reach the Inbox: no 'self', no plain http, no wildcard", () => {
    for (const [name, values] of directives) {
      if (name === "frame-ancestors") continue;
      expect(values).not.toContain("'self'");
      expect(values.some((value) => /^http:/i.test(value) || value === "*")).toBe(false);
    }
    // The web over HTTPS is the owner's choice (2026-10-28); `connect-src` is exactly that.
    expect(directives.get("connect-src")).toEqual([EMBED_REMOTE_SOURCES]);
  });

  test("the page posts no form, sets no base, embeds no plugin, and only the Inbox's own window may frame it", () => {
    expect(directives.get("form-action")).toEqual(["'none'"]);
    expect(directives.get("base-uri")).toEqual(["'none'"]);
    expect(directives.get("object-src")).toEqual(["'none'"]);
    expect(directives.get("default-src")).toEqual(["'none'"]);
    expect(directives.get("frame-ancestors")).toEqual(["'self'"]);
  });
});

/** Run the bootstrap against a stand-in page; returns what reached its element and the message handler. */
function runBootstrap() {
  const posted: unknown[] = [];
  const parent = { postMessage: (message: unknown) => posted.push(message) };
  const seen: string[] = [];
  const el = {
    dispatchEvent(event: { type: string }) {
      seen.push(event.type);
      return true;
    },
    focus() {
      seen.push("focus()");
    },
    click() {
      seen.push("click()");
    },
  };
  const themed: string[] = [];
  const root = {
    style: { setProperty: (name: string) => themed.push(name), colorScheme: "" },
    setAttribute() {},
    getBoundingClientRect: () => ({ height: 0 }),
  };
  const doc = { documentElement: root, body: null, elementFromPoint: () => el, addEventListener() {} };
  let onMessage: ((event: { source: unknown; data: unknown }) => void) | null = null;
  const windowListeners: { type: string; capture: boolean; handler: (event: { target?: unknown; key?: string }) => void }[] = [];
  const self = { parent };
  const listen = (type: string, handler: (event: never) => void, capture?: boolean) => {
    windowListeners.push({ type, capture: capture === true, handler: handler as (event: { target?: unknown; key?: string }) => void });
    if (type === "message") onMessage = handler as (event: { source: unknown; data: unknown }) => void;
  };
  class FakeEvent {
    constructor(public type: string) {}
  }
  new Function("window", "document", "location", "addEventListener", "setTimeout", "ResizeObserver", "PointerEvent", "MouseEvent", EMBED_BOOTSTRAP)(
    self,
    doc,
    { hash: "" },
    listen,
    () => 0,
    undefined,
    FakeEvent,
    FakeEvent,
  );
  return { parent, self, seen, themed, posted, windowListeners, send: (source: unknown, data: unknown) => onMessage!({ source, data }) };
}

describe("the bootstrap takes the shield's forwarding from the Inbox's window only", () => {
  test("a click, pointer move or theme from another window (another embed) does nothing", () => {
    const page = runBootstrap();
    const other = {};
    page.send(other, { pnEmbed: 1, kind: "click", x: 5, y: 5 });
    page.send(other, { pnEmbed: 1, kind: "pointer", x: 5, y: 5 });
    page.send(other, { pnEmbed: 1, kind: "theme", vars: { "--foreground": "red" }, scheme: "dark" });
    expect(page.seen).toEqual([]);
    expect(page.themed).toEqual([]);
  });

  test("the same click from the Inbox's window reaches the element under it", () => {
    const page = runBootstrap();
    page.send(page.parent, { pnEmbed: 1, kind: "click", x: 5, y: 5 });
    expect(page.seen).toContain("click()");
    expect(page.seen).toContain("focus()");
  });
});

describe("the bootstrap reports focus and keys, first, where the page cannot stop it", () => {
  test("its document gaining focus and every key are reported (never which key), by the first window listeners, in the capture phase", () => {
    const page = runBootstrap();
    const first = page.windowListeners.slice(0, 2);
    expect(first.map(({ type, capture }) => [type, capture])).toEqual([
      ["focus", true],
      ["keydown", true],
    ]);
    first[0]!.handler({ target: {} }); // an element's focus passing through: not the document's
    first[0]!.handler({ target: page.self });
    first[1]!.handler({ target: {}, key: "a" } as never);
    // Tab, Escape and a modifier alone type nothing: not reported (a Tab out of a page arrives after it left).
    for (const key of ["Tab", "Escape", "Shift", "Meta"]) first[1]!.handler({ target: {}, key } as never);
    expect(page.posted).toEqual([
      { kind: "focus", pnEmbed: 1 },
      { kind: "keys", pnEmbed: 1 },
    ]);
  });
});

describe("buildEmbedDocument", () => {
  const ourHead = (doc: string) => doc.indexOf(EMBED_BOOTSTRAP);

  test("a fragment lands after the bootstrap", () => {
    const doc = buildEmbedDocument('<div id="chart"></div><script>draw()</script>');
    expect(ourHead(doc)).toBeGreaterThan(0);
    expect(doc.indexOf('<div id="chart">')).toBeGreaterThan(ourHead(doc));
  });

  test("a whole document's doctype is replaced by ours, and its own head comes after the bootstrap", () => {
    const page = "<!-- chart -->\n<!DOCTYPE html>\n<html lang=\"en\"><head><script>early()</script></head><body>x</body></html>";
    const doc = buildEmbedDocument(page);
    expect(doc.match(/<!doctype/gi)).toHaveLength(1);
    expect(doc.startsWith("<!doctype html>")).toBe(true);
    expect(doc.indexOf("early()")).toBeGreaterThan(ourHead(doc));
  });

  test("the page's own markup is kept as written", () => {
    const page = "<style>.bar{fill:var(--chart-1)}</style><svg><rect class=bar /></svg>";
    expect(buildEmbedDocument(page).endsWith(page)).toBe(true);
  });
});

describe("the theme fragment", () => {
  test("round-trips the theme and mode the bootstrap reads", () => {
    const fragment = embedFragment({ vars: { "--foreground": "oklch(0.2 0 0)", "--font-sans": '"Inter", sans-serif' }, scheme: "dark" }, "full");
    const raw = /^#pn=(.*)$/.exec(fragment)![1]!;
    expect(raw).not.toMatch(/[#&\s]/);
    expect(JSON.parse(decodeURIComponent(raw))).toEqual({
      vars: { "--foreground": "oklch(0.2 0 0)", "--font-sans": '"Inter", sans-serif' },
      scheme: "dark",
      mode: "full",
    });
  });
});

describe("readEmbedMessage", () => {
  test("a height is rounded and kept within bounds", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: 212.4 })).toEqual({ kind: "height", height: 212 });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: 1e9 })).toEqual({ kind: "height", height: EMBED_MAX_HEIGHT });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: -5 })).toEqual({ kind: "height", height: 0 });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "height", height: Number.NaN })).toBeNull();
  });

  test("only web links are handed over", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "link", url: "https://example.com/a" })).toEqual({ kind: "link", url: "https://example.com/a" });
    for (const url of ["javascript:alert(1)", "/api/inbox/threads", "file:///etc/passwd", "https://a b", `https://x/${"a".repeat(5000)}`]) {
      expect(readEmbedMessage({ pnEmbed: 1, kind: "link", url })).toBeNull();
    }
  });

  test("anything else is ignored", () => {
    expect(readEmbedMessage({ pnEmbed: 1, kind: "escape" })).toEqual({ kind: "escape" });
    expect(readEmbedMessage({ pnEmbed: 1, kind: "focus" })).toEqual({ kind: "focus" });
    // A key report never carries which key, whatever the page sends.
    expect(readEmbedMessage({ pnEmbed: 1, kind: "keys", key: "a" })).toEqual({ kind: "keys" });
    for (const data of [null, "height", { kind: "height", height: 10 }, { pnEmbed: 2, kind: "escape" }, { pnEmbed: 1, kind: "navigate", url: "https://x" }]) {
      expect(readEmbedMessage(data)).toBeNull();
    }
  });
});

describe("where the frame loads from", () => {
  const at = (hostname: string, port = "54321", protocol = "http:") => ({ protocol, hostname, port });

  test("a window on one loopback name frames its embeds from the other (another site: its own process)", () => {
    expect(embedFrameUrl("/api/inbox/embeds/abc", at("localhost"))).toBe("http://127.0.0.1:54321/api/inbox/embeds/abc");
    expect(embedFrameUrl("/api/inbox/embeds/abc", at("127.0.0.1"))).toBe("http://localhost:54321/api/inbox/embeds/abc");
  });

  test("anywhere else the frame stays on the window's origin", () => {
    expect(embedFrameUrl("/api/inbox/embeds/abc", at("macbook.tail0000.ts.net", "443", "https:"))).toBe("/api/inbox/embeds/abc");
    expect(embedFrameUrl("/api/inbox/embeds/abc", at("inbox.plannotator.localhost"))).toBe("/api/inbox/embeds/abc");
    expect(embedFrameUrl("/api/inbox/embeds/abc", at("localhost", ""))).toBe("/api/inbox/embeds/abc");
  });

  test("an embed at a loopback name may be framed by the window at either loopback name of that port, and nothing else", () => {
    const ancestors = embedFrameAncestors(new URL("http://127.0.0.1:54321/api/inbox/embeds/abc"));
    expect(ancestors.split(" ").sort()).toEqual(["http://127.0.0.1:54321", "http://localhost:54321"]);
    expect(embedResponseCsp(ancestors)).toContain(`frame-ancestors ${ancestors}`);
    expect(embedFrameAncestors(new URL("https://macbook.tail0000.ts.net:8443/api/inbox/embeds/abc"))).toBe("'self'");
  });

  test("the loopback origins follow the port the browser used (a forward), not the one the Inbox listens on", () => {
    expect(embedLoopbackOrigins(new URL("http://localhost:61000/"))).toEqual(["http://localhost:61000", "http://127.0.0.1:61000"]);
    expect(embedLoopbackOrigins(new URL("https://macbook.tail0000.ts.net/"))).toEqual([]);
    expect(embedLoopbackOrigins(new URL("http://[::1]:61000/"))).toEqual([]);
  });
});

describe("embedLinkOpenable", () => {
  test("a web address elsewhere is offered", () => {
    for (const url of ["https://example.com/docs", "http://example.com/a?b=1", "https://cdn.example.test/x"]) {
      expect(embedLinkOpenable(url, "localhost")).toBe(true);
    }
  });

  test("the Inbox's own host, this computer and the private network are never offered", () => {
    for (const url of [
      "http://localhost:54321/api/inbox/threads",
      "http://127.0.0.1:54321/api/inbox/threads",
      "http://127.9.9.9/",
      "http://[::1]:54321/",
      "http://0.0.0.0:54321/",
      "http://inbox.plannotator.localhost/",
      "http://10.0.0.5/",
      "http://172.20.1.1/",
      "http://192.168.1.10/router",
      "http://169.254.169.254/latest/meta-data",
      "http://100.101.102.103/",
      "http://printer.local/",
      "http://localhost../",
      "http://LOCALHOST.../x",
      "https://intranet/",
      "http://ip6-localhost/",
      "http://printer.lan/",
      "http://router.home.arpa/",
      "http://localhost.localdomain/",
      "https://other-mac.tail0000.ts.net/",
      "https://user:pass@example.com/",
      "javascript:alert(1)",
      "not a url",
    ]) {
      expect(embedLinkOpenable(url, "localhost")).toBe(false);
    }
    // Over the tailnet the window's own name is the Inbox: refused at any port or scheme.
    expect(embedLinkOpenable("https://macbook.tail0000.ts.net/api/inbox/threads", "macbook.tail0000.ts.net")).toBe(false);
    expect(embedLinkOpenable("http://MACBOOK.tail0000.ts.net.:80/", "macbook.tail0000.ts.net")).toBe(false);
  });

  test("what is offered is the address that opens: parsed, in punycode, with nothing hidden", () => {
    // Reads as example.com, opens evil.com: shown as it opens.
    expect(embedLinkOffer("https://evil.com\\@example.com", "localhost")).toBe("https://evil.com/@example.com");
    // A Cyrillic "а": shown in its punycode form.
    expect(embedLinkOffer("https://\u0430pple.com/", "localhost")).toBe("https://xn--pple-43d.com/");
    expect(embedLinkOffer("https://exa\tmple.com/a b", "localhost")).toBe("https://example.com/a%20b");
  });
});
