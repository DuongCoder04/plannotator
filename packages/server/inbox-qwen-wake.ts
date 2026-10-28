/**
 * The Qwen Code wake: the person's reply, message or tag for a running Qwen
 * session goes into that session as its next message, through Qwen's
 * cross-session messaging (Qwen Code 0.24 or later, macOS and Linux).
 *
 * Qwen has no Plannotator plugin to poll the Inbox, so the Inbox delivers
 * itself, as it does for Codex (inbox-codex-wake.ts). A Qwen session is
 * learned from its MCP calls: the stdio shim sends as `agent_host: "qwen"`,
 * `agent_session: <its session id>` (read from Qwen's session registry on
 * every call, so `/clear` and `/resume` are followed). Its message is marked
 * `wakes` when all of these hold:
 *
 *  - Plannotator holds a trusted-sender token for this Qwen home
 *    (inbox-qwen-trust.ts; without one Qwen would hold the message for review);
 *  - the session has a live record in `$QWEN_HOME/sessions/` with an inbox
 *    socket, from a terminal session (`kind: "tui"`, one session per process:
 *    a headless run ends after its turn, and sessions driven over ACP or by
 *    `qwen serve` refuse messages);
 *  - the call is not a daemon's (`_meta["qwen-code/invocation"]`);
 *  - neither the person's Qwen settings nor the project's turn messaging off
 *    (`agents.crossSessionMessaging: false`) or hold or refuse what comes in
 *    (`agents.crossSessionInbound`).
 *
 * Then each item waiting for that session (`InboxStore.pendingRepliesFor`) is
 * sent once: one connection to the session's socket, the auth line with the
 * token and one `user` frame naming the session (`toSessionId`), in one write
 * (Qwen's cross-session protocol, frame version 1). Each item is claimed on
 * disk first (`inbox/qwen-wake/<item id>.<session id>/`, made with mkdir), so
 * it is never sent twice, across restarts too. The frame says where Qwen's
 * receipts go: a socket of the Inbox's own (0600 in a 0700 folder), and
 * receipts are believed only with the reply token the frame carried.
 *
 *  - `delivered`: in the session's input queue, so "Queued for Qwen Code; it
 *    gets this as its next turn." The item is Delivered when the session next
 *    calls an Inbox tool after that receipt, or reads the thread.
 *  - `held`, `denied`, `refused`, or no receipt within a while (a token Qwen
 *    no longer accepts is dropped without a word): it may not have gone, so it
 *    is never sent again and the window says it is saved for the session's
 *    next read. `refused` also stops waking that session.
 *  - `misaddressed` (the socket now serves another session): the session has
 *    ended; the reply waits for the next agent.
 *  - `expired`: the session closed with it unread (it is sent again if the
 *    session comes back), or a held message ran out (never sent again).
 *  - `dropped` (Qwen's rate limit or a full queue), or a socket nothing
 *    answers: tried again later, 30 s doubling to 10 min, with a new id.
 *
 * A session whose record is gone has ended ("dead"); it is alive again when
 * its record comes back (`qwen --resume`), which a slow poll (a minute) looks
 * for while a reply waits for it. Windows is not woken.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_QWEN_HOST, isQwenSessionId, qwenSessionOfCall, type InboxMessage, type InboxQwenSessionRecord } from "@plannotator/core/inbox-types";
import { isPidAlive } from "@plannotator/shared/inbox/registry";
import { listQwenSessionRecords } from "@plannotator/shared/inbox/qwen-sessions";
import type { InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import { stripJsonComments } from "./agent-files";
import { codexQueueMessage } from "./inbox-codex-wake";
import type { AgentEnvironment } from "./inbox-agents";
import { qwenTrustHome, qwenWakeToken } from "./inbox-qwen-trust";

/** One send (connect, write, the peer's close) may take this long. */
export const INBOX_QWEN_SEND_TIMEOUT_MS = 5_000;
/** A send with no receipt after this long may not have gone. */
export const INBOX_QWEN_RECEIPT_TIMEOUT_MS = 30_000;
/** How often to look for a session coming back while a reply waits for it. */
export const INBOX_QWEN_COMEBACK_MS = 60_000;

