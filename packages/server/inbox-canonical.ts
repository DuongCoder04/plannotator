/**
 * One origin for the Inbox window.
 *
 * A browser keeps its notification permission (and cookies and storage) per
 * origin, and `http://127.0.0.1:<port>` and `http://localhost:<port>` are two
 * origins for the same server. The Inbox advertises and opens localhost by
 * default, or the configured *.localhost hostname, so its links and window
 * use the same notification permission and preference cookies. A page loaded
 * at another loopback spelling of THIS port (`127.x.y.z`, `[::1]`, localhost)
 * is sent to that canonical address.
 *
 * Only a browser's top-level navigation to `/` is redirected (`Sec-Fetch-Mode:
 * navigate` and `Sec-Fetch-Dest: document`), so APIs, the event stream, the
 * device door, MCP, connection routes and any client without fetch metadata
 * (curl, the tests' fetches) are answered where they asked. The tailnet
 * listener never gets here (its requests carry `via: "tailnet"`), and any name
 * that is not a loopback literal (`inbox.plannotator.localhost`, a
 * `PLANNOTATOR_ALLOWED_HOSTS` name) is left alone, so a proxy that rewrites
 * Host to a name never loops. The fragment (`#thread=…`) is kept by the
 * browser across the redirect; the query is carried in `Location`. 307 and
 * `no-store`: never cached, since another server may hold this port later.
 */

import { loadConfig, resolveUrlHost } from "@plannotator/shared/config";
import { isLocalhostHostname, isLoopbackHostHeader } from "@plannotator/shared/loopback-host";

/** Default hostname when no local advertised-URL override is configured. */
export const INBOX_CANONICAL_HOSTNAME = "localhost";

/** The Inbox stays local, but can share the dedicated preference hostname. */
export function inboxCanonicalBaseUrl(port: number): string {
  const override = resolveUrlHost(loadConfig());
  const hostname = override && isLocalhostHostname(override) ? override : INBOX_CANONICAL_HOSTNAME;
  return `http://${hostname}:${port}/`;
}

/**
 * The redirect for a top-level navigation of `/` that reached this port by a
 * loopback literal (`127.x.y.z`, `[::1]`), or null to answer the request as it is.
 * Use the startup base URL shared by the registry and generated links, not live config.
 */
export function inboxCanonicalRedirect(req: Request, url: URL, canonicalBaseUrl: string, via: "local" | "tailnet"): Response | null {
  if (via !== "local") return null;
  if (req.method !== "GET" || url.pathname !== "/") return null;
  if (req.headers.get("sec-fetch-mode") !== "navigate" || req.headers.get("sec-fetch-dest") !== "document") return null;
  const target = new URL(canonicalBaseUrl);
  const port = Number(target.port);
  const host = req.headers.get("host");
  if (!host || !isLoopbackHostHeader(host, port)) return null;
  // Leave named proxies alone, including localhost subdomains.
  if (host.trim().toLowerCase().endsWith(`.localhost:${port}`)) return null;
  if (target.host === host.trim().toLowerCase()) return null;
  return new Response(null, {
    status: 307,
    headers: {
      Location: `${target.href}${url.search}`,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
