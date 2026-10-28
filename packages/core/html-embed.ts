/**
 * Live HTML embeds: an agent's ```html fence drawn as a page inside a message
 * (approval "inbox-inline-html", 2026-10-28). Pure strings, browser-safe and
 * dependency-free: the Inbox server builds the embed's document with it, and
 * ui's `HtmlEmbedBlock` frames that document and reads its messages.
 *
 * Why a served document and not a srcdoc frame: a srcdoc (and a `data:` or
 * `blob:` frame) inherits the window's own CSP, which allows no remote
 * script, style, image or fetch, and a policy inside the frame can only
 * narrow it. The owner chose pages that may load from the web ("anything,
 * like t3code's pages"), so the embed is a document the Inbox serves with its
 * own policy (`EMBED_RESPONSE_CSP`).
 *
 * The boundary, in layers:
 * - The frame's `sandbox` is `allow-scripts` and nothing else
 *   (`EMBED_SANDBOX`): an opaque origin (no cookies, storage or parent DOM),
 *   no forms, popups, modals or top navigation. Never `allow-same-origin`.
 * - The response's CSP sandboxes the document too, so the same holds when the
 *   embed's URL is opened as a page of its own.
 * - The page loads from the web over HTTPS only (`EMBED_REMOTE_SOURCES`).
 *   That never reaches the Inbox: on this computer it answers over plain
 *   http, which no directive lists (and `'self'` is never listed). Its HTTPS
 *   faces refuse the page anyway: the tailnet listener refuses a cross-site
 *   request (an opaque origin's requests are all cross-site) and the phone
 *   door wants a phone's bearer token, which no page holds.
 * - The page speaks to the window only through `readEmbedMessage` (its
 *   height, a web link, Escape), checked against the frame's own window by
 *   the host. A link is only offered: the window shows its real address and
 *   the person opens it (`embedLinkOpenable` refuses the Inbox's own host,
 *   this computer and the private network).
 * - On this computer the frame is served from the other loopback name
 *   (`embedFrameUrl`): another site, so another process in Chromium.
 * - The host guards the keyboard (ui's `focusGuard`; bounded, not closed,
 *   where the frame shares the window's thread), and the Inbox refuses
 *   a cross-site frame navigation to its routes (an embed steering itself).
 */

/** The embed frame's sandbox. Exactly this: never `allow-same-origin` (pinned by html-embed.test.ts). */
export const EMBED_SANDBOX = "allow-scripts";

/**
 * Where an embedded page may load scripts, styles, images, fonts, media,
 * frames and fetches from: the web over HTTPS (owner, 2026-10-28). The one
 * place to narrow it: `"'none'"` makes embeds offline, or a short list of
 * hosts (`"https://cdn.jsdelivr.net https://unpkg.com"`) allows only those.
 */
export const EMBED_REMOTE_SOURCES = "https:";

/**
 * The embed document's response CSP. `'self'` is never a source: the page
 * never reaches the Inbox. `frameAncestors` names who may frame it: the
 * Inbox's own window (`embedFrameAncestors`).
 */
export function embedResponseCsp(frameAncestors = "'self'"): string {
  return [
    "sandbox allow-scripts",
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' data: blob: ${EMBED_REMOTE_SOURCES}`,
    `style-src 'unsafe-inline' data: ${EMBED_REMOTE_SOURCES}`,
    `img-src data: blob: ${EMBED_REMOTE_SOURCES}`,
    `font-src data: ${EMBED_REMOTE_SOURCES}`,
    `media-src data: blob: ${EMBED_REMOTE_SOURCES}`,
    `connect-src ${EMBED_REMOTE_SOURCES}`,
    `worker-src blob: ${EMBED_REMOTE_SOURCES}`,
    `frame-src ${EMBED_REMOTE_SOURCES}`,
    "object-src 'none'",
    "manifest-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors}`,
  ].join("; ");
}

/** The policy for an embed served at a name that is not a loopback one (the tailnet). */
export const EMBED_RESPONSE_CSP = embedResponseCsp();

/** The two loopback names the Inbox answers at; the window is on one, its embeds on the other. */
const LOOPBACK_NAMES = ["localhost", "127.0.0.1"] as const;

/**
 * Where an embed's frame loads from, given the path the Inbox answered and
 * the window's location. On this computer the window is at `localhost` (the
 * Inbox redirects its page there), and the frame is served from the OTHER
 * loopback name: another site, so Chromium runs the page in a process of its
 * own and a page that spins (a long loop, a heavy chart) cannot freeze the
 * window. WebKit shares the process either way. Anywhere else (the tailnet's
 * one HTTPS name) the frame stays on the window's origin.
 */
