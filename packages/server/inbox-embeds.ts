/**
 * Plannotator Inbox: the documents behind live HTML embeds (approval
 * "inbox-inline-html", 2026-10-28; the format and the policy are
 * @plannotator/core/html-embed). The window hands the Inbox a fence's HTML
 * and frames the document it gets back:
 *
 *   POST /api/inbox/embeds        `{ html }` → `{ id, url }`: keep the page (content-addressed)
 *   GET  /api/inbox/embeds/:id    the page, built by `buildEmbedDocument`, under `embedResponseCsp`
 *
 * Why served and not a srcdoc frame: a srcdoc inherits the window's CSP,
 * which loads nothing from the web, and the owner chose pages that may. The
 * response's own policy sandboxes the page (an opaque origin, even opened as a
 * tab of its own) and lets it load over HTTPS only, never from this server.
 *
 * The POST is a window write: the listener's cross-origin guard runs first,
 * as for every write (an opaque-origin page sends `Origin: null`, refused).
 * No serverSession: keeping a page changes nothing a stale tab could undo.
 * The GET is the frame's own navigation. On this computer the window frames
 * it from the other loopback name (`embedFrameUrl`: its own process in
 * Chromium), so its `frame-ancestors` names the window at both loopback names
 * of this port; over the tailnet it is same-origin (the listener lets that
 * through, and refuses the page's own requests, which are cross-site). Not on
 * the device door: phones do not draw embeds yet.
 *
 * A frame cannot be kept from navigating itself, so `crossSiteFrameAllowed`
 * refuses, on every listener, a cross-site frame navigation to anything but
 * an embed or an HTML page's assets: an embed sent to `/api/inbox/threads`
 * is answered 403 and nothing runs.
 *
 * Pages are kept in memory only, at most `maxEntries` and `maxBytes`, oldest
 * out first. The id is the content's hash, so a page sent twice is kept once,
 * and a frame whose page went (a restart) gets 404 until the window asks
 * again; the window always posts before it frames.
 */

import { createHash } from "node:crypto";
import { buildEmbedDocument, EMBED_ID, EMBED_MAX_BYTES, embedFrameAncestors, embedResponseCsp } from "@plannotator/core/html-embed";

export const INBOX_EMBEDS_PATH = "/api/inbox/embeds";
const EMBED_PATH = /^\/api\/inbox\/embeds\/([^/]+)$/;

/** An embed document's headers, for the address it was asked at. */
export function inboxEmbedHeaders(url: URL): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": embedResponseCsp(embedFrameAncestors(url)),
    "X-Content-Type-Options": "nosniff",
    // No Referer on the page's requests. The page can still read its own
    // address (the Inbox's port, or its tailnet name) and send it: that names
    // the Inbox, it opens nothing (see crossSiteFrameAllowed and the policy).
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    // Content-addressed: the bytes behind an id never change.
    "Cache-Control": "private, max-age=86400, immutable",
  };
}

/** Frame destinations: a request that would draw this server inside another page. */
const FRAME_DESTS = new Set(["iframe", "frame", "embed", "object", "fencedframe"]);

/**
 * Whether a request may be answered when it is a frame navigation from
 * another site (`Sec-Fetch-Dest` a frame, `Sec-Fetch-Site: cross-site`).
 * Such a request is an embed loading (the window frames its embeds from the
 * other loopback name) or an attached HTML page's own frames, or a page
 * steering a frame at the Inbox: an embed navigating itself (no policy can
 * stop that) or any website framing it. Only embeds and HTML-page assets are
 * answered; every other path is refused. Requests without fetch metadata
 * (agents, curl, the tests) and same-origin or same-site ones are untouched.
 */
export function crossSiteFrameAllowed(path: string, headers: Headers): boolean {
  if (headers.get("sec-fetch-site")?.trim().toLowerCase() !== "cross-site") return true;
  const dest = headers.get("sec-fetch-dest")?.trim().toLowerCase() ?? "";
  if (!FRAME_DESTS.has(dest)) return true;
  return path.startsWith(`${INBOX_EMBEDS_PATH}/`) || path.startsWith("/api/html-assets/");
}

export function embedIdOf(html: string): string {
  return createHash("sha256").update(html).digest("hex").slice(0, 32);
}

export function createInboxEmbeds(options: {
  readBody: (req: Request) => Promise<Record<string, unknown>>;
  json: (body: unknown, status?: number) => Response;
  maxEntries?: number;
  maxBytes?: number;
}) {
  const { json } = options;
  const maxEntries = options.maxEntries ?? 500;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  /** id → built document, oldest first (a hit moves to the end). */
  const pages = new Map<string, string>();
  let bytes = 0;

  const keep = (html: string): string => {
    const id = embedIdOf(html);
    const had = pages.get(id);
    if (had !== undefined) {
      pages.delete(id);
      pages.set(id, had);
      return id;
    }
    const page = buildEmbedDocument(html);
    pages.set(id, page);
    bytes += Buffer.byteLength(page);
    for (const [oldId, old] of pages) {
      if (pages.size <= maxEntries && bytes <= maxBytes) break;
      if (oldId === id) break;
      pages.delete(oldId);
      bytes -= Buffer.byteLength(old);
    }
    return id;
  };

  const route = async (req: Request, url: URL): Promise<Response | null> => {
    if (url.pathname === INBOX_EMBEDS_PATH) {
      if (req.method !== "POST") return json({ error: "Use POST.", code: "method_not_allowed" }, 405);
      const body = await options.readBody(req);
      if (typeof body.html !== "string" || body.html.trim() === "") {
        return json({ error: "html: the page, a non-empty string.", code: "validation_error" }, 400);
      }
      if (Buffer.byteLength(body.html) > EMBED_MAX_BYTES) {
        return json({ error: `html: at most ${EMBED_MAX_BYTES} bytes.`, code: "embed_too_large" }, 413);
      }
      const id = keep(body.html);
      return json({ id, url: `${INBOX_EMBEDS_PATH}/${id}` });
    }
    const match = EMBED_PATH.exec(url.pathname);
    if (!match) return null;
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "Use GET.", code: "method_not_allowed" }, 405);
    const id = match[1]!;
    const page = EMBED_ID.test(id) ? pages.get(id) : undefined;
    if (page === undefined) return json({ error: "No such embed.", code: "not_found" }, 404);
    return new Response(req.method === "HEAD" ? null : page, { headers: inboxEmbedHeaders(url) });
  };

  return { route, size: () => pages.size };
}
