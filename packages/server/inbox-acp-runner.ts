/**
 * Plannotator Inbox: sessions the Inbox runs itself over ACP, so every reply
 * in the thread is a real turn (spec "Inbox replies as real turns for Cursor
 * and Grok", step 1: Grok Build; Cursor is one more `INBOX_RUN_AGENTS` entry).
 *
 * Compose's "Start a new Grok Build session" makes a runner session (a key,
 * `run_<ulid>`, which is also its agent session id in the Inbox), writes the
 * person's first message as a thread addressed to it (compose's
 * `writeThread`), and the runner hands every message the session waits for
 * (`store.pendingReplies`) to the agent as one turn: the wake text the other
 * connections send (`inboxWakeText`), nothing else. No system prompt; the
 * runner adds only the Inbox's MCP server, so the agent answers with
 * `send_message reply_to`. A turn that ends with no Inbox message from the
 * session posts the turn's final text as the agent's message.
 *
 * One agent process per agent kind, in its own process group, started on
 * demand and stopped after 10 minutes idle (never while a permission waits),
 * killed on the Inbox's clean stop. Each turn opens the session (`session/new`
 * the first time, `session/load` after) and closes it after (`session/close`),
 * so the person can open it in Grok's own CLI between turns (`grok -r <id>`).
 * A `session/load` that fails sends nothing and says why: never a fallback to
 * a new session, which would lose the history.
 *
 * Permissions: the agent's own settings decide what it asks. Every request is
 * shown to the person with all its options, with no timeout; Stop answers
 * `cancelled`. The one exception: the agent's calls to the Inbox's own MCP
 * tools are allowed once, without a prompt.
 *
 * Secrets: Grok's `_x.ai/*` extension notifications can carry the person's
 * MCP server secrets. The ACP client hands this module only their method
 * names, and this module drops those too; it never logs, stores or forwards
 * raw ACP traffic or the agent's stderr. Activity is kept in memory only, as
 * tool titles and text chunks.
 *
 * The session table, `inbox/acp/sessions.json` (0600 in a 0700 folder):
 * `{ key, agent, acp_session_id, cwd, project_id, thread_id, created_at, turns }`.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RequestPermissionRequest, RequestPermissionResponse, SessionNotification } from "@agentclientprotocol/sdk";
import { AcpClient, type AgentLaunch } from "@plannotator/acp-client/client";
import { GROK, resolveAgentLaunch, type AgentDescriptor } from "@plannotator/acp-client/agents";
import { ownToolAutoAllow, type OwnTools } from "@plannotator/acp-client/permission-policy";
import {
  INBOX_RUN_AGENT_LABELS,
  type InboxRowRun,
  type InboxRunAgentId,
  type InboxRunAgentInfo,
  type InboxRunAgentsModel,
  type InboxRunPermission,
  type InboxRunPlace,
  type InboxRunState,
  type InboxRunStatus,
  type InboxRunTool,
  type InboxRunTurn,
} from "@plannotator/core/inbox-acp";
import { inboxId, isInboxNote, type InboxListRow, type InboxMessage, type InboxProject } from "@plannotator/core/inbox-types";
import { checkServerSession, INBOX_SERVER_SESSION_MISMATCH_ERROR, serverSessionMismatchBody } from "@plannotator/core/server-session";
import { loadConfig, saveConfig } from "@plannotator/shared/config";
import { inboxWakeText, type InboxReplyCommand } from "@plannotator/shared/inbox/connection";
import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";
import type { AgentEnvironment } from "./inbox-agents";
import type { createInboxLiveSessions } from "./inbox-sessions";

/** The MCP server the runner hands the agent: the Inbox's own (`plannotator inbox mcp`). */
export const INBOX_RUN_MCP_SERVER = "plannotator-inbox";
/** The Inbox's MCP tools: the agent's calls to these are allowed once without a prompt. */
const INBOX_TOOL_NAMES: ReadonlySet<string> = new Set(["send_message", "read_thread", "search", "resolve_message", "wait_for_reply", "get_guide_brief", "submit_guide", "card"]);
const OWN_TOOLS: OwnTools = { server: INBOX_RUN_MCP_SERVER, names: INBOX_TOOL_NAMES };

/** An agent the runner starts: its ACP launch, its name, how the person opens a session in its own CLI. */
export interface InboxRunAgent {
  id: InboxRunAgentId;
  descriptor: AgentDescriptor;
  /** The command that opens a session in the agent's own CLI, in its folder; absent when it has none (Cursor's CLI does not open ACP sessions). */
  resumeCommand?: (folder: string, acpSessionId: string) => string;
  /** It updates itself when it starts (Settings → Agents says so). */
  selfUpdates: boolean;
}