export function embedFrameUrl(path: string, location: { protocol: string; hostname: string; port: string }): string {
  if (location.protocol !== "http:" || !location.port) return path;
  const other = location.hostname === "localhost" ? "127.0.0.1" : location.hostname === "127.0.0.1" ? "localhost" : null;
  return other ? `http://${other}:${location.port}${path}` : path;
}

/**
 * Who may frame an embed served at `url`: at a loopback name, the Inbox's
 * window at either loopback name of this port (the window frames it from the
 * other one, `embedFrameUrl`); elsewhere its own origin.
 */
export function embedFrameAncestors(url: URL): string {
  const origins = embedLoopbackOrigins(url);
  return origins.length > 0 ? origins.join(" ") : "'self'";
}

/**
 * The Inbox's two loopback origins at the port the browser used for `url`
 * (the request's Host, which a forward such as `ssh -L` may have changed),
 * or none when `url` is not at a loopback name: the window's `frame-src` and
 * an embed's `frame-ancestors` on this computer.
 */
export function embedLoopbackOrigins(url: URL): string[] {
  if (url.protocol !== "http:" || !url.port || !(LOOPBACK_NAMES as readonly string[]).includes(url.hostname)) return [];
  return LOOPBACK_NAMES.map((name) => `http://${name}:${url.port}`);
}

/** A fence larger than this stays code (and the Inbox refuses to serve it). */
export const EMBED_MAX_BYTES = 512 * 1024;

/** The tallest an embed reports itself; a page that keeps growing stops here. */
export const EMBED_MAX_HEIGHT = 40_000;

/**
 * The host's theme tokens an embed receives as CSS variables of the same
 * name (`var(--foreground)`, `var(--chart-1)` …), with `color-scheme`.
 */
export const EMBED_THEME_TOKENS = [
  "--background",
  "--foreground",
  "--card",
  "--card-foreground",
  "--muted",
  "--muted-foreground",
  "--primary",
  "--primary-foreground",
  "--accent",
  "--accent-foreground",
  "--border",
  "--destructive",
  "--success",
  "--warning",
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
  "--font-sans",
  "--font-mono",
  "--radius",
] as const;

export type EmbedScheme = "light" | "dark";
/** `inline`: in the message, as tall as its page, never scrolling. `full`: the Full screen view, which scrolls. */
export type EmbedMode = "inline" | "full";
export interface EmbedTheme {
  vars: Record<string, string>;
  scheme: EmbedScheme;
}

/**
 * The defaults under the host's values: a theme without chart colors still
 * gets five, and a page whose host sent nothing still reads.
 */
const BASE_CSS = [
  ":root{--chart-1:#4f6bed;--chart-2:#e8833a;--chart-3:#2fa37a;--chart-4:#d64c63;--chart-5:#8b5cf6}",
  "html,body{margin:0;background:transparent}",
  "html{font-family:var(--font-sans,system-ui,sans-serif);font-size:14px;line-height:1.5;color:var(--foreground,CanvasText)}",
  // In the message the frame is as tall as its page: no inner scrolling, and
  // a page wider than the column scrolls sideways without a bar.
  "html[data-pn-embed=inline]{overflow:hidden}",
  "html[data-pn-embed=inline] body{overflow-x:auto;scrollbar-width:none}",
  "html[data-pn-embed=inline] body::-webkit-scrollbar{display:none}",
  "img,svg,canvas,video{max-width:100%}",
].join("");

/**
 * The embed's first script. It applies the theme from the URL fragment
 * before the page paints (so a dark message never flashes white), takes
 * theme changes from the parent window only, reports the page's height,
 * hands a click on a web link to the host (the sandbox opens no popups),
 * passes Escape out, and tells the host when the page's document gains focus
 * and when a key reaches it (never which key). Those two listeners are the
 * first on the window, in the capture phase, so the page's own code cannot
 * stop them: the host learns of a page that took focus where the window saw
 * nothing (from another page), and of keys that reached a page the person
 * was not using.
 */