/** How the frame names the sender to the session (Qwen shows the grant's label as its authority). */
const FROM_NAME = "Plannotator Inbox";
const CLAIM_DIR = "qwen-wake";
const RETRY_FIRST_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
const REGISTRY_TTL_MS = 2_000;
/** Qwen's protocol: one line may not pass 1 MiB, and must finish within 30 s. */
const LINE_MAX_CHARS = 1024 * 1024;
const LINE_DEADLINE_MS = 30_000;
const MAX_RECEIPT_CONNECTIONS = 64;
/** A unix socket path may not pass this many bytes (Qwen's own limit, the smallest of macOS and Linux). */
const SOCKET_PATH_MAX = 103;

type ClaimState = "sent" | "delivered" | "held" | "denied" | "refused" | "uncertain";

interface Claim {
  itemId: string;
  session: string;
  msgId: string | null;
  at: number;
  state: ClaimState;
  /** When the delivered receipt came (ms). */
  deliveredAt?: number;
  /** The record's pid when it was sent: an `expired` while it is alive is a held message that ran out. */
  pid?: number;
}

export interface InboxQwenWake {
  /** Whether this Inbox can wake Qwen sessions at all now: not Windows, and a trusted-sender token for this Qwen home. */
  canWake(): boolean;
  /** Whether a message from this host and session, sent by a tool call with this `_meta`, wakes it (see the file comment). */
  wakes(host: unknown, session: unknown, meta: unknown): Promise<boolean>;
  /**
   * How a session stands for the presence rules: `alive` (a Qwen session the
   * Inbox wakes, running now), `dead` (its record is gone, or its socket
   * serves another session), null (not a Qwen session the Inbox wakes now:
   * the MCP presence rules apply).
   */
  status(session: string): "alive" | "dead" | null;
  /** The session called an Inbox tool: it is there, and what Qwen said it queued before now has reached it. */
  noteToolCall(session: string): void;
  /** Whether an item may not have reached this session (held, refused, no receipt): saved for its next read. */
  uncertain(session: string, itemId: string): boolean;
  uncertainItems(session: string): string[];
  /** Look for items to send now. */
  sweep(): Promise<void>;
  stop(): void;
}

/** Whether a socket path is one this Inbox would dial: absolute, local, no NUL. */
function dialable(path: string | null): path is string {
  return typeof path === "string" && path.startsWith("/") && !path.startsWith("//") && !path.includes("\u0000");
}

/** Linux's guards against a reused pid and a record from another machine or namespace (Qwen's protocol §1). */
function linuxIdentity(): { bootId: string | null; pidNs: number | null } {
  let bootId: string | null = null;
  let pidNs: number | null = null;
  try {
    bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() || null;
  } catch {
    // Not Linux.
  }
  try {
    pidNs = lstatSync("/proc/self/ns/pid").ino;
  } catch {
    // Not Linux.
  }
  return { bootId, pidNs };
}

/** Field 22 of /proc/<pid>/stat (the start time in ticks), or null. */
function startTicks(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

/** A record is live as Qwen's readers decide it: same namespace and boot, the pid alive with the same start. */
export function qwenRecordLive(record: InboxQwenSessionRecord, identity: { bootId: string | null; pidNs: number | null } = linuxIdentity()): boolean {
  if (record.pidNs !== null && identity.pidNs !== null && record.pidNs !== identity.pidNs) return false;
  if (record.pidNs === null && identity.pidNs !== null && process.platform === "linux") return false;
  if (record.procStart !== null) {
    // Written on Linux: this side must be the same boot of the same machine.
    const colon = record.procStart.lastIndexOf(":");
    if (identity.bootId === null || colon <= 0) return false;
    if (record.procStart.slice(0, colon) !== identity.bootId) return false;
    if (startTicks(record.pid) !== record.procStart.slice(colon + 1)) return false;
  }
  return isPidAlive(record.pid);
}

/** What the person's (or the project's) Qwen settings say about messages from other programs. */
function settingsRefuse(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return false;
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf8"))) as { agents?: { crossSessionMessaging?: unknown; crossSessionInbound?: unknown } } | null;
    const agents = parsed?.agents;
    if (!agents || typeof agents !== "object") return false;
    if (agents.crossSessionMessaging !== undefined && agents.crossSessionMessaging !== true) return true;
    return agents.crossSessionInbound === "hold" || agents.crossSessionInbound === "refuse";
  } catch {
    return false;
  }
}

