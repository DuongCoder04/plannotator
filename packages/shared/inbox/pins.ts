/**
 * Plannotator Inbox: threads pinned to the window's sidebar (approval
 * "inbox-pinned-threads", .product/approved/inbox-pinned-threads/).
 *
 *   inbox/pins.json   { v: 1, pins: [{ thread_id, pinned_at }] }, in pin order, 0600, written whole (temp, then rename)
 *
 * A file outside the store's JSONL, like reply drafts: a pin is window
 * furniture and must never enter the event log, which agents' cursors, the
 * phone relay and search read. A pin writes no line and takes no seq. There
 * is no limit on pins (the owner's decision), and an archived thread stays
 * pinned; a deleted thread leaves the file.
 */

import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isInboxId, type InboxPin } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";

export const INBOX_PINS_FILE = "pins.json";

/** The most thread ids one order may name (a bound on a request body, not a limit on pins). */
export const INBOX_PIN_ORDER_MAX = 10_000;

function fileOf(inboxDirPath: string): string {
  return join(inboxDirPath, INBOX_PINS_FILE);
}

/** The pins on disk, in order. A file that does not parse reads as none; a bad or repeated entry is skipped. */
export function readInboxPins(inboxDirPath: string): InboxPin[] {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(fileOf(inboxDirPath), "utf8"));
  } catch {
    return [];
  }
  const file = value as { v?: unknown; pins?: unknown } | null;
  if (!file || typeof file !== "object" || file.v !== 1 || !Array.isArray(file.pins)) return [];
  const out: InboxPin[] = [];
  const seen = new Set<string>();
  for (const entry of file.pins as unknown[]) {
    const pin = entry as { thread_id?: unknown; pinned_at?: unknown } | null;
    if (!pin || typeof pin !== "object" || !isInboxId("msg", pin.thread_id) || typeof pin.pinned_at !== "string") continue;
    if (seen.has(pin.thread_id)) continue;
    seen.add(pin.thread_id);
    out.push({ thread_id: pin.thread_id, pinned_at: pin.pinned_at });
  }
  return out;
}

/** Write the pins whole (owner-only). No pins removes the file. */
export function writeInboxPins(inboxDirPath: string, pins: readonly InboxPin[]): void {
  const file = fileOf(inboxDirPath);
  if (pins.length === 0) {
    try {
      unlinkSync(file);
    } catch {
      // Already gone.
    }
    return;
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, pins: pins.map((pin) => ({ thread_id: pin.thread_id, pinned_at: pin.pinned_at })) })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** The checks on an order (`POST /api/inbox/pins`): a list of distinct thread ids. */
export function checkInboxPinOrder(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > INBOX_PIN_ORDER_MAX || !value.every((id) => isInboxId("msg", id))) {
    throw new InboxError("validation_error", "order: a list of thread ids (msg_), in the order they show.", { field: "order" });
  }
  if (new Set(value).size !== value.length) throw new InboxError("validation_error", "order: a thread id appears twice.", { field: "order" });
  return value as string[];
}
