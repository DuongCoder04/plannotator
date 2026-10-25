/**
 * The Codex wake (inbox-codex-wake.ts), through the Inbox's real doors: a
 * Codex thread's send_message over MCP (the SDK client, with the `_meta`
 * Codex puts on every tool call), the person's reply route, the tag and New
 * message routes, and a fake `codex` on a scratch PATH that logs its argv
 * (tests/helpers/fake-agents.ts). The real Codex is never run.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { INBOX_CODEX_MESSAGE_MAX_BYTES, codexQueueMessage } from "./inbox-codex-wake";
import { codexCliQueues, codexThreadOfCall, codexTurnStartedAt, isCodexThreadId, parseCodexCliVersion, type InboxThread } from "@plannotator/core/inbox-types";
import {
  INBOX_BRIDGE_POLL_PATH,
  INBOX_MESSAGE_INSTRUCTION,
  INBOX_TAGGED_INSTRUCTION,
  INBOX_TAGS_POLL_FIELD,
  INBOX_WAKE_INSTRUCTION,
  inboxWakeText,
} from "@plannotator/shared/inbox/connection";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { createAgentEnvironmentFor } from "./inbox-agents";
import { startInboxServer, type InboxServer } from "./inbox";
import { INBOX_REPLY_ARRIVES_TEXT } from "./inbox-mcp";

const THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5b";
const OTHER_THREAD = "019a2b3c-4d5e-7f00-8a9b-0c1d2e3f4a5c";

const fakes: FakeAgents[] = [];
const servers: InboxServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close().catch(() => {});
  for (const server of servers.splice(0)) server.stop();
  // Throws when a fake CLI outlived the test.
  for (const fake of fakes.splice(0)) fake.remove();
});

interface World {
  fake: FakeAgents;
  dataDir: string;
  project: string;
  server: InboxServer;
  client: Client;
  start: () => Promise<InboxServer>;
}

async function world(options: { codex?: boolean; env?: Record<string, string> } = {}): Promise<World> {
  const fake = createFakeAgents("plannotator-codex-wake-");
  fakes.push(fake);
  if (options.codex !== false) fake.install("codex");
  const dataDir = join(fake.root, "data");
  const project = join(fake.root, "ledger");
  mkdirSync(project, { recursive: true });
  const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...options.env } });
  const start = async () => {
    const server = await startInboxServer({ dataDir, agentEnvironment: environment, codexWake: { extraClis: [], sweepMs: 60_000 } });
    servers.push(server);
    return server;
  };
  const server = await start();
  const client = await connect(server);
  return { fake, dataDir, project, server, client, start };
}

async function connect(server: InboxServer): Promise<Client> {
  const client = new Client({ name: "codex-mcp-client", version: "0.160.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`)));
  clients.push(client);
  return client;
}

/** What Codex puts on every tool call (seen on codex-cli 0.160.0). */
function codexMeta(thread: string, turnStartedAt = Date.now()) {
  return { threadId: thread, sessionId: thread, "x-codex-turn-metadata": { thread_id: thread, turn_started_at_unix_ms: turnStartedAt, codex_version: "0.160.0" } };
}

async function codexSends(client: Client, project: string, body: string, thread = THREAD) {
  const result = await client.callTool({
    name: "send_message",
    arguments: { body, project_path: project, agent_session: thread, agent_host: "codex", agent_name: "Codex" },
    _meta: codexMeta(thread),
  });
  const text = (result.content as { text: string }[])[0]!.text;
  return { ...(result.structuredContent as { message_id: string; thread_id: string }), text };
}

const base = (server: InboxServer) => `http://127.0.0.1:${server.port}`;

