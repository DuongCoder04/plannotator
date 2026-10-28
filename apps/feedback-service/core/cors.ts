// Which browser origins may POST feedback, and the CORS headers they get.
//
// The Inbox sends feedback from its own local server (no Origin header), and
// `plannotator feedback` sends it from the CLI (no Origin either), so most
// requests carry none: those are allowed. A request that does carry an Origin
// must be a Plannotator page: this computer (localhost, 127.0.0.1, [::1], any
// port) or a tailnet name (https://<machine>.<tailnet>.ts.net). CORS only
// limits what a browser lets a page do; it is not authentication.

const LOOPBACK_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;
const TAILNET_RE = /^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.ts\.net(?::\d{1,5})?$/;

/** Extra origins from `ALLOWED_ORIGINS` (comma separated). Empty: loopback and tailnet only. */
export function parseExtraOrigins(envValue?: string): string[] {
  if (!envValue) return [];
  return envValue
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin && origin !== "*");
}

export function isAllowedOrigin(origin: string, extra: readonly string[] = []): boolean {
  return LOOPBACK_RE.test(origin) || TAILNET_RE.test(origin) || extra.includes(origin);
}

/** The CORS headers for an allowed Origin; none without one. Never credentials. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
