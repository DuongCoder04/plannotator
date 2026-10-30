/**
 * The Inbox's tailnet door mapping (inbox-devices.ts): which tailnet HTTPS
 * port the door takes, and the record of the mapping this Inbox made.
 *
 * The port. The door takes the first port of `INBOX_TAILNET_HTTPS_PORTS`
 * (8443, then 8444 to 8450) that has no `tailscale serve` mapping, or whose
 * mapping is this Inbox's own by the record. The recorded port and the port
 * the switch kept come first, so the door's address (which a link code, a
 * `--back` and a linked machine carry, port included) stays the same across
 * restarts while that port stays free. A port mapped to anything else is
 * skipped: never replaced, never reset.
 *
 * The record (`inbox/tailnet-door.json`, 0600, temp file then rename):
 * `{ v: 1, https_port, target }`, the mapping this Inbox made and has not
 * taken down yet. Only a mapping that matches it exactly (that port, that
 * loopback target) is the Inbox's. A mapping whose target only happens to
 * be a port the door listener bound (someone's stale entry pointing at a
 * dead port) is never adopted, re-pointed or removed. Written once
 * `tailscale serve` made the mapping; removed once the mapping is down (or
 * found gone); kept when a take-down failed, so the next start or
 * `uninstall --purge` tries again. Nothing is written into a data folder
 * that no longer exists.
 */

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { serveStatusProxy } from "@plannotator/shared/tailscale";

/** The tailnet HTTPS ports the door may take, in order (8443 is the contract's, ruling 8). */
export const INBOX_TAILNET_HTTPS_PORTS: readonly number[] = [8443, 8444, 8445, 8446, 8447, 8448, 8449, 8450];
/** The ports, for the person: "8443 to 8450". */
export const INBOX_TAILNET_PORT_RANGE = `${INBOX_TAILNET_HTTPS_PORTS[0]} to ${INBOX_TAILNET_HTTPS_PORTS.at(-1)}`;
export const INBOX_TAILNET_DOOR_FILE = "tailnet-door.json";

export interface TailnetDoorRecord {
  /** The tailnet HTTPS port the mapping is on. */
  https_port: number;
  /** Where it points: `http://127.0.0.1:<door listener port>`. */
  target: string;
}

const recordPath = (dataDir: string) => join(inboxDir(dataDir), INBOX_TAILNET_DOOR_FILE);

/** The mapping this Inbox made and has not taken down; null when there is none (or the file cannot be read: then nothing is the Inbox's). */
export function readTailnetDoorRecord(dataDir: string): TailnetDoorRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(recordPath(dataDir), "utf8")) as Record<string, unknown>;
    if (parsed.v !== 1 || !Number.isSafeInteger(parsed.https_port) || typeof parsed.target !== "string") return null;
    if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(parsed.target)) return null;
    return { https_port: parsed.https_port as number, target: parsed.target };
  } catch {
    return null;
  }
}

export function writeTailnetDoorRecord(dataDir: string, record: TailnetDoorRecord): void {
  if (!existsSync(inboxDir(dataDir))) return;
  const path = recordPath(dataDir);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ v: 1, ...record })}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

export function clearTailnetDoorRecord(dataDir: string): void {
  rmSync(recordPath(dataDir), { force: true });
}

export type TailnetDoorPort =
  /** `own`: the record's target, when the port already maps to it (re-pointed, never re-made). */
  | { state: "usable"; port: number; own: string | null }
  | { state: "taken" }
  | { state: "malformed" };

/**
 * The port the door takes, read from `tailscale serve status --json`: the
 * first free one, or the one the record says is the Inbox's. `preferred`:
 * the port the switch kept from the last run (inbox.json), tried right after
 * the record's.
 */
export function chooseTailnetDoorPort(serveStatus: string, record: TailnetDoorRecord | null, preferred?: number): TailnetDoorPort {
  const order = [record?.https_port, preferred, ...INBOX_TAILNET_HTTPS_PORTS].filter(
    (port, i, all): port is number => typeof port === "number" && INBOX_TAILNET_HTTPS_PORTS.includes(port) && all.indexOf(port) === i,
  );
  for (const port of order) {
    const mapped = serveStatusProxy(serveStatus, port);
    if (mapped.state === "malformed") return { state: "malformed" };
    if (mapped.state === "free") return { state: "usable", port, own: null };
    if (record && record.https_port === port && record.target === mapped.proxy) return { state: "usable", port, own: record.target };
  }
  return { state: "taken" };
}