/** POSIX single quotes when the folder needs them. */
function shellWord(value: string): string {
  return /^[A-Za-z0-9_./~:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

export const INBOX_RUN_AGENTS: readonly InboxRunAgent[] = [
  {
    id: "grok",
    descriptor: GROK,
    // Verified live: a session made over ACP opens in Grok's CLI by id ("Session … found locally").
    resumeCommand: (folder, id) => `cd ${shellWord(folder)} && grok -r ${shellWord(id)}`,
    selfUpdates: true,
  },
];

/** A runner session agent is stopped after this long with no turn and no permission waiting. */
export const INBOX_RUN_IDLE_MS = 10 * 60_000;
/** After Stop, how long the agent gets to end the turn before its process group is killed. */
export const INBOX_RUN_STOP_GRACE_MS = 10_000;
const TURNS_KEPT = 50;
const TOOLS_KEPT = 20;
const TEXT_SHOWN = 4000;
const FINAL_TEXT_MAX = 100_000;

interface SessionRecord {
  key: string;
  agent: InboxRunAgentId;
  acp_session_id: string | null;
  cwd: string;
  project_id: string;
  thread_id: string | null;
  created_at: string;
  turns: InboxRunTurn[];
}

interface SessionsFile {
  v: 1;
  sessions: SessionRecord[];
}

/** What a turn holds while it runs: memory only. */
interface LiveTurn {
  record: InboxRunTurn;
  /** The replies it was started for (not delivered until the prompt is sent). */
  replies: InboxMessage[];
  state: InboxRunState;
  tools: InboxRunTool[];
  text: string;
  /** The text since the last tool call: the agent's final words. */
  segment: string;
  permission: (InboxRunPermission & { answer: (response: RequestPermissionResponse) => void }) | null;
  approveRest: boolean;
  stopRequested: boolean;
  stopTimer: ReturnType<typeof setTimeout> | null;
  /** The ACP session id this turn opened (so updates find it). */
  acpSessionId: string | null;
  /** session/load is replaying: its updates are history, not this turn. */
  loading: boolean;
}

interface AgentProcess {
  client: AcpClient | null;
  starting: Promise<AcpClient> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export interface InboxRunLaunchOverride {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface InboxAcpRunnerOptions {
  store: InboxStore;
  dataDir: string;
  serverSession: string;
  version: string;
  live: ReturnType<typeof createInboxLiveSessions>;
  /** The argv that runs this CLI (the agent's MCP server is `<selfCommand> inbox mcp`). */
  selfCommand: readonly string[];
  /** Where agents are found and run (PATH, home, env). */
  environment: AgentEnvironment;
  /** A folder to its project (send_message's resolver). */
  resolveProject: (path: string) => Promise<InboxProject>;
  /** The command a polling connection would get for this reply (inbox.ts `replyCommand`). */
  replyCommand: (reply: InboxMessage, sendNow: boolean, session: string | null) => InboxReplyCommand;
  /** Compose's Send, once its target is known (inbox-compose.ts). */
  compose: {
    replayThread: (body: Record<string, unknown>) => unknown | null;
    checkSend: (body: Record<string, unknown>) => unknown[];
    writeThread: (body: Record<string, unknown>, uploads: unknown[], to: { host: string; session: string }, project: InboxProject) => unknown;
  };
  /** A folder as the window shows it (`~`). */
  displayPath: (path: string) => string;
  /** Something the window draws changed (a run started, ended, a permission arrived). `permission` is set for a new request. */
  onChange: (change: { key: string; threadIds: string[]; permission?: { title: string; label: string; threadId: string | null; replyId: string | null } }) => void;
  /** Tests: start these instead of the agent's own program (the fake ACP agent). No version check then. */
  launches?: Partial<Record<InboxRunAgentId, InboxRunLaunchOverride>>;
  /** Tests: shorter idle and Stop timers. */
  idleMs?: number;
  stopGraceMs?: number;
  now?: () => Date;
}

const iso = (date: Date) => date.toISOString();

export function createInboxAcpRunner(options: InboxAcpRunnerOptions) {
  const { store, live, environment } = options;
  const now = options.now ?? (() => new Date());
  const idleMs = options.idleMs ?? INBOX_RUN_IDLE_MS;
  const stopGraceMs = options.stopGraceMs ?? INBOX_RUN_STOP_GRACE_MS;
  const dir = join(options.dataDir, "inbox", "acp");
  const file = join(dir, "sessions.json");
  const agentById = new Map(INBOX_RUN_AGENTS.map((agent) => [agent.id, agent]));

  // ── The session table ──

  const sessions = new Map<string, SessionRecord>();
  const read = (): void => {
    try {
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as SessionsFile;
      for (const record of Array.isArray(parsed?.sessions) ? parsed.sessions : []) {
        if (!record || typeof record.key !== "string" || !agentById.has(record.agent)) continue;
        sessions.set(record.key, { ...record, turns: Array.isArray(record.turns) ? record.turns : [] });
      }
    } catch (error) {
      process.stderr.write(`Inbox: ${file} could not be read, so no earlier runner session is known: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  /** Written whole (temp, then rename). A write that fails is said on stderr; the turn goes on. */
  const write = (): void => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Best effort: a filesystem without modes.
      }
      const body: SessionsFile = { v: 1, sessions: [...sessions.values()] };
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, file);
    } catch (error) {
      process.stderr.write(`Inbox: ${file} could not be written: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };
  read();
  // A turn that had no end when the Inbox stopped: interrupted (its replies were delivered; they are not sent again).
  let repaired = false;
  for (const record of sessions.values()) {
    for (const turn of record.turns) {
      if (turn.ended_at === null) {
        turn.ended_at = turn.started_at;
        turn.outcome = "interrupted";
        repaired = true;
      }
    }
  }
  if (repaired) write();
  for (const record of sessions.values()) live.registerRunnerSession(record.key, record.agent, record.cwd, Date.parse(record.created_at) || Date.now());

  // ── Memory: turns, processes, launches ──

  const turns = new Map<string, LiveTurn>();
  /** The last turn's activity per session, after it ended (memory only). */
  const lastActivity = new Map<string, { tools: InboxRunTool[]; text: string }>();
  /** Replies a failed turn carried: not tried again by themselves (a new message or Try again does). */
  const attempted = new Map<string, Set<string>>();
  const processes = new Map<InboxRunAgentId, AgentProcess>();
  let stopped = false;

  const changed = (key: string, permission?: { title: string }) => {
    const record = sessions.get(key);
    const turn = turns.get(key);
    const threadIds = [...new Set([record?.thread_id, ...(turn?.replies ?? []).map((reply) => reply.thread_id)].filter((id): id is string => !!id))];
    const label = record ? INBOX_RUN_AGENT_LABELS[record.agent] : "";
    try {
      options.onChange({
        key,
        threadIds,
        ...(permission ? { permission: { title: permission.title, label, threadId: turn?.replies.at(-1)?.thread_id ?? record?.thread_id ?? null, replyId: turn?.replies.at(-1)?.id ?? null } } : {}),
      });
    } catch {
      // A listener's failure never stops a turn.
    }
  };

  const enabled = (id: InboxRunAgentId): boolean => (loadConfig().inboxRun ?? {})[id] !== false;

  /** The agent's program, checked to answer like itself; cached for a minute. */
  const launchCache = new Map<InboxRunAgentId, { at: number; answer: { ok: true; launch: Omit<AgentLaunch, "cwd"> } | { ok: false; reason: string } }>();
  const resolveLaunch = async (agent: InboxRunAgent): Promise<{ ok: true; launch: Omit<AgentLaunch, "cwd"> } | { ok: false; reason: string }> => {
    const override = options.launches?.[agent.id];
    if (override) return { ok: true, launch: { command: override.command, args: override.args, ...(override.env ? { env: override.env } : {}) } };
    const cached = launchCache.get(agent.id);
    if (cached && Date.now() - cached.at < 60_000) return cached.answer;
    const label = agent.descriptor.label;
    let answer: { ok: true; launch: Omit<AgentLaunch, "cwd"> } | { ok: false; reason: string };
    const resolved = resolveAgentLaunch(agent.descriptor, {}, (name) => environment.which(name), undefined, environment.platform);
    if (!resolved.ok) {
      answer = { ok: false, reason: `${label} is not installed: \`${agent.descriptor.command}\` is not on PATH. Install it with \`${agent.descriptor.installCommand}\`.` };
    } else {
      const ran = await environment.run([resolved.command, "--version"], { timeoutMs: 10_000 });
      const line = ran.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? "";
      answer =
        ran.exitCode === 0 && agent.descriptor.versionShape?.test(line) !== false
          ? { ok: true, launch: { command: resolved.command, args: resolved.args } }
          : { ok: false, reason: `\`${resolved.command}\` did not answer like ${label}.` };
    }
    launchCache.set(agent.id, { at: Date.now(), answer });
    return answer;
  };

  /** The environment the agent starts with: the person's, without another session's tag (its shell would send as that session). */
  const agentEnv = (): Record<string, string | undefined> => {
    const env: Record<string, string | undefined> = { ...environment.env };
    delete env.PLANNOTATOR_SESSION_TAG;
    delete env.PI_SESSION_ID;
    return env;
  };

  /** The Inbox's MCP server for one session: the shim names the session in its own environment. */
  const mcpServers = (record: SessionRecord) => {
    const [command, ...rest] = options.selfCommand;
    return [
      {
        name: INBOX_RUN_MCP_SERVER,
        command: command!,
        args: [...rest, "inbox", "mcp"],
        env: [
          { name: "PLANNOTATOR_SESSION_TAG", value: `${record.agent}:${record.key}` },
          { name: "PLANNOTATOR_DATA_DIR", value: options.dataDir },
          { name: "PLANNOTATOR_CWD", value: record.cwd },
        ],
      },
    ];
  };

  /** The session a notification or request is for, by the agent's session id. */
  const keyOfAcp = (acpSessionId: string): string | null => {
    for (const [key, turn] of turns) if (turn.acpSessionId === acpSessionId) return key;
    return null;
  };

  const onUpdate = (notification: SessionNotification) => {
    const key = keyOfAcp(notification.sessionId);
    const turn = key ? turns.get(key) : null;
    if (!key || !turn || turn.loading) return;
    const update = notification.update as { sessionUpdate: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string | null; status?: string | null };
    if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text" && typeof update.content.text === "string") {
      turn.text = (turn.text + update.content.text).slice(-TEXT_SHOWN);
      turn.segment = (turn.segment + update.content.text).slice(-FINAL_TEXT_MAX);
      notifySoon(key);
    } else if (update.sessionUpdate === "tool_call" && typeof update.toolCallId === "string") {
      turn.segment = "";
      turn.tools.push({ id: update.toolCallId, title: typeof update.title === "string" && update.title ? update.title.slice(0, 300) : "Tool", status: update.status ?? "pending" });
      if (turn.tools.length > TOOLS_KEPT) turn.tools.splice(0, turn.tools.length - TOOLS_KEPT);
      notifySoon(key);
    } else if (update.sessionUpdate === "tool_call_update" && typeof update.toolCallId === "string") {
      const tool = turn.tools.find((t) => t.id === update.toolCallId);
      if (tool) {
        if (typeof update.status === "string") tool.status = update.status;
        if (typeof update.title === "string" && update.title) tool.title = update.title.slice(0, 300);
        notifySoon(key);
      }
    }
    // Everything else (thoughts, plans, commands, usage) is not shown and not kept.
  };

  /** Activity streams in: the window is told at most twice a second. */
  const notifyTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const notifySoon = (key: string) => {
    if (notifyTimers.has(key)) return;
    notifyTimers.set(
      key,
      setTimeout(() => {
        notifyTimers.delete(key);
        changed(key);
      }, 500),
    );
  };

  const onPermission = (request: RequestPermissionRequest, signal: AbortSignal): Promise<RequestPermissionResponse> => {
    // The Inbox's own tools: allowed once, without a prompt.
    const own = ownToolAutoAllow(request, OWN_TOOLS);
    if (own) return Promise.resolve({ outcome: { outcome: "selected", optionId: own } });
    const key = keyOfAcp(request.sessionId);
    const turn = key ? turns.get(key) : null;
    if (!key || !turn) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    if (turn.approveRest) {
      const allow = request.options.find((o) => o.kind === "allow_once") ?? request.options.find((o) => o.kind === "allow_always");
      if (allow) return Promise.resolve({ outcome: { outcome: "selected", optionId: allow.optionId } });
    }
    return new Promise((resolve) => {
      const id = `prm_${crypto.randomUUID()}`;
      const title = typeof request.toolCall.title === "string" && request.toolCall.title ? request.toolCall.title.slice(0, 500) : "A tool";
      const answer = (response: RequestPermissionResponse) => {
        if (turn.permission?.id !== id) return;
        turn.permission = null;
        turn.state = "working";
        live.setRunnerBusy(key, true);
        resolve(response);
        changed(key);
      };
      turn.permission = {
        id,
        title,
        kind: typeof request.toolCall.kind === "string" ? request.toolCall.kind : null,
        options: request.options.map((o) => ({ id: o.optionId, name: o.name, kind: o.kind })),
        at: iso(now()),
        answer,
      };
      turn.state = "permission";
      signal.addEventListener("abort", () => answer({ outcome: { outcome: "cancelled" } }), { once: true });
      changed(key, { title });
    });
  };

  const scheduleIdle = (agentId: InboxRunAgentId) => {
    const proc = processes.get(agentId);
    if (!proc) return;
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = null;
    const busy = [...turns.keys()].some((key) => sessions.get(key)?.agent === agentId);
    if (busy) return;
    proc.idleTimer = setTimeout(() => {
      proc.idleTimer = null;
      if ([...turns.keys()].some((key) => sessions.get(key)?.agent === agentId)) return;
      proc.client?.dispose();
      processes.delete(agentId);
    }, idleMs);
    (proc.idleTimer as { unref?: () => void }).unref?.();
  };

  const ensureClient = async (agent: InboxRunAgent, cwd: string): Promise<AcpClient> => {
    let proc = processes.get(agent.id);
    if (proc?.client && !proc.client.hasExited) {
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      proc.idleTimer = null;
      return proc.client;
    }
    if (proc?.starting) return proc.starting;
    const resolved = await resolveLaunch(agent);
    if (!resolved.ok) throw new InboxError("agent_unavailable", resolved.reason);
    proc = { client: null, starting: null, idleTimer: null };
    processes.set(agent.id, proc);
    const starting = AcpClient.start(
      { ...resolved.launch, cwd },
      {
        onUpdate,
        requestPermission: onPermission,
        // Never logged or kept: an agent's stderr may hold anything.
        onStderr: () => {},
        // Method names only reach here; nothing is kept.
        onExtNotification: () => {},
        onExit: () => {
          const current = processes.get(agent.id);
          if (current === proc) processes.delete(agent.id);
        },
      },
      { name: "plannotator-inbox", title: "Plannotator Inbox", version: options.version },
      { env: agentEnv(), augmentPath: false },
    ).then(
      (client) => {
        proc!.client = client;
        proc!.starting = null;
        return client;
      },
      (error) => {
        if (processes.get(agent.id) === proc) processes.delete(agent.id);
        throw error;
      },
    );
    proc.starting = starting;
    return starting;
  };

  /** Plain words for a failed turn, never the agent's stderr. */
  const failureWords = (error: unknown, client: AcpClient | null, label: string): string => {
    if (error instanceof InboxError) return error.message;
    if (client?.hasExited) return `${label} stopped while it ran.`;
    const message = error instanceof Error ? error.message : String(error);
    return message.split("\n")[0]!.slice(0, 300) || `${label} could not run this.`;
  };

  // ── Turns ──

  /** The person's messages a session waits for: notes (👍, set aside) are recorded as delivered, never a turn. */
  const waiting = (key: string): InboxMessage[] => {
    const record = sessions.get(key)!;
    const out: InboxMessage[] = [];
    for (const reply of store.pendingReplies(key, { tags: false })) {
      if (isInboxNote(reply)) {
        try {
          store.recordDelivery(reply.id, { host: record.agent, session: key });
        } catch {
          // Already taken.
        }
        continue;
      }
      out.push(reply);
    }
    return out;
  };

  const pump = () => {
    if (stopped) return;
    for (const key of sessions.keys()) {
      if (turns.has(key)) continue;
      const replies = waiting(key);
      if (replies.length === 0) continue;
      // A failed turn's replies wait for a new message or Try again.
      const tried = attempted.get(key);
      if (tried && replies.every((reply) => tried.has(reply.id))) continue;
      void runTurn(key, replies);
    }
  };

  const runTurn = async (key: string, replies: InboxMessage[]): Promise<void> => {
    const record = sessions.get(key)!;
    const agent = agentById.get(record.agent)!;
    const label = agent.descriptor.label;
    const turnRecord: InboxRunTurn = { replies: replies.map((r) => r.id), started_at: iso(now()), ended_at: null, outcome: null, error: null, answered: null };
    const turn: LiveTurn = {
      record: turnRecord,
      replies,
      state: "starting",
      tools: [],
      text: "",
      segment: "",
      permission: null,
      approveRest: false,
      stopRequested: false,
      stopTimer: null,
      acpSessionId: record.acp_session_id,
      loading: false,
    };
    turns.set(key, turn);
    record.turns.push(turnRecord);
    if (record.turns.length > TURNS_KEPT) record.turns.splice(0, record.turns.length - TURNS_KEPT);
    write();
    live.setRunnerBusy(key, true);
    changed(key);
    let client: AcpClient | null = null;
    let delivered = false;
    let opened = false;
    try {
      client = await ensureClient(agent, record.cwd);
      if (turn.stopRequested) throw new StopBeforePrompt();
      if (record.acp_session_id === null) {
        const made = await client.newSession(record.cwd, mcpServers(record));
        record.acp_session_id = made.sessionId;
        turn.acpSessionId = made.sessionId;
        write();
      } else {
        if (!client.agentCapabilities.loadSession) {
          throw new InboxError("agent_unavailable", `${label} cannot reopen this session (it does not offer session/load), so nothing was sent.`);
        }
        turn.loading = true;
        try {
          await client.loadSession(record.acp_session_id, record.cwd, mcpServers(record));
        } catch (error) {
          throw new InboxError("agent_unavailable", `${label} could not reopen this session, so nothing was sent: ${failureWords(error, client, label)}`);
        } finally {
          turn.loading = false;
        }
      }
      opened = true;
      if (turn.stopRequested) throw new StopBeforePrompt();
      // Delivered as the prompt goes: the reply is never sent again, even if the turn is interrupted.
      for (const reply of replies) {
        try {
          store.recordDelivery(reply.id, { host: record.agent, session: key });
        } catch {
          // Taken meanwhile (an agent read it): it still goes in this turn.
        }
      }
      delivered = true;
      attempted.delete(key);
      turn.state = "working";
      changed(key);
      const text = replies.map((reply) => inboxWakeText(options.replyCommand(reply, false, key), INBOX_RUN_MCP_SERVER)).join("\n\n");
      const answer = await client.prompt(record.acp_session_id!, text);
      turnRecord.outcome = answer.stopReason === "cancelled" || turn.stopRequested ? "stopped" : "done";
    } catch (error) {
      if (error instanceof StopBeforePrompt || turn.stopRequested) {
        turnRecord.outcome = "stopped";
      } else {
        turnRecord.outcome = "failed";
        turnRecord.error = failureWords(error, client, label);
      }
      if (!delivered) attempted.set(key, new Set(replies.map((r) => r.id)));
    } finally {
      if (turn.stopTimer) clearTimeout(turn.stopTimer);
      turn.permission?.answer({ outcome: { outcome: "cancelled" } });
      if (!stopped) {
        turnRecord.answered = delivered ? postFinalText(record, turn) : null;
        turnRecord.ended_at = iso(now());
        if (opened && client && record.acp_session_id) await client.closeSession(record.acp_session_id);
        lastActivity.set(key, { tools: turn.tools, text: turn.text });
        turns.delete(key);
        write();
        live.setRunnerBusy(key, false);
        changed(key);
        scheduleIdle(agent.id);
        pump();
      }
    }
  };

  /** No Inbox message from the session this turn: post the turn's final text as its message. */
  const postFinalText = (record: SessionRecord, turn: LiveTurn): InboxRunTurn["answered"] => {
    const latest = store.latestAgentMessages().get(record.key);
    if (latest && latest.created_at >= turn.record.started_at) return "inbox";
    const text = (turn.segment.trim() || turn.text.trim()).slice(-FINAL_TEXT_MAX);
    const reply = turn.replies.at(-1);
    if (!text || !reply) return "none";
    try {
      store.sendMessage({
        project_id: reply.project_id,
        author: { kind: "agent", host: record.agent, session: record.key, name: INBOX_RUN_AGENT_LABELS[record.agent] },
        body: text,
        reply_to: reply.id,
        idempotency_key: `acp-final-${reply.id}`,
        wakes: true,
      });
      return "final_text";
    } catch (error) {
      process.stderr.write(`Inbox: ${INBOX_RUN_AGENT_LABELS[record.agent]}'s final text could not be posted: ${error instanceof Error ? error.message : String(error)}\n`);
      return "none";
    }
  };

  // A person's message to a runner session starts (or queues) its turn.
  const unsubscribe = store.subscribe((line) => {
    if (line.kind !== "message" || line.record.author.kind !== "person") return;
    queueMicrotask(pump);
  });
  queueMicrotask(pump);

  // ── What the window reads ──

  const status = (key: string): InboxRunStatus => {
    const record = sessions.get(key);
    if (!record) throw new InboxError("run_not_found", `No runner session ${key}.`);
    const agent = agentById.get(record.agent)!;
    const turn = turns.get(key) ?? null;
    const activity = turn ? { tools: turn.tools, text: turn.text } : (lastActivity.get(key) ?? { tools: [], text: "" });
    const queued = store.pendingReplies(key, { tags: false }).filter((r) => !isInboxNote(r) && !(turn?.replies ?? []).some((t) => t.id === r.id)).map((r) => r.id);
    return {
      key,
      agent: record.agent,
      label: agent.descriptor.label,
      cwd: record.cwd,
      cwd_display: options.displayPath(record.cwd),
      acp_session_id: record.acp_session_id,
      thread_id: record.thread_id,
      state: turn?.state ?? "idle",
      turn: turn?.record ?? record.turns.at(-1) ?? null,
      turns: record.turns,
      permission: turn?.permission ? { id: turn.permission.id, title: turn.permission.title, kind: turn.permission.kind, options: turn.permission.options, at: turn.permission.at } : null,
      activity: { tools: activity.tools.map((t) => ({ ...t })), text: activity.text },
      queued,
      resume_command: record.acp_session_id && agent.resumeCommand ? agent.resumeCommand(options.displayPath(record.cwd), record.acp_session_id) : null,
      approve_rest: turn?.approveRest ?? false,
    };
  };

  /** A row's run, for the list model: the session's thread, or a thread a running turn carries a reply of. */
  const rowRun = (threadId: string): InboxRowRun | null => {
    for (const [key, turn] of turns) {
      const record = sessions.get(key)!;
      if (record.thread_id !== threadId && !turn.replies.some((r) => r.thread_id === threadId)) continue;
      return {
        key,
        agent: record.agent,
        label: INBOX_RUN_AGENT_LABELS[record.agent],
        state: turn.state,
        permission_title: turn.permission?.title ?? null,
        permission_id: turn.permission?.id ?? null,
      };
    }
    return null;
  };

  /** The row as the window's list shows it: a waiting permission puts it in Stopped on you. */
  const decorateRow = (row: InboxListRow): InboxListRow => {
    const run = rowRun(row.thread_id);
    if (!run) return row;
    return run.state === "permission" ? { ...row, run, section: "stopped", unread: true } : { ...row, run };
  };

  /** Whether a thread's messages go to a session the runner runs (the tailnet's guests may not steer one). */
  const runsThread = (threadId: string): boolean => {
    const thread = store.thread(threadId);
    if (!thread) return false;
    return thread.messages.some((m) => (m.to && sessions.has(m.to.session)) || (m.author.kind === "agent" && !!m.author.session && sessions.has(m.author.session)));
  };

  const places = (): InboxRunPlace[] => {
    const lastThreads = store.lastThreadsBySession();
    const activity = new Map<string, string>();
    for (const last of lastThreads.values()) {
      const known = activity.get(last.project_id);
      if (!known || known < last.at) activity.set(last.project_id, last.at);
    }
    for (const row of store.listRows()) {
      const known = activity.get(row.project.id);
      if (!known || known < row.last_at) activity.set(row.project.id, row.last_at);
    }
    return store
      .listProjects()
      .filter((project) => {
        try {
          return statSync(project.root).isDirectory();
        } catch {
          return false;
        }
      })
      .sort((a, b) => (activity.get(b.id) ?? "").localeCompare(activity.get(a.id) ?? "") || a.name.localeCompare(b.name))
      .map((project) => ({ project_id: project.id, name: project.name, root: project.root, root_display: options.displayPath(project.root) }));
  };

  const agentsModel = async (): Promise<InboxRunAgentsModel> => {
    const agents: InboxRunAgentInfo[] = [];
    for (const agent of INBOX_RUN_AGENTS) {
      const on = enabled(agent.id);
      const resolved = await resolveLaunch(agent);
      agents.push({
        id: agent.id,
        label: agent.descriptor.label,
        installed: resolved.ok,
        reason: !resolved.ok ? resolved.reason : on ? null : `Turned off in Settings → Agents.`,
        enabled: on,
        install_command: agent.descriptor.installCommand,
        self_updates: agent.selfUpdates,
      });
    }
    return { agents, places: places() };
  };

  /** Compose's "Start a new … session": the session, then the thread addressed to it. */
  const start = async (body: Record<string, unknown>): Promise<unknown> => {
    const replay = options.compose.replayThread(body);
    if (replay) return replay;
    const agent = typeof body.agent === "string" ? agentById.get(body.agent as InboxRunAgentId) : undefined;
    if (!agent) throw new InboxError("validation_error", "agent: one the Inbox can start (grok).", { field: "agent" });
    const uploads = options.compose.checkSend(body);
    if (!enabled(agent.id)) throw new InboxError("agent_unavailable", `${agent.descriptor.label} is turned off in Settings → Agents.`);
    const resolved = await resolveLaunch(agent);
    if (!resolved.ok) throw new InboxError("agent_unavailable", resolved.reason);
    const projectId = typeof body.project_id === "string" ? body.project_id : null;
    const known = projectId ? store.project(projectId) : null;
    if (!known) throw new InboxError("place_not_found", "project_id: a project of this Inbox whose folder exists.", { field: "project_id" });
    try {
      if (!statSync(known.root).isDirectory()) throw new Error("not a folder");
    } catch {
      throw new InboxError("place_not_found", `${known.root} is not a folder on this computer any more.`);
    }
    const key = inboxId("run");
    const record: SessionRecord = { key, agent: agent.id, acp_session_id: null, cwd: known.root, project_id: known.id, thread_id: null, created_at: iso(now()), turns: [] };
    sessions.set(key, record);
    write();
    live.registerRunnerSession(key, agent.id, known.root, Date.now());
    try {
      const result = options.compose.writeThread(body, uploads, { host: agent.id, session: key }, known) as { thread_id: string; replayed?: boolean };
      record.thread_id = result.thread_id;
      write();
      changed(key);
      return { ...result, run: { key, agent: agent.id } };
    } catch (error) {
      // Nothing was written for it: the session goes too.
      sessions.delete(key);
      write();
      throw error;
    }
  };

  const stopTurn = (key: string) => {
    const record = sessions.get(key);
    if (!record) throw new InboxError("run_not_found", `No runner session ${key}.`);
    const turn = turns.get(key);
    if (!turn) return status(key);
    turn.stopRequested = true;
    const client = processes.get(record.agent)?.client ?? null;
    turn.permission?.answer({ outcome: { outcome: "cancelled" } });
    if (client && turn.acpSessionId) void client.cancel(turn.acpSessionId);
    // An agent that does not end the turn: its process group is killed.
    turn.stopTimer ??= setTimeout(() => {
      if (turns.get(key) !== turn) return;
      client?.dispose();
    }, stopGraceMs);
    changed(key);
    return status(key);
  };

  const answerPermission = (key: string, body: Record<string, unknown>) => {
    const turn = turns.get(key);
    if (!sessions.has(key)) throw new InboxError("run_not_found", `No runner session ${key}.`);
    const waiting = turn?.permission;
    if (!turn || !waiting || body.permission_id !== waiting.id) throw new InboxError("permission_not_found", "That request is not waiting any more.");
    const optionId = body.option_id;
    if (typeof optionId !== "string" || !waiting.options.some((o) => o.id === optionId)) {
      throw new InboxError("validation_error", "option_id: one of the request's options.", { field: "option_id" });
    }
    if (body.approve_rest === true) turn.approveRest = true;
    waiting.answer({ outcome: { outcome: "selected", optionId } });
    return status(key);
  };

  const setEnabled = (id: InboxRunAgentId, on: boolean) => {
    const current = loadConfig().inboxRun ?? {};
    saveConfig({ inboxRun: { ...current, [id]: on } });
  };

  // ── Routes ──

  const keyMatch = (path: string, suffix: string) => new RegExp(`^/api/inbox/acp/(run_[0-9A-HJKMNP-TV-Z]{26})${suffix}$`).exec(path)?.[1] ?? null;

  /**
   * The window's routes (same origin and serverSession, as every window
   * write). `owner`: false for a tailnet guest (a login in
   * inboxTailscaleAllow, not the machine's owner), who may not start or steer.
   */
  const route = async (req: Request, url: URL, context: { owner: boolean; readBody: (req: Request) => Promise<Record<string, unknown>>; json: (body: unknown, status?: number) => Response }): Promise<Response | null> => {
    const path = url.pathname;
    if (path !== "/api/inbox/acp" && !path.startsWith("/api/inbox/acp/")) return null;
    const { json } = context;
    if (!context.owner) throw new InboxError("owner_only", "Only this computer's owner can start or steer an agent the Inbox runs.");
    if (req.method === "GET") {
      if (path === "/api/inbox/acp") return json(await agentsModel());
      const key = keyMatch(path, "");
      if (key) return json({ serverSession: options.serverSession, run: status(key) });
      return json({ error: "Not found", code: "not_found" }, 404);
    }
    if (req.method !== "POST") return json({ error: "Use POST." }, 405);
    const body = await context.readBody(req);
    if (checkServerSession(body, options.serverSession) === "mismatch") return json(serverSessionMismatchBody(INBOX_SERVER_SESSION_MISMATCH_ERROR), 409);
    if (path === "/api/inbox/acp/start") return json(await start(body));
    const agentMatch = /^\/api\/inbox\/acp\/agents\/([a-z-]+)$/.exec(path);
    if (agentMatch) {
      const agent = agentById.get(agentMatch[1] as InboxRunAgentId);
      if (!agent) return json({ error: "Not found", code: "not_found" }, 404);
      if (typeof body.enabled !== "boolean") throw new InboxError("validation_error", "enabled: true or false.", { field: "enabled" });
      setEnabled(agent.id, body.enabled);
      return json(await agentsModel());
    }
    const stopKey = keyMatch(path, "/stop");
    if (stopKey) return json({ run: stopTurn(stopKey) });
    const permissionKey = keyMatch(path, "/permission");
    if (permissionKey) return json({ run: answerPermission(permissionKey, body) });
    const retryKey = keyMatch(path, "/retry");
    if (retryKey) {
      if (!sessions.has(retryKey)) throw new InboxError("run_not_found", `No runner session ${retryKey}.`);
      attempted.delete(retryKey);
      pump();
      return json({ run: status(retryKey) });
    }
    return json({ error: "Not found", code: "not_found" }, 404);
  };

  /** Everything the rows show, as one string: the server compares it to tell windows when to read again. */
  const signature = (): string => [...turns].map(([key, turn]) => `${key}:${turn.state}:${turn.permission?.id ?? ""}`).join("|");

  /**
   * The Inbox's clean stop (and a restart to update): every running turn reads
   * "Interrupted", and every agent process goes with its process group.
   */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribe();
    for (const timer of notifyTimers.values()) clearTimeout(timer);
    for (const [key, turn] of turns) {
      turn.record.outcome = "interrupted";
      turn.record.ended_at = iso(now());
      if (turn.stopTimer) clearTimeout(turn.stopTimer);
      live.setRunnerBusy(key, false);
    }
    if (turns.size > 0) write();
    for (const proc of processes.values()) {
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      proc.client?.kill();
      void proc.starting?.then((client) => client.kill()).catch(() => {});
    }
    processes.clear();
  };

  return {
    route,
    status,
    decorateRow,
    runsThread,
    signature,
    stop,
    agentsModel,
    /** Tests: the agent processes running now (their pids). */
    pids: (): number[] => [...processes.values()].map((p) => p.client?.pid).filter((pid): pid is number => typeof pid === "number"),
    isRunnerSession: (session: string) => sessions.has(session),
  };
}

/** Stop arrived before the prompt went: nothing was sent. */
class StopBeforePrompt extends Error {}
