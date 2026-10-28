/**
 * `plannotator feedback "<message>" [--category …] [--contact …]`: sends the
 * person's feedback about Plannotator to the feedback Worker through the one
 * client (packages/core/product-feedback.ts) the Inbox's Feedback dialog also
 * uses, and prints "Sent". The Inbox's "Prompt your agent to send feedback" tells an
 * agent to run it once the person has seen the exact text and said yes.
 *
 * Sends only what is on the command line, plus the version and the OS name.
 * `PLANNOTATOR_FEEDBACK_URL` points it elsewhere (tests: a local fake).
 * Exit 0 sent, 1 not sent (the reason on stderr), 2 bad usage.
 */

import {
  FEEDBACK_CATEGORIES,
  feedbackInputError,
  feedbackOsName,
  productFeedbackPayload,
  productFeedbackUrl,
  sendProductFeedback,
  type FeedbackCategory,
} from "@plannotator/core/product-feedback";
import { FEEDBACK_COMMAND_USAGE } from "./cli";

export { FEEDBACK_COMMAND_USAGE };

export type ParsedFeedbackCommand =
  | { ok: true; help: true }
  | { ok: true; help: false; message: string; category: FeedbackCategory | null; contact: string | null }
  | { ok: false; error: string };

export function parseFeedbackCommand(argv: readonly string[]): ParsedFeedbackCommand {
  const words: string[] = [];
  let category: FeedbackCategory | null = null;
  let contact: string | null = null;
  let flagsDone = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!flagsDone && arg === "--") {
      flagsDone = true;
      continue;
    }
    if (!flagsDone && (arg === "--help" || arg === "-h")) return { ok: true, help: true };
    if (!flagsDone && (arg === "--category" || arg.startsWith("--category="))) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) return { ok: false, error: "--category needs a value (bug, idea or other)." };
      if (!(FEEDBACK_CATEGORIES as readonly string[]).includes(value)) return { ok: false, error: `--category must be one of: ${FEEDBACK_CATEGORIES.join(", ")}.` };
      category = value as FeedbackCategory;
      continue;
    }
    if (!flagsDone && (arg === "--contact" || arg.startsWith("--contact="))) {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[++i];
      if (value === undefined) return { ok: false, error: "--contact needs a value." };
      contact = value;
      continue;
    }
    if (!flagsDone && arg.startsWith("--")) return { ok: false, error: `Unknown option: ${arg}` };
    words.push(arg);
  }
  const message = words.join(" ");
  const invalid = feedbackInputError({ message, category, contact });
  if (invalid) return { ok: false, error: invalid === "Write your feedback first." ? 'Give the feedback as the first argument: plannotator feedback "<message>"' : invalid };
  return { ok: true, help: false, message, category, contact };
}

export interface FeedbackCommandDeps {
  env: Record<string, string | undefined>;
  version: string;
  platform?: string;
  fetch?: typeof fetch;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

export async function runFeedbackCommand(argv: readonly string[], deps: FeedbackCommandDeps): Promise<number> {
  const out = deps.out ?? ((line: string) => console.log(line));
  const err = deps.err ?? ((line: string) => console.error(line));
  const parsed = parseFeedbackCommand(argv);
  if (!parsed.ok) {
    err(parsed.error);
    err("Run 'plannotator feedback --help' for usage.");
    return 2;
  }
  if (parsed.help) {
    out(FEEDBACK_COMMAND_USAGE);
    return 0;
  }
  const payload = productFeedbackPayload(parsed, {
    version: deps.version,
    os: feedbackOsName(deps.platform ?? process.platform),
    surface: "cli",
  });
  const result = await sendProductFeedback(payload, { url: productFeedbackUrl(deps.env), fetch: deps.fetch });
  if (!result.ok) {
    err(`Not sent: ${result.reason}`);
    return 1;
  }
  out("Sent");
  return 0;
}
