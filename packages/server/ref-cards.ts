/**
 * Hover cards for issue, pull request and merge request links, on Bun. The
 * fetch, parsers, cache and route live in `@plannotator/shared/ref-cards`
 * (vendored to Pi, which runs them through `nodeRefCliRunner`); this module
 * adds the Bun runner and makes it the default.
 */

import {
  createRefCards as createSharedRefCards,
  handleRefCardRoute,
  REF_CARD_ROUTE,
  REF_TIMEOUT_MS,
  type RefCards,
  type RefRunner,
} from "@plannotator/shared/ref-cards";

export * from "@plannotator/shared/ref-cards";

/** The real CLIs, each with a time limit, no prompt, no color. */
export const refCliRunner: RefRunner = async (cli, args, env) => {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([cli, ...args], {
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1", ...env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    return { stdout: "", stderr: `${cli}: not found`, exitCode: 127 };
  }
  const timer = setTimeout(() => proc.kill(), REF_TIMEOUT_MS);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(timer);
  }
};

/** `createRefCards` with the Bun runner by default (tests pass their own). */
export function createRefCards(options: Partial<Parameters<typeof createSharedRefCards>[0]> = {}): RefCards {
  return createSharedRefCards({ ...options, run: options.run ?? refCliRunner });
}

/**
 * `GET /api/ref` on a Bun plan, annotate or review server (`handleRefCardRoute`),
 * or null for any other path. `enabled` is false when the session is exposed
 * (remote mode, `--tailscale`): see the route's doc in the shared module.
 */
export async function refCardRouteResponse(
  req: Request,
  url: URL,
  cards: RefCards,
  options: { enabled: boolean; serverSession?: string },
): Promise<Response | null> {
  if (url.pathname !== REF_CARD_ROUTE) return null;
  const answer = await handleRefCardRoute(
    {
      method: req.method,
      href: url.searchParams.get("url"),
      origin: req.headers.get("origin"),
      host: url.host,
      secFetchSite: req.headers.get("sec-fetch-site"),
      enabled: options.enabled,
    },
    cards,
  );
  const body = answer.status === 200 && options.serverSession ? { serverSession: options.serverSession, ...answer.body } : answer.body;
  return Response.json(body, { status: answer.status, headers: { "Cache-Control": "no-store" } });
}