export function createInboxQwenWake(options: {
  store: InboxStore;
  environment: AgentEnvironment;
  /** The Plannotator data dir (the trusted-sender token is under it). */
  dataDir: string;
  /** The wake command for an item and the session it goes to (the bridge's `replyCommand`). */
  commandOf: (item: InboxMessage, session: string) => InboxReplyCommand;
  /** The session holds a wait_for_reply open now that returns items of this thread: those are not sent as well. */
  waitingOverMcp?: (session: string, threadId: string) => boolean;
  now?: () => number;
  sendTimeoutMs?: number;
  receiptTimeoutMs?: number;
  comebackMs?: number;
  /** Where the receipts socket's folder goes (default: the OS temp dir, or /tmp when that path is too long). */
  socketParent?: string;
  log?: (line: string) => void;
}): InboxQwenWake {
  const { store, environment } = options;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((line: string) => void process.stderr.write(`Inbox: ${line}\n`));
  const dir = join(store.dir, CLAIM_DIR);
  const supported = environment.platform !== "win32";
  let stopped = false;
  const identity = linuxIdentity();

  const home = () => qwenTrustHome(environment);
  // The token file is read at most every two seconds too (Settings and the connect step change it).
  let tokenRead: { at: number; token: string | null } | null = null;
  const token = (): string | null => {
    if (!supported) return null;
    if (tokenRead && Date.now() - tokenRead.at < REGISTRY_TTL_MS) return tokenRead.token;
    tokenRead = { at: Date.now(), token: qwenWakeToken(options.dataDir, home()) };
    return tokenRead.token;
  };

  // ── The registry, read at most every two seconds ──
  let registry: { at: number; records: InboxQwenSessionRecord[] } | null = null;
  const records = (): InboxQwenSessionRecord[] => {
    if (registry && Date.now() - registry.at < REGISTRY_TTL_MS) return registry.records;
    const live = listQwenSessionRecords(home()).filter((record) => qwenRecordLive(record, identity));
    registry = { at: Date.now(), records: live };
    return live;
  };
  /** What a settings file says, read at most every two seconds (presence reads it often). */
  const settingsRead = new Map<string, { at: number; refuses: boolean }>();
  const refusing = (path: string): boolean => {
    const cached = settingsRead.get(path);
    if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.refuses;
    const refuses = settingsRefuse(path);
    if (settingsRead.size > 256) settingsRead.clear();
    settingsRead.set(path, { at: Date.now(), refuses });
    return refuses;
  };
  const forgetRegistry = () => {
    registry = null;
    tokenRead = null;
    settingsRead.clear();
  };
  /** The session's newest live record, or null when it has none. */
  const recordOf = (session: string): InboxQwenSessionRecord | null => {
    let best: InboxQwenSessionRecord | null = null;
    for (const record of records()) if (record.sessionId === session && (!best || record.startedAt > best.startedAt)) best = record;
    return best;
  };
  /** Whether a live record can be messaged: a terminal session alone in its process, with an inbox socket and token, and settings that let it in. */
  const reachable = (record: InboxQwenSessionRecord): boolean => {
    if (record.shared || record.kind !== "tui" || !dialable(record.ipcPath) || !record.ipcToken) return false;
    if (refusing(join(home(), "settings.json"))) return false;
    return !(record.cwd !== null && refusing(join(record.cwd, ".qwen", "settings.json")));
  };

  // ── The sessions it wakes ──
  let known: Set<string> | null = null;
  const knownSessions = (): Set<string> => (known ??= new Set([...store.wakingSessionsOfHost(INBOX_QWEN_HOST)].filter(isQwenSessionId)));
  /** Sessions whose socket served another session (`misaddressed`): ended until they call again. */
  const ended = new Set<string>();
  /** Sessions that refused a message: never woken again by this Inbox run. */
  const refused = new Set<string>();

  // ── Claims ──
  const claims = new Map<string, Claim>();
  const byMsgId = new Map<string, string>();
  const keyOf = (itemId: string, session: string) => `${itemId}.${session}`;
  const claimPath = (key: string) => join(dir, key);
  const persist = (claim: Claim) => {
    try {
      writeFileSync(join(claimPath(keyOf(claim.itemId, claim.session)), "state.json"), `${JSON.stringify({ at: claim.at, msgId: claim.msgId, state: claim.state, ...(claim.deliveredAt ? { deliveredAt: claim.deliveredAt } : {}) })}\n`);
    } catch {
      // Kept in memory.
    }
  };
  try {
    for (const name of readdirSync(dir)) {
      const dot = name.indexOf(".");
      if (dot <= 0) continue;
      const itemId = name.slice(0, dot);
      const session = name.slice(dot + 1);
      if (!isQwenSessionId(session)) continue;
      let claim: Claim = { itemId, session, msgId: null, at: 0, state: "uncertain" };
      try {
        const saved = JSON.parse(readFileSync(join(dir, name, "state.json"), "utf8")) as { at?: unknown; state?: unknown; deliveredAt?: unknown };
        const at = typeof saved.at === "number" ? saved.at : 0;
        // Only a delivered receipt survives a restart as queued; a send still waiting for its receipt may not have gone.
        if (saved.state === "delivered") claim = { itemId, session, msgId: null, at, state: "delivered", deliveredAt: typeof saved.deliveredAt === "number" ? saved.deliveredAt : at };
        else claim = { itemId, session, msgId: null, at, state: saved.state === "refused" ? "refused" : "uncertain" };
      } catch {
        // Claimed and never finished (the Inbox stopped mid-send): never sent again.
      }
      claims.set(name, claim);
    }
  } catch {
    // No claims yet.
  }
  const dropClaim = (key: string) => {
    const claim = claims.get(key);
    if (claim?.msgId) byMsgId.delete(claim.msgId);
    claims.delete(key);
    rmSync(claimPath(key), { recursive: true, force: true });
  };
  const delivered = (key: string) => {
    const claim = claims.get(key);
    if (!claim) return;
    try {
      store.recordDelivery(claim.itemId, { host: INBOX_QWEN_HOST, session: claim.session });
    } catch {
      // Gone, or no longer this session's.
    }
    dropClaim(key);
  };
  const isUncertain = (claim: Claim) => claim.state !== "delivered" && claim.state !== "sent";

  /** Whether the item goes to `session` through a wake: its owner's message woke, it is addressed to it, or a waking tag. */
  const wakesItem = (item: InboxMessage, session: string): boolean => {
    if (!store.isOwner(item, session)) return item.tags?.some((tag) => tag.session === session && tag.host === INBOX_QWEN_HOST && tag.wakes) ?? false;
    if (item.to) return item.to.host === INBOX_QWEN_HOST;
    const asked = item.reply_to ? store.message(item.reply_to) : null;
    return asked?.author.kind === "agent" && asked.author.host === INBOX_QWEN_HOST && asked.wakes === true;
  };

  // ── Timers: retries, receipts that never came, a session coming back ──
  const retryAt = new Map<string, { at: number; wait: number }>();
  const receiptTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let comebackTimer: ReturnType<typeof setTimeout> | null = null;
  const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.();
  const scheduleRetry = () => {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (retryAt.size === 0 || stopped) return;
    const next = Math.min(...[...retryAt.values()].map((retry) => retry.at));
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void sweep();
    }, Math.max(0, next - now()) + 10);
    unref(retryTimer);
  };
  const scheduleComeback = (wanted: boolean) => {
    if (!wanted || stopped) {
      if (comebackTimer) clearTimeout(comebackTimer);
      comebackTimer = null;
      return;
    }
    if (comebackTimer) return;
    comebackTimer = setTimeout(() => {
      comebackTimer = null;
      void sweep();
    }, options.comebackMs ?? INBOX_QWEN_COMEBACK_MS);
    unref(comebackTimer);
  };
  const retryLater = (key: string) => {
    const wait = Math.min((retryAt.get(key)?.wait ?? RETRY_FIRST_MS / 2) * 2, RETRY_MAX_MS);
    retryAt.set(key, { at: now() + wait, wait });
  };

  // ── The receipts socket ──
  const replyToken = randomBytes(32).toString("hex");
  let receipts: { server: Server; path: string; folder: string } | null = null;
  let binding: Promise<string | null> | null = null;
  const connections = new Set<Socket>();
  const tokenMatches = (presented: unknown) => {
    if (typeof presented !== "string" || presented.length !== replyToken.length) return false;
    return timingSafeEqual(Buffer.from(presented), Buffer.from(replyToken));
  };
  const onReceipt = (frame: Record<string, unknown>) => {
    if (frame.type !== "control" || frame.action !== "delivery_status" || typeof frame.msgV !== "number" || frame.msgV > 1) return;
    const status = frame.status;
    const ids = [frame.origMsgId, ...(status === "dropped" && Array.isArray(frame.droppedMsgIds) ? frame.droppedMsgIds.slice(0, 256) : [])];
    for (const id of ids) {
      if (typeof id !== "string") continue;
      const key = byMsgId.get(id);
      const claim = key ? claims.get(key) : undefined;
      if (!key || !claim) continue;
      applyReceipt(key, claim, status);
    }
  };
  const applyReceipt = (key: string, claim: Claim, status: unknown) => {
    const settle = () => {
      const timer = receiptTimers.get(key);
      if (timer) clearTimeout(timer);
      receiptTimers.delete(key);
    };
    const pending = claim.state === "sent" || claim.state === "uncertain";
    switch (status) {
      case "delivered":
        if (!pending && claim.state !== "held") return;
        settle();
        claim.state = "delivered";
        claim.deliveredAt = now();
        persist(claim);
        return;
      case "held":
        if (!pending) return;
        settle();
        claim.state = "held";
        persist(claim);
        return;
      case "denied":
        if (!pending && claim.state !== "held") return;
        settle();
        claim.state = "denied";
        persist(claim);
        return;
      case "refused":
        if (!pending) return;
        settle();
        claim.state = "refused";
        refused.add(claim.session);
        persist(claim);
        log(`Qwen Code session ${claim.session} refuses messages from other programs; it sees the reply when it reads the thread.`);
        return;
      case "misaddressed":
        settle();
        ended.add(claim.session);
        forgetRegistry();
        dropClaim(key);
        return;
      case "expired": {
        settle();
        // A held message that ran out while the session runs: not sent again. One the session closed on: sent again if it comes back.
        if (claim.state === "held" && claim.pid !== undefined && isPidAlive(claim.pid)) {
          claim.state = "uncertain";
          persist(claim);
          return;
        }
        forgetRegistry();
        dropClaim(key);
        // Not at once: a session shutting down still has its record for a moment.
        retryLater(key);
        scheduleRetry();
        return;
      }
      case "dropped":
        if (!pending) return;
        settle();
        dropClaim(key);
        retryLater(key);
        scheduleRetry();
        return;
      default:
        // A status this Inbox does not know yet: no change (Qwen's protocol §7).
        return;
    }
  };
  const handleConnection = (socket: Socket) => {
    if (connections.size >= MAX_RECEIPT_CONNECTIONS) {
      socket.destroy();
      return;
    }
    connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    let authed = false;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const arm = () => {
      if (deadline) clearTimeout(deadline);
      deadline = setTimeout(() => socket.destroy(), LINE_DEADLINE_MS);
      unref(deadline);
    };
    arm();
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let at = buffer.indexOf("\n");
      while (at >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf("\n");
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
        const frame = parsed as Record<string, unknown>;
        if (!authed) {
          // The first line must present the token the frame carried; anything else ends the connection.
          if (frame.type !== "auth" || !tokenMatches(frame.token)) {
            socket.destroy();
            return;
          }
          authed = true;
          arm();
          continue;
        }
        arm();
        onReceipt(frame);
      }
      if (buffer.length > LINE_MAX_CHARS) socket.destroy();
    });
    const done = () => {
      if (deadline) clearTimeout(deadline);
      connections.delete(socket);
    };
    socket.on("close", done);
    socket.on("error", done);
  };
  const bindReceipts = (): Promise<string | null> => {
    if (receipts) return Promise.resolve(receipts.path);
    binding ??= new Promise<string | null>((resolveBind) => {
      let folder: string;
      try {
        const parent = options.socketParent ?? tmpdir();
        const base = Buffer.byteLength(join(parent, "plannotator-qwen-XXXXXX", "r.sock")) <= SOCKET_PATH_MAX ? parent : "/tmp";
        folder = mkdtempSync(join(base, "plannotator-qwen-"));
        chmodSync(folder, 0o700);
      } catch (error) {
        log(`the Qwen Code receipts socket could not be made: ${error instanceof Error ? error.message : String(error)}`);
        resolveBind(null);
        return;
      }
      const path = join(folder, "r.sock");
      const server = createServer(handleConnection);
      server.once("error", (error) => {
        rmSync(folder, { recursive: true, force: true });
        log(`the Qwen Code receipts socket could not be bound: ${error.message}`);
        resolveBind(null);
      });
      server.listen(path, () => {
        try {
          chmodSync(path, 0o600);
        } catch {
          // The folder is 0700 already.
        }
        server.unref();
        receipts = { server, path, folder };
        resolveBind(path);
      });
    }).finally(() => {
      binding = null;
    });
    return binding;
  };

  /** One frame to one socket: resolves how it went. `written`: the session read it (or may have, on a timeout). */
  const sendFrame = (path: string, payload: string): Promise<"sent" | "timeout" | "unreachable" | "failed"> =>
    new Promise((resolveSend) => {
      let settled = false;
      let connected = false;
      const socket = createConnection({ path });
      const finish = (result: "sent" | "timeout" | "unreachable" | "failed") => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        socket.destroy();
        resolveSend(result);
      };
      const deadline = setTimeout(() => finish(connected ? "timeout" : "unreachable"), options.sendTimeoutMs ?? INBOX_QWEN_SEND_TIMEOUT_MS);
      socket.on("connect", () => {
        connected = true;
        // The auth line rides in the same write as the frame, then half-close (Qwen's protocol §2).
        socket.end(payload);
      });
      socket.on("error", (error: NodeJS.ErrnoException) => finish(!connected && (error.code === "ENOENT" || error.code === "ECONNREFUSED") ? "unreachable" : connected ? "timeout" : "failed"));
      socket.on("close", () => finish(connected ? "sent" : "unreachable"));
    });

  const sendOne = async (item: InboxMessage, session: string, record: InboxQwenSessionRecord, controller: string): Promise<void> => {
    const key = keyOf(item.id, session);
    const retry = retryAt.get(key);
    if (retry && retry.at > now()) return;
    const from = await bindReceipts();
    if (!from || stopped) return;
    try {
      mkdirSync(dir, { recursive: true });
      mkdirSync(claimPath(key));
    } catch {
      // Claimed already (another sweep, or before a restart).
      return;
    }
    const msgId = randomUUID();
    const claim: Claim = { itemId: item.id, session, msgId, at: now(), state: "sent", pid: record.pid };
    claims.set(key, claim);
    byMsgId.set(msgId, key);
    persist(claim);
    const content = codexQueueMessage(options.commandOf(item, session));
    const frame = {
      msgV: 1,
      msgId,
      type: "user",
      from,
      replyToken,
      fromName: FROM_NAME,
      toSessionId: session,
      priority: "next",
      message: { role: "user", content },
    };
    const payload = `${JSON.stringify({ msgV: 1, type: "auth", token: controller })}\n${JSON.stringify(frame)}\n`;
    const result = await sendFrame(record.ipcPath!, payload);
    if (result === "unreachable" || result === "failed") {
      // Never written: free to send again later (the session may be gone: the registry is read again).
      if (claims.get(key) === claim) dropClaim(key);
      forgetRegistry();
      retryLater(key);
      if (result === "failed") log(`a reply could not be sent to Qwen Code session ${session}; trying again later.`);
      return;
    }
    retryAt.delete(key);
    if (result === "timeout") {
      // The session accepted the connection and did not finish reading: it may still read it, so never twice.
      if (claim.state === "sent") {
        claim.state = "uncertain";
        persist(claim);
      }
      return;
    }
    // Written: what became of it comes as a receipt; none in time, and it may not have gone.
    if (claim.state === "sent") {
      const timer = setTimeout(() => {
        receiptTimers.delete(key);
        if (claims.get(key) !== claim || claim.state !== "sent") return;
        claim.state = "uncertain";
        persist(claim);
        log(`Qwen Code did not confirm a reply to session ${session}; it is not sent again, and the session sees it when it reads the thread.`);
      }, options.receiptTimeoutMs ?? INBOX_QWEN_RECEIPT_TIMEOUT_MS);
      unref(timer);
      receiptTimers.set(key, timer);
    }
  };

  let sweeping: Promise<void> | null = null;
  let again = false;
  const sweepOnce = async (): Promise<void> => {
    // Every look reads Qwen's registry and settings afresh.
    forgetRegistry();
    const sessions = knownSessions();
    if (sessions.size === 0 && claims.size === 0) return;
    const pending = store.pendingRepliesFor(sessions, { tags: true });
    const pendingKeys = new Set<string>();
    const work: { item: InboxMessage; session: string; record: InboxQwenSessionRecord }[] = [];
    let waitsForComeback = false;
    for (const [session, items] of pending) {
      for (const item of items) {
        if (!wakesItem(item, session)) continue;
        const key = keyOf(item.id, session);
        pendingKeys.add(key);
        if (claims.has(key) || refused.has(session)) continue;
        if (options.waitingOverMcp?.(session, item.thread_id)) continue;
        const record = ended.has(session) ? null : recordOf(session);
        if (!record) {
          waitsForComeback = true;
          continue;
        }
        if (!reachable(record)) continue;
        work.push({ item, session, record });
      }
    }
    // A claim whose item no longer waits (delivered, read, deleted) is done with.
    for (const key of [...claims.keys()]) {
      if (pendingKeys.has(key) || receiptTimers.has(key)) continue;
      dropClaim(key);
    }
    for (const key of [...retryAt.keys()]) if (!pendingKeys.has(key)) retryAt.delete(key);
    const controller = token();
    if (work.length > 0 && controller) {
      for (const { item, session, record } of work) {
        if (stopped) return;
        await sendOne(item, session, record, controller);
      }
    }
    scheduleRetry();
    scheduleComeback(waitsForComeback && controller !== null);
  };
  const sweep = (): Promise<void> => {
    if (stopped || !supported) return Promise.resolve();
    if (sweeping) {
      again = true;
      return sweeping;
    }
    sweeping = (async () => {
      try {
        do {
          again = false;
          await sweepOnce();
        } while (again && !stopped);
      } catch (error) {
        log(`the Qwen Code wake could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        sweeping = null;
      }
    })();
    return sweeping;
  };

  let sweepQueued = false;
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message") return;
    const message = line.record as InboxMessage;
    if (message.author.kind === "agent") {
      if (message.wakes !== true || message.author.host !== INBOX_QWEN_HOST || !isQwenSessionId(message.author.session)) return;
      knownSessions().add(message.author.session);
    } else {
      if (message.to?.host === INBOX_QWEN_HOST && isQwenSessionId(message.to.session)) knownSessions().add(message.to.session);
      for (const tag of message.tags ?? []) if (tag.host === INBOX_QWEN_HOST && tag.wakes && isQwenSessionId(tag.session)) knownSessions().add(tag.session);
    }
    if (knownSessions().size === 0 || sweepQueued) return;
    sweepQueued = true;
    setTimeout(() => {
      sweepQueued = false;
      void sweep();
    }, 0);
  });
  void sweep();

  const status = (session: string): "alive" | "dead" | null => {
    if (!supported || !knownSessions().has(session) || refused.has(session) || token() === null) return null;
    if (ended.has(session)) return "dead";
    const record = recordOf(session);
    if (!record) return "dead";
    return reachable(record) ? "alive" : null;
  };

  return {
    canWake: () => token() !== null,
    wakes: async (host, session, meta) => {
      if (host !== INBOX_QWEN_HOST || !isQwenSessionId(session) || refused.has(session) || ended.has(session)) return false;
      if (qwenSessionOfCall(meta) !== null || token() === null) return false;
      const record = recordOf(session);
      return record !== null && reachable(record);
    },
    status,
    uncertain: (session, itemId) => {
      const claim = claims.get(keyOf(itemId, session));
      return claim ? isUncertain(claim) : false;
    },
    uncertainItems: (session) => [...claims.values()].filter((claim) => claim.session === session && isUncertain(claim)).map((claim) => claim.itemId),
    noteToolCall: (session) => {
      if (!isQwenSessionId(session)) return;
      if (ended.delete(session)) void sweep();
      const at = now();
      for (const [key, claim] of [...claims]) {
        if (claim.session === session && claim.state === "delivered" && (claim.deliveredAt ?? claim.at) <= at) delivered(key);
      }
    },
    sweep,
    stop: () => {
      stopped = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (comebackTimer) clearTimeout(comebackTimer);
      for (const timer of receiptTimers.values()) clearTimeout(timer);
      receiptTimers.clear();
      unsubscribe();
      for (const socket of connections) socket.destroy();
      if (receipts) {
        receipts.server.close();
        rmSync(receipts.folder, { recursive: true, force: true });
        receipts = null;
      }
    },
  };
}
