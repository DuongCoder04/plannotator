/**
 * Who sent a request to a session published with `--tailscale` (#2166), for
 * "Ask this session", the one surface such a session keeps for this machine
 * and its owner only.
 *
 * A `--tailscale` session stays loopback-bound; `tailscale serve` proxies the
 * tailnet port to it. What serve guarantees (ipn/ipnlocal/serve.go, the
 * reasoning `inbox/tailnet.ts` records): every request it proxies carries
 * `X-Forwarded-For` with the peer's address, and before proxying it DELETES
 * any incoming `Tailscale-User-Login` / `Tailscale-Headers-Info` /
 * `Tailscale-Funnel-Request` and sets its own. So a request that came through
 * serve can never look local (it cannot shed those headers), and the login it
 * carries is the one Tailscale's own WhoIs gave. Host is never evidence: serve
 * passes the browser's Host through.
 *
 *  - `local`: no mark of serve. It reached the loopback port from this
 *    machine, the same as any local session (a local process could add the
 *    headers, but it can reach the port anyway).
 *  - `owner`: through serve, not funnel, and the login is the one that owns
 *    this machine (`tailscale status --json`, Self.UserID -> LoginName).
 *  - `peer`: through serve and anything else (another login, a tagged device
 *    with no login, a funnel request, or an owner nobody could read).
 *
 * The same marks the Inbox's window port refuses (#1867: a local reverse
 * proxy that sends only loopback `X-Forwarded-For` reads as local).
 */

import { checkTailnetIdentity, normalizeTailnetLogin, TAILSCALE_FUNNEL_HEADER, TAILSCALE_LOGIN_HEADER } from "./inbox/tailnet";
import { isLoopbackForwardedFor } from "./loopback-host";

export type TailnetAudience = "local" | "owner" | "peer";

/** Headers only `tailscale serve` sets on a request it proxies (and deletes from what a client sent). */
const SERVE_HEADERS = [TAILSCALE_LOGIN_HEADER, "tailscale-headers-info", TAILSCALE_FUNNEL_HEADER] as const;

/** Whether a request carries a mark of `tailscale serve` (or of another proxy that forwards a non-loopback client). */
export function cameThroughTailscaleServe(headers: Headers): boolean {
  if (SERVE_HEADERS.some((name) => headers.has(name))) return true;
  const forwardedFor = headers.get("x-forwarded-for");
  return forwardedFor !== null && !isLoopbackForwardedFor(forwardedFor);
}

/** Who a request is from, for a session whose machine is owned by `ownerLogin` (null: nobody could say). */
export function tailnetAudience(headers: Headers, ownerLogin: string | null): TailnetAudience {
  if (!cameThroughTailscaleServe(headers)) return "local";
  if (!ownerLogin) return "peer";
  return checkTailnetIdentity(headers, [normalizeTailnetLogin(ownerLogin)]).ok ? "owner" : "peer";
}