function reply(server: InboxServer, messageId: string, body: Record<string, unknown>) {
  return fetch(`${base(server)}/api/inbox/messages/${messageId}/reply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ serverSession: server.serverSession, ...body }),
  });
}

async function thread(server: InboxServer, threadId: string): Promise<InboxThread> {
  return ((await (await fetch(`${base(server)}/api/inbox/threads/${threadId}`)).json()) as { thread: InboxThread }).thread;
}

const queues = (fake: FakeAgents) => fake.calls().filter((call) => call.name === "codex" && call.args[0] === "queue");
const argOf = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? null;

describe("the pure parts", () => {
  test("a thread id is a UUID; nothing else is ever handed to codex queue", () => {
    expect(isCodexThreadId(THREAD)).toBe(true);
    for (const bad of ["", "abc", `${THREAD} `, `-${THREAD.slice(1)}`, "--yolo", "ses_01ABC", `${THREAD}x`]) expect(isCodexThreadId(bad)).toBe(false);
  });

  test("codex queue needs Codex CLI 0.149 or later; the ChatGPT app's alpha versions count", () => {
    expect(parseCodexCliVersion("codex-cli 0.160.0\n")).toEqual([0, 160, 0]);
    expect(parseCodexCliVersion("codex-cli 0.164.0-alpha.11.1")).toEqual([0, 164, 0]);
    expect(parseCodexCliVersion("0.160.0")).toBeNull();
    expect(codexCliQueues([0, 149, 0])).toBe(true);
    expect(codexCliQueues([0, 148, 9])).toBe(false);
    expect(codexCliQueues([1, 0, 0])).toBe(true);
    expect(codexCliQueues(null)).toBe(false);
  });

  test("a call's thread is read only from Codex (its client name or its turn metadata)", () => {
    expect(codexThreadOfCall(codexMeta(THREAD))).toBe(THREAD);
    expect(codexThreadOfCall({ threadId: THREAD }, "codex-mcp-client")).toBe(THREAD);
    expect(codexThreadOfCall({ threadId: THREAD })).toBeNull();
    expect(codexThreadOfCall({ threadId: "abc" }, "codex-mcp-client")).toBeNull();
    expect(codexTurnStartedAt(codexMeta(THREAD, 1234))).toBe(1234);
    expect(codexTurnStartedAt({ threadId: THREAD })).toBeNull();
  });

  test("a reply too long for one argument is cut on a character, with where the rest is", () => {
    const body = `${"é".repeat(INBOX_CODEX_MESSAGE_MAX_BYTES)}\u0000`;
    const text = codexQueueMessage({ type: "reply", id: "msg_X", thread_id: "msg_T", reply_to: "msg_A", subject: "S", body, url: "u" });
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(INBOX_CODEX_MESSAGE_MAX_BYTES);
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("�");
    expect(text).toContain("read_thread with message_id msg_X");
    const short = { type: "reply" as const, id: "msg_X", thread_id: "msg_T", reply_to: "msg_A", subject: "S", body: "-- go", url: "u" };
    expect(codexQueueMessage(short)).toBe(inboxWakeText(short));
  });
});

describe("a reply to a Codex thread", () => {
  test("goes in once through codex queue, never twice across sweeps and restarts, and is delivered once the thread's next turn calls a tool", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Ship the worker today?");
    // It wakes: the agent is told to end its turn, and the message says so.
    expect(sent.text).toContain(INBOX_REPLY_ARRIVES_TEXT);
    const asked = (await thread(w.server, sent.thread_id)).messages[0]!;
    expect(asked.author).toMatchObject({ kind: "agent", host: "codex", session: THREAD });
    expect(asked.wakes).toBe(true);

    const before = Date.now();
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes, ship it." });
    expect(response.status).toBe(200);
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    await w.server.codexWake.sweep();

    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "thread")).toBe(THREAD);
    const message = argOf(calls[0]!.args, "message")!;
    const lines = message.split("\n");
    expect(lines[0]).toBe(`Plannotator Inbox: Ship the worker today? (${replyId})`);
    expect(lines[1]).toBe(INBOX_WAKE_INSTRUCTION);
    expect(message).toContain("Yes, ship it.");
    // Every value goes as --name=value, so text that starts with "-" is never read as a flag.
    expect(calls[0]!.args).toEqual(["queue", `--thread=${THREAD}`, `--message=${message}`]);

    // The window: queued, as the next turn (no Send now: Codex never takes a message mid-turn).
    const sessions = (await (await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=${THREAD}`)).json()) as {
      asker: { live: boolean; connection: { busy: boolean | null; send_now: boolean } | null };
    };
    expect(sessions.asker.live).toBe(true);
    expect(sessions.asker.connection).toMatchObject({ busy: null, send_now: false });
    expect((await thread(w.server, sent.thread_id)).messages.at(-1)!.delivery ?? null).toBeNull();

    // A restart: the claim is on disk, so it is not queued again.
    w.server.stop();
    const again = await w.start();
    await again.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);

    // A tool call from a turn that started BEFORE it was queued (the turn already running) is not its delivery.
    const client = await connect(again);
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id }, _meta: codexMeta(THREAD, before - 10_000) });
    // read_thread reads it: the reply counts as read (pendingReplies settles), and the claim is done with.
    await again.codexWake.sweep();
    expect(existsSync(join(w.dataDir, "inbox", "codex-queue"))).toBe(true);
    expect(readdirSync(join(w.dataDir, "inbox", "codex-queue")).filter((name) => name !== "dead")).toEqual([]);
    expect(queues(w.fake)).toHaveLength(1);
  });

  test("the next turn's first Inbox tool call records the delivery", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Which retry policy?");
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Backoff." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    // The woken turn answers with send_message: it started after the queue.
    await w.client.callTool({
      name: "send_message",
      arguments: { body: "Going with backoff.", reply_to: sent.message_id, agent_session: THREAD, agent_host: "codex" },
      _meta: codexMeta(THREAD, Date.now() + 5),
    });
    for (let waited = 0; waited < 2000; waited += 25) {
      if ((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)?.delivery) break;
      await Bun.sleep(25);
    }
    const delivered = (await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!;
    expect(delivered.delivery).toMatchObject({ state: "delivered", host: "codex", session: THREAD });
  });

  test("a turn that starts while codex queue is still running (an idle thread) and calls a tool records the delivery", async () => {
    const w = await world({ env: { FAKE_CODEX_QUEUE_DELAY_MS: "1500" } });
    const sent = await codexSends(w.client, w.project, "Which retry policy?");
    const response = await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Backoff." });
    const replyId = ((await response.json()) as { reply: { id: string } }).reply.id;
    const sweeping = w.server.codexWake.sweep();
    // Wait for the call to start, then the woken turn answers before it returns.
    for (let waited = 0; waited < 3000 && queues(w.fake).length === 0; waited += 25) await Bun.sleep(25);
    expect(queues(w.fake)).toHaveLength(1);
    await w.client.callTool({
      name: "send_message",
      arguments: { body: "Going with backoff.", reply_to: sent.message_id, agent_session: THREAD, agent_host: "codex" },
      _meta: codexMeta(THREAD, Date.now()),
    });
    for (let waited = 0; waited < 2000; waited += 25) {
      if ((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)?.delivery) break;
      await Bun.sleep(25);
    }
    expect((await thread(w.server, sent.thread_id)).messages.find((m) => m.id === replyId)!.delivery).toMatchObject({ host: "codex", session: THREAD });
    await sweeping;
    await w.server.codexWake.sweep();
    expect(readdirSync(join(w.dataDir, "inbox", "codex-queue"))).toEqual([]);
    expect(queues(w.fake)).toHaveLength(1);
  });

  test("a thread blocked in wait_for_reply gets the reply from that call, and it is not queued as a turn as well", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Ship it?");
    const waiting = w.client.callTool({ name: "wait_for_reply", arguments: { agent_session: THREAD, thread_id: sent.thread_id, timeout_seconds: 20 }, _meta: codexMeta(THREAD) });
    await Bun.sleep(200);
    await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    const answer = (await waiting).structuredContent as { status: string };
    expect(answer.status).toBe("replied");
    await w.server.codexWake.sweep();
    expect(queues(w.fake)).toEqual([]);
  });

  test("without a Codex CLI that queues, nothing wakes: the message is MCP-only and nothing is run", async () => {
    for (const w of [await world({ codex: false }), await world({ env: { FAKE_CODEX_VERSION: "codex-cli 0.148.0" } })]) {
      const sent = await codexSends(w.client, w.project, "Ship it?");
      expect(sent.text).toContain("Call wait_for_reply");
      expect((await thread(w.server, sent.thread_id)).messages[0]!.wakes).toBeUndefined();
      await reply(w.server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
      await w.server.codexWake.sweep();
      expect(queues(w.fake)).toEqual([]);
      expect(w.server.codexWake.status(THREAD)).toBeNull();
    }
  });

  test("a thread Codex does not know is ended: the reply is saved for the next agent, and it is woken again once the thread is back", async () => {
    const w = await world();
    const unknown = join(w.fake.root, "unknown-threads");
    writeFileSync(unknown, THREAD);
    // The env is the server's, fixed at start: point the fake at the file.
    w.server.stop();
    const fake = w.fake;
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_CODEX_UNKNOWN_FILE: unknown } });
    const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [], sweepMs: 60_000 } });
    servers.push(server);
    const client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await server.codexWake.sweep();
    await server.codexWake.sweep();
    expect(queues(fake)).toHaveLength(1);
    expect(server.codexWake.status(THREAD)).toBe("dead");
    const sessions = (await (await fetch(`${base(server)}/api/inbox/threads/${sent.thread_id}/sessions?asker=${THREAD}`)).json()) as { asker: { live: boolean } };
    expect(sessions.asker.live).toBe(false);
    // The row says so: saved, because the session that asked has ended.
    const rows = (await (await fetch(`${base(server)}/api/inbox/threads`)).json()) as { sections: { threads: { thread_id: string; delivery: { state: string; reason: string } | null }[] }[] };
    const row = rows.sections.flatMap((section) => section.threads).find((t) => t.thread_id === sent.thread_id)!;
    expect(row.delivery).toMatchObject({ state: "saved", reason: "ended" });

    // The thread comes back (resumed under this Codex): its next tool call clears it, and the reply goes.
    writeFileSync(unknown, "");
    await client.callTool({ name: "read_thread", arguments: { agent_session: THREAD, thread_id: sent.thread_id, format: "full" }, _meta: codexMeta(THREAD) });
    expect(server.codexWake.status(THREAD)).toBe("alive");
  });

  test("another failure is tried again later, and goes once it works", async () => {
    const w = await world();
    const failFile = join(w.fake.root, "fail");
    writeFileSync(failFile, "1");
    w.server.stop();
    const environment = createAgentEnvironmentFor({ platform: "linux", homeDir: w.fake.home, env: { ...w.fake.env, FAKE_CODEX_QUEUE_FAIL_FILE: failFile } });
    let clock = Date.now();
    const server = await startInboxServer({ dataDir: w.dataDir, agentEnvironment: environment, codexWake: { extraClis: [], sweepMs: 60_000, now: () => clock } });
    servers.push(server);
    const client = await connect(server);
    const sent = await codexSends(client, w.project, "Ship it?");
    await reply(server, sent.message_id, { idempotency_key: "k1", words: "Yes." });
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    expect(server.codexWake.status(THREAD)).toBe("alive");
    // Within the back-off nothing runs.
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(1);
    // After it, it is tried again (still failing), then the wait doubles.
    clock += 31_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(2);
    clock += 31_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(2);
    // Codex works again: it goes, once.
    writeFileSync(failFile, "");
    clock += 61_000;
    await server.codexWake.sweep();
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(3);
    clock += 10 * 60_000;
    await server.codexWake.sweep();
    expect(queues(w.fake)).toHaveLength(3);
  });
});

