/**
 * Plannotator Inbox: the links to other machines, on disk
 * (docs/agent-guides/inbox-machines.md). The one place linking state lives.
 *
 *   inbox/machines.json   0600: { v: 1, self: { id }, links: [...] }
 *
 * `self.id` is this Inbox's stable id (`ibx_…`), made once and served by
 * `health`; other Inboxes key their link to this one by it, never by its
 * address, so an address or transport can change without breaking a link.
 * Each link keeps the other machine's id and name, the bearer token its door
 * gave this Inbox, the transport that reaches it, and the device id that
 * machine holds on THIS Inbox's door (the way back; null for a one-way link).
 *
 * Written whole to a temp file, then renamed over the old one. A link to an
 * id already linked replaces it (re-pairing); a link to this Inbox's own id is
 * refused (a data folder copied to another computer).
 *
 * The pairing link: `plannotator://link?v=1&id=&name=&tailnet=&secret=&code=`,
 * the machine's id and name, its tailnet door address when it has one, and
 * the one-time offer's secret and six digits.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkInboxThreadName, inboxId, isInboxId } from "@plannotator/core/inbox-types";
import { InboxError, inboxDir } from "@plannotator/shared/inbox/schema";
import { parseTransportSpec, type InboxTransportSpec } from "./inbox-transport";

export const INBOX_MACHINES_FILE = "machines.json";

export interface InboxLinkRecord {
  /** The other Inbox's stable id, from its `health`. */
  id: string;
  /** Its computer's name, as its pairing said. */
  name: string;
  /** This Inbox's bearer token on that Inbox's door. */
  token: string;
  transport: InboxTransportSpec;
  /** The device that machine holds on this Inbox's door (the way back), or null when it links one way. */
  device_id: string | null;
  linked_at: string;
}

interface MachinesFile {
  v: 1;
  self: { id: string };
  links: InboxLinkRecord[];
}

function isLink(value: unknown): value is InboxLinkRecord {
  if (!value || typeof value !== "object") return false;
  const l = value as Record<string, unknown>;
  return (
    isInboxId("ibx", l.id) &&
    typeof l.name === "string" &&
    typeof l.token === "string" &&
    parseTransportSpec(l.transport) !== null &&
    (l.device_id === null || isInboxId("dev", l.device_id)) &&
    typeof l.linked_at === "string"
  );
}

export class InboxLinks {
  private readonly path: string;
  private file: MachinesFile;

  private constructor(dataDir: string) {
    const dir = inboxDir(dataDir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, INBOX_MACHINES_FILE);
    let read: Partial<MachinesFile> | null = null;
    try {
      read = JSON.parse(readFileSync(this.path, "utf8")) as Partial<MachinesFile>;
    } catch {
      read = null;
    }
    const self = read && isInboxId("ibx", read.self?.id) ? read.self!.id : null;
    this.file = { v: 1, self: { id: self ?? inboxId("ibx") }, links: Array.isArray(read?.links) ? read!.links!.filter(isLink) : [] };
    if (!self) this.write();
  }

  static open(dataDir: string): InboxLinks {
    return new InboxLinks(dataDir);
  }

  get selfId(): string {
    return this.file.self.id;
  }

  list(): InboxLinkRecord[] {
    return this.file.links.map((link) => ({ ...link }));
  }

  get(id: string): InboxLinkRecord | null {
    const link = this.file.links.find((l) => l.id === id);
    return link ? { ...link } : null;
  }

  /** Rule 19: keyed by the other Inbox's id; a second link to it replaces the first; never this Inbox's own id. */
  put(link: InboxLinkRecord): void {
    if (link.id === this.selfId) throw new InboxError("link_to_self", "That is this Inbox's own link code: open the code on the other machine.");
    if (!isLink(link)) throw new InboxError("validation_error", "Not a link record.");
    this.file = { ...this.file, links: [...this.file.links.filter((l) => l.id !== link.id), { ...link }] };
    this.write();
  }

  remove(id: string): InboxLinkRecord | null {
    const link = this.get(id);
    if (!link) return null;
    this.file = { ...this.file, links: this.file.links.filter((l) => l.id !== id) };
    this.write();
    return link;
  }

  private write(): void {
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.file, null, 2)}\n`, { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, this.path);
  }
}

export interface InboxLinkOffer {
  id: string | null;
  name: string | null;
  /** The door's tailnet address (`host:port`), when the machine publishes one. */
  tailnet: string | null;
  secret: string | null;
  code: string | null;
}

export function buildLinkOffer(offer: { id: string; name: string; tailnet: string | null; secret: string; code: string }): string {
  const params = [`v=1`, `id=${offer.id}`, `name=${encodeURIComponent(offer.name)}`];
  if (offer.tailnet) params.push(`tailnet=${encodeURIComponent(offer.tailnet)}`);
  params.push(`secret=${offer.secret}`, `code=${offer.code}`);
  return `plannotator://link?${params.join("&")}`;
}

/** A pairing link as the person pasted it; null when it is not one. */
export function parseLinkOffer(text: string): InboxLinkOffer | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "plannotator:" || (url.hostname || url.pathname.replace(/^\/+/, "")) !== "link") return null;
  if (url.searchParams.get("v") !== "1") return null;
  const id = url.searchParams.get("id");
  const name = url.searchParams.get("name");
  const checked = name === null ? null : checkInboxThreadName(name);
  return {
    id: isInboxId("ibx", id) ? id : null,
    name: checked && checked.ok ? checked.name : null,
    tailnet: url.searchParams.get("tailnet") || null,
    secret: url.searchParams.get("secret") || null,
    code: url.searchParams.get("code") || null,
  };
}