export const EMBED_BOOTSTRAP = `(function () {
  var P = window.parent, root = document.documentElement, mode = "inline";
  var post = function (m) { m.pnEmbed = 1; try { P.postMessage(m, "*"); } catch (e) {} };
  var apply = function (t) {
    if (!t || typeof t !== "object") return;
    var v = t.vars;
    if (v && typeof v === "object") for (var k in v) if (/^--[a-z0-9-]+$/.test(k) && typeof v[k] === "string") root.style.setProperty(k, v[k]);
    if (t.scheme === "dark" || t.scheme === "light") root.style.colorScheme = t.scheme;
  };
  try {
    var m = /(?:^#|&)pn=([^&]*)/.exec(location.hash);
    if (m) { var t = JSON.parse(decodeURIComponent(m[1])); if (t && t.mode === "full") mode = "full"; apply(t); }
  } catch (e) {}
  root.setAttribute("data-pn-embed", mode);
  addEventListener("focus", function (e) { if (e.target === window) post({ kind: "focus" }); }, true);
  // Keys that type something: Tab, Escape and a modifier alone move focus or type nothing.
  addEventListener("keydown", function (e) { if (!/^(Tab|Escape|Shift|Control|Alt|AltGraph|Meta|CapsLock|Fn|FnLock|Hyper|Super|OS)$/.test(e.key)) post({ kind: "keys" }); }, true);
  // Until the person clicks the page, the window's shield lies over it and passes on what the page
  // still needs: pointer moves (hover), the first click, sideways scrolling.
  var hovered = null;
  var fire = function (el, type, d, Ctor) {
    try {
      el.dispatchEvent(new Ctor(type, { bubbles: type !== "mouseenter" && type !== "mouseleave", cancelable: true, composed: true, view: window, clientX: d.x, clientY: d.y, button: 0, buttons: type.indexOf("down") > 0 ? 1 : 0, pointerType: "mouse", isPrimary: true }));
    } catch (err) {}
  };
  var Pointer = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  var pointer = function (d) {
    var el = document.elementFromPoint(d.x, d.y);
    if (el !== hovered) {
      if (hovered) { fire(hovered, "pointerout", d, Pointer); fire(hovered, "mouseout", d, MouseEvent); }
      hovered = el;
      if (el) { fire(el, "pointerover", d, Pointer); fire(el, "mouseover", d, MouseEvent); }
    }
    if (el) { fire(el, "pointermove", d, Pointer); fire(el, "mousemove", d, MouseEvent); }
    return el;
  };
  addEventListener("message", function (e) {
    if (e.source !== P) return;
    var d = e.data;
    if (!d || d.pnEmbed !== 1) return;
    if (d.kind === "theme") apply(d);
    else if (d.kind === "pointer" && typeof d.x === "number" && typeof d.y === "number") pointer(d);
    else if (d.kind === "pointerleave" && hovered) { fire(hovered, "pointerout", { x: -1, y: -1 }, Pointer); fire(hovered, "mouseout", { x: -1, y: -1 }, MouseEvent); hovered = null; }
    else if (d.kind === "click" && typeof d.x === "number" && typeof d.y === "number") {
      var el = pointer(d);
      if (!el) return;
      fire(el, "pointerdown", d, Pointer); fire(el, "mousedown", d, MouseEvent);
      if (typeof el.focus === "function") el.focus();
      fire(el, "pointerup", d, Pointer); fire(el, "mouseup", d, MouseEvent);
      if (typeof el.click === "function") el.click();
    } else if (d.kind === "scroll" && typeof d.dx === "number" && document.body) document.body.scrollLeft += d.dx;
  });
  var last = -1;
  var send = function () {
    var b = document.body;
    var h = Math.ceil(Math.max(root.getBoundingClientRect().height, b ? b.scrollHeight : 0));
    if (h !== last) { last = h; post({ kind: "height", height: h }); }
  };
  if (typeof ResizeObserver === "function") {
    var ro = new ResizeObserver(send);
    ro.observe(root);
    document.addEventListener("DOMContentLoaded", function () { if (document.body) ro.observe(document.body); send(); });
  }
  addEventListener("load", send);
  setTimeout(send, 0);
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a || e.defaultPrevented) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#") return;
    e.preventDefault();
    if (/^https?:\\/\\//i.test(href)) post({ kind: "link", url: href });
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !e.defaultPrevented) post({ kind: "escape" });
  });
})();`;

/** A doctype (after any comments) at the very start of the page: ours replaces it. */
const LEADING_DOCTYPE = /^\s*(?:<!--[\s\S]*?-->\s*)*<!doctype[^>]*>/i;

