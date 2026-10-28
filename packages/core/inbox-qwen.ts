/**
 * Qwen Code's pure parts for the Inbox: how a Qwen session is named, what its
 * session registry record holds, and how an MCP call says which session it
 * comes from. Browser-safe, no I/O (the file reads are in
 * packages/shared/inbox/qwen-sessions.ts).
 *
 * Qwen Code reaches the Inbox through MCP (the stdio shim, which the connect
 * step adds with `qwen mcp add -s user`). It tells the processes it starts
 * which session they belong to (`QWEN_CODE_SESSION_ID`), and each running
 * session publishes a record at `$QWEN_HOME/sessions/<pid>.json` whose
 * `sessionId` follows `/clear` and `/resume` (Qwen's cross-session protocol,
 * schema version 1). Sessions a daemon runs (`qwen serve`) also name their
 * session on every tool call (`_meta["qwen-code/invocation"].sessionId`).
 */

/** The host id a Qwen Code session is recorded under. */
export const INBOX_QWEN_HOST = "qwen";

/** How the person sees a Qwen Code session. */
export const INBOX_QWEN_NAME = "Qwen Code";

/** Qwen Code's MCP client name (`initialize`'s `clientInfo.name`). */
export const INBOX_QWEN_MCP_CLIENT = "qwen-code-mcp-client";

/** The environment variable Qwen Code sets to its session id in the processes it starts (MCP servers, hooks, shell commands). */
export const INBOX_QWEN_SESSION_ENV = "QWEN_CODE_SESSION_ID";

/** The `_meta` key a daemon-run Qwen session puts its invocation (with `sessionId`) under on every MCP tool call. */
export const INBOX_QWEN_INVOCATION_META_KEY = "qwen-code/invocation";

/** The registry schema this reads; a record with a higher version is skipped (Qwen's protocol §1). */
export const INBOX_QWEN_REGISTRY_SCHEMA = 1;

/**
 * A Qwen session id: a UUID (Qwen mints them with randomUUID), optionally with
 * the suffix Qwen's Arena sessions carry (`-agent-…`). Nothing else is ever
 * taken as one: it names a socket frame's recipient and a claim folder.
 */
const QWEN_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:-[A-Za-z0-9_]{1,32}(?:-[A-Za-z0-9_]{1,32}){0,3})?$/i;

export function isQwenSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 160 && QWEN_SESSION_ID.test(value);
}

/** The session a daemon-run Qwen tool call names (`_meta["qwen-code/invocation"]`, version 1), or null. */
export function qwenSessionOfCall(meta: unknown): string | null {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return null;
  const invocation = (meta as Record<string, unknown>)[INBOX_QWEN_INVOCATION_META_KEY];
  if (!invocation || typeof invocation !== "object" || Array.isArray(invocation)) return null;
  const record = invocation as Record<string, unknown>;
  if (record.version !== 1) return null;
  return isQwenSessionId(record.sessionId) ? record.sessionId : null;
}

/** What one registry record says, once checked. */
export interface InboxQwenSessionRecord {
  pid: number;
  sessionId: string;
  /** `tui`, `headless`, `serve`, `external`, or another label Qwen adds later; `tui` when the record predates the field. */
  kind: string;
  /** The session's inbox socket, present only while it is bound. */
  ipcPath: string | null;
  /** What a connection to `ipcPath` presents on its auth line (64 hex); null when the inbox needs none. */
  ipcToken: string | null;
  /** `<boot id>:<start ticks>` on Linux, null elsewhere. */
  procStart: string | null;
  /** Inode of the writer's pid namespace on Linux, null elsewhere. */
  pidNs: number | null;
  /** Epoch ms. */
  startedAt: number;
  /** The record's file had the `<pid>-<8 hex>` form: a process hosting several sessions (ACP, the daemon). */
  shared: boolean;
}

/**
 * A registry file name's pid: `<pid>.json` or `<pid>-<8 lowercase hex>.json`,
 * the pid in canonical decimal (a zero-padded name agrees with nothing).
 */
export function qwenRecordFilePid(name: string): { pid: number; shared: boolean } | null {
  const match = /^([1-9]\d{0,9})(-[0-9a-f]{8})?\.json$/.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? { pid, shared: match[2] !== undefined } : null;
}

/**
 * One registry record, checked as Qwen's readers check it: schema version 1,
 * `pid` equal to the file name's, a session id of the right shape. Fields of
 * the wrong shape are dropped (a bad `ipcToken` makes the record unreachable,
 * never an auth line with junk in it). Null when the record is not usable.
 */
export function parseQwenSessionRecord(value: unknown, file: { pid: number; shared: boolean }): InboxQwenSessionRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== INBOX_QWEN_REGISTRY_SCHEMA) return null;
  if (record.pid !== file.pid) return null;
  if (!isQwenSessionId(record.sessionId)) return null;
  const kind = record.kind === undefined ? "tui" : typeof record.kind === "string" && /^[a-z0-9-]{1,16}$/.test(record.kind) ? record.kind : null;
  if (kind === null) return null;
  const ipcPath = typeof record.ipcPath === "string" && record.ipcPath.startsWith("/") && record.ipcPath.length < 1024 && !record.ipcPath.includes("\u0000") ? record.ipcPath : null;
  const ipcToken = typeof record.ipcToken === "string" && /^[0-9a-f]{64}$/i.test(record.ipcToken) ? record.ipcToken : null;
  // A token of the wrong shape: the inbox wants one, and this one would never pass, so the record cannot be messaged.
  const tokenBroken = record.ipcToken !== undefined && record.ipcToken !== null && ipcToken === null;
  return {
    pid: file.pid,
    sessionId: record.sessionId,
    kind,
    ipcPath: tokenBroken ? null : ipcPath,
    ipcToken,
    procStart: typeof record.procStart === "string" && record.procStart.length < 256 ? record.procStart : null,
    pidNs: typeof record.pidNs === "number" && Number.isSafeInteger(record.pidNs) ? record.pidNs : null,
    startedAt: typeof record.startedAt === "number" && Number.isFinite(record.startedAt) ? record.startedAt : 0,
    shared: file.shared,
  };
}
