import { parseExtraOrigins } from "../core/cors";
import { handleRequest, type RateLimiter } from "../core/handler";
import { createThrottle } from "../core/throttle";
import { D1FeedbackStore } from "../stores/d1";

interface Env {
  FEEDBACK_DB: D1Database;
  /** Optional: the `[[ratelimits]]` binding in wrangler.toml. */
  FEEDBACK_RATE_LIMITER?: RateLimiter;
  /** Optional: more browser origins allowed besides loopback and the tailnet. */
  ALLOWED_ORIGINS?: string;
}

// Per isolate, in memory: 10 submissions per IP per 10 minutes (the owner's
// call; README.md). Nothing about the caller is written anywhere.
const throttle = createThrottle({ limit: 10, windowMs: 10 * 60 * 1000 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, {
      store: new D1FeedbackStore(env.FEEDBACK_DB),
      throttle,
      rateLimiter: env.FEEDBACK_RATE_LIMITER,
      ip: request.headers.get("CF-Connecting-IP"),
      extraOrigins: parseExtraOrigins(env.ALLOWED_ORIGINS),
    });
  },
};