/**
 * The document the Inbox serves for one fence: our head first (charset, the
 * defaults, the bootstrap), then the agent's HTML as written. A fragment
 * lands in the body; a whole document's `<html>`, `<head>` and `<body>` merge
 * into ours (the HTML parser folds a second `<html>` and `<head>` in), so the
 * bootstrap always runs before any of the page's own code.
 */
export function buildEmbedDocument(html: string): string {
  const page = html.replace(LEADING_DOCTYPE, "");
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style>${BASE_CSS}</style><script>${EMBED_BOOTSTRAP}</script>` +
    page
  );
}

/** The fragment that hands the embed its theme and mode before it paints (`#pn=…`). */
export function embedFragment(theme: EmbedTheme, mode: EmbedMode = "inline"): string {
  return `#pn=${encodeURIComponent(JSON.stringify({ vars: theme.vars, scheme: theme.scheme, mode }))}`;
}

/** A message the host sends an embed: a theme change, applied without a reload. */
export function embedThemeMessage(theme: EmbedTheme): { pnEmbed: 1; kind: "theme"; vars: Record<string, string>; scheme: EmbedScheme } {
  return { pnEmbed: 1, kind: "theme", vars: theme.vars, scheme: theme.scheme };
}

/** What the window's shield passes on to the page (coordinates in the frame's own pixels). */
export type EmbedShieldMessage =
  | { pnEmbed: 1; kind: "pointer"; x: number; y: number }
  | { pnEmbed: 1; kind: "pointerleave" }
  | { pnEmbed: 1; kind: "click"; x: number; y: number }
  | { pnEmbed: 1; kind: "scroll"; dx: number };

export type EmbedMessage =
  | { kind: "height"; height: number }
  | { kind: "link"; url: string }
  | { kind: "escape" }
  /** The page's document gained focus. */
  | { kind: "focus" }
  /** A key reached the page (which key is never sent). */
  | { kind: "keys" };

/**
 * A message from an embed, checked; null for anything else. The caller has
 * already checked that it came from its own frame (`event.source`).
 */
export function readEmbedMessage(data: unknown): EmbedMessage | null {
  if (!data || typeof data !== "object" || (data as { pnEmbed?: unknown }).pnEmbed !== 1) return null;
  const m = data as Record<string, unknown>;
  if (m.kind === "height" && typeof m.height === "number" && Number.isFinite(m.height)) {
    return { kind: "height", height: Math.max(0, Math.min(EMBED_MAX_HEIGHT, Math.round(m.height))) };
  }
  if (m.kind === "link" && typeof m.url === "string" && m.url.length <= 4096 && /^https?:\/\/[^\s]+$/i.test(m.url)) {
    return { kind: "link", url: m.url };
  }
  if (m.kind === "escape") return { kind: "escape" };
  if (m.kind === "focus") return { kind: "focus" };
  if (m.kind === "keys") return { kind: "keys" };
  return null;
}

/** An IPv4 address on this computer or a private network (loopback, RFC 1918, link-local, CGNAT, unspecified). */
function privateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Name endings that are this computer, the local network or the person's tailnet, never the web. */
const PRIVATE_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".localdomain", ".ts.net", ".intranet", ".corp", ".home"];

/**
 * The link a page handed over, as the window offers it: the address the
 * browser would open (`new URL(raw).href`: tabs and newlines dropped, an
 * international name in its punycode form, so what the person reads is what
 * opens), or null when it is never offered. Never: anything but http(s), an
 * address with credentials, the Inbox's own host at any port or scheme, a
 * name without a dot (`intranet`, `localhost`), a `localhost` or local
 * network name (`PRIVATE_SUFFIXES`, the person's other tailnet machines
 * included), a loopback, private, link-local or CGNAT address, or an IPv6
 * literal. A public name that resolves to this computer (`*.nip.io`) cannot
 * be told by its name; the Inbox's host guard refuses those.
 */
export function embedLinkOffer(raw: string, windowHostname: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host || host === windowHostname.toLowerCase().replace(/\.+$/, "")) return null;
  if (host.startsWith("[") || !host.includes(".")) return null;
  if (host === "localhost" || PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return null;
  if (privateIpv4(host)) return null;
  return url.href;
}

/** Whether `embedLinkOffer` offers the link at all. */
export function embedLinkOpenable(raw: string, windowHostname: string): boolean {
  return embedLinkOffer(raw, windowHostname) !== null;
}

/** The id the Inbox gives an embed: the first 32 hex digits of the SHA-256 of its HTML. */
export const EMBED_ID = /^[a-f0-9]{32}$/;
