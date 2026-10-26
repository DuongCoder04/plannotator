/**
 * Plannotator Inbox: the person's last look at the Board (approval
 * "inbox-board-signal": a card is bold when unread, "like mail").
 *
 *   inbox/board.json   { v: 1, seen_through: "<ISO time>" }, 0600, written whole (temp, then rename)
 *
 * `seen_through` is the newest `heard_at` the Board showed when the person
 * last opened it. A card an agent wrote to after it is unread
 * (`isInboxCardUnread`). A file outside the store's JSONL, like pins: a look
 * is window furniture and never enters the event log that agents, the phone
 * relay and search read.
 */

import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INBOX_BOARD_FILE = "board.json";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** Whether a value is an ISO time as the store writes it (`2026-10-26T12:00:00.000Z`). */
export function isInboxBoardTime(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value));
}

/** The person's last look at the Board, or null (never opened, or a file that does not read). */
export function readInboxBoardSeen(inboxDirPath: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(inboxDirPath, INBOX_BOARD_FILE), "utf8")) as { v?: unknown; seen_through?: unknown } | null;
    if (!value || typeof value !== "object" || value.v !== 1 || !isInboxBoardTime(value.seen_through)) return null;
    return value.seen_through;
  } catch {
    return null;
  }
}

/**
 * Record a look through `through`. A look never goes back: an older time (a
 * second tab that read the Board earlier) leaves the newer one. Answers the
 * look now on disk.
 */
export function writeInboxBoardSeen(inboxDirPath: string, through: string): string {
  const current = readInboxBoardSeen(inboxDirPath);
  if (current !== null && current >= through) return current;
  const file = join(inboxDirPath, INBOX_BOARD_FILE);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, seen_through: through })}\n`, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows: the mode is a no-op.
  }
  renameSync(temp, file);
  return through;
}