describe("tags and New message", () => {
  test("a Codex thread tagged in a Claude Code thread gets the tagged wake once; the owner is untouched", async () => {
    const w = await world();
    // The Codex thread is seen (its tool call): live, taggable, woken.
    await codexSends(w.client, w.project, "Working on the ledger.");
    const owner = (await w.client.callTool({
      name: "send_message",
      arguments: { body: "Which retry policy?", project_path: w.project, agent_session: "ses-claude", agent_host: "claude-code", agent_name: "Claude Code" },
    })).structuredContent as { message_id: string; thread_id: string };
    // The owner's connection polls (it understands tags).
    await fetch(`${base(w.server)}${INBOX_BRIDGE_POLL_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${w.server.token}` },
      body: JSON.stringify({ session: "ses-claude", host: "claude-code", project_path: w.project, waitMs: 0, [INBOX_TAGS_POLL_FIELD]: true }),
    });
    const response = await reply(w.server, owner.message_id, { idempotency_key: "k1", words: "@Codex check this too.", tags: [{ host: "codex", session: THREAD }] });
    expect(response.status).toBe(200);
    await w.server.codexWake.sweep();
    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "thread")).toBe(THREAD);
    const lines = argOf(calls[0]!.args, "message")!.split("\n");
    expect(lines[1]).toBe(INBOX_TAGGED_INSTRUCTION);
  });

  test("New message to a live Codex thread is queued with the New message wake", async () => {
    const w = await world();
    const sent = await codexSends(w.client, w.project, "Working on the ledger.");
    const sessions = (await (await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/sessions`)).json()) as { sessions: { session: string; host: string }[] };
    expect(sessions.sessions).toContainEqual(expect.objectContaining({ session: THREAD, host: "codex" }));
    const response = await fetch(`${base(w.server)}/api/inbox/threads/${sent.thread_id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: w.server.serverSession, session: THREAD, body: "Also bump the version.", idempotency_key: "m1" }),
    });
    expect(response.status).toBe(200);
    await w.server.codexWake.sweep();
    const calls = queues(w.fake);
    expect(calls).toHaveLength(1);
    expect(argOf(calls[0]!.args, "message")!.split("\n")[1]).toBe(INBOX_MESSAGE_INSTRUCTION);
  });

  test("two threads each get their own reply, and only theirs", async () => {
    const w = await world();
    const a = await codexSends(w.client, w.project, "A?", THREAD);
    const b = await codexSends(w.client, w.project, "B?", OTHER_THREAD);
    await reply(w.server, a.message_id, { idempotency_key: "ka", words: "for A" });
    await reply(w.server, b.message_id, { idempotency_key: "kb", words: "for B" });
    await w.server.codexWake.sweep();
    const calls = queues(w.fake).map((call) => ({ thread: argOf(call.args, "thread"), message: argOf(call.args, "message")! }));
    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.thread === THREAD)!.message).toContain("for A");
    expect(calls.find((c) => c.thread === OTHER_THREAD)!.message).toContain("for B");
    expect(calls.find((c) => c.thread === THREAD)!.message).not.toContain("for B");
  });
});
