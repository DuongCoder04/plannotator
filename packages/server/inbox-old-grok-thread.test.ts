/**
 * A thread the removed Grok Build runner wrote (0.28.34 to 0.28.36): the
 * person's first message addressed to `{ host: "grok", session: run_… }`,
 * Grok Build's answers authored `grok` / "Grok Build". With the runner gone
 * the thread still reads as an ordinary agent thread, and a reply in it is
 * stored like a reply to any session that is not live: it waits, nothing
 * fails. The runner's `inbox/acp/sessions.json` and config.json's `inboxRun`
 * are left alone and never read. Every test uses its own temp data dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxListModel, InboxThread } from "@plannotator/core/inbox-types";
import { startInboxServer, type InboxServer } from "./inbox";

const roots: string[] = [];
const servers: InboxServer[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RUN = "run_01JZ8N3W6Q2R5T7V9X1Y3Z5A7B";

describe("a thread the removed Grok Build runner wrote", () => {
  test("reads as an ordinary Grok Build thread, takes a reply that waits, and leaves the runner's files alone", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-inbox-old-grok-")));
    roots.push(root);
    const project = join(root, "billing");
    mkdirSync(project, { recursive: true });
    const data = join(root, "data");
    // What 0.28.34–0.28.36 left in the data dir: the runner's session table and the Settings toggle.
    mkdirSync(join(data, "inbox", "acp"), { recursive: true });
    const table = JSON.stringify([{ key: RUN, agent: "grok", acp_session_id: "grok-own-id", cwd: project, project_id: "prj_x", thread_id: "msg_x", created_at: "2026-10-27T10:00:00.000Z", turns: [] }]);
    writeFileSync(join(data, "inbox", "acp", "sessions.json"), table);
    writeFileSync(join(data, "config.json"), JSON.stringify({ inboxRun: { grok: true } }));

    const server = await startInboxServer({ dataDir: data });
    servers.push(server);
    const base = `http://127.0.0.1:${server.port}`;

    // The thread as the runner wrote it: compose's Send addressed to the run, then Grok Build's answer (posted with wakes, as its turns were).
    const place = server.store.ensureProject({ name: "billing", root: project });
    const started = server.store.startPersonThread({ project_id: place.id, body: "Look at the refund retries.", to: { host: "grok", session: RUN }, idempotency_key: "old-start" });
    const threadId = started.message.thread_id;
    const answer = server.store.sendMessage({
      project_id: place.id,
      author: { kind: "agent", host: "grok", session: RUN, name: "Grok Build" },
      body: "The retries back off twice, then give up. Want a third?",
      reply_to: started.message.id,
      idempotency_key: `acp-final-${started.message.id}`,
      wakes: true,
    });

    // The list and the thread read without a `run` and without error; the answer is Grok Build's.
    const list = (await (await fetch(`${base}/api/inbox/threads`)).json()) as InboxListModel;
    const row = list.sections.flatMap((section) => section.threads).find((r) => r.thread_id === threadId);
    expect(row).toBeDefined();
    expect(row && "run" in row).toBe(false);
    const read = await fetch(`${base}/api/inbox/threads/${threadId}`);
    expect(read.status).toBe(200);
    const thread = ((await read.json()) as { thread: InboxThread }).thread;
    expect(thread.messages.map((m) => m.author)).toEqual([
      { kind: "person" },
      { kind: "agent", host: "grok", session: RUN, name: "Grok Build" },
    ]);

    // A reply: stored and waiting for that session, as for any session that is not live.
    const replied = await fetch(`${base}/api/inbox/messages/${answer.message.id}/reply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ serverSession: server.serverSession, idempotency_key: "old-reply", words: "Yes, a third with a longer wait." }),
    });
    expect(replied.status).toBe(200);
    const reply = ((await replied.json()) as { reply: { id: string; delivery?: unknown } }).reply;
    expect(server.store.pendingReplies(RUN, { tags: false }).map((r) => r.id)).toContain(reply.id);
    expect((await fetch(`${base}/api/inbox/threads/${threadId}`)).status).toBe(200);

    // The runner's routes are gone; its files are untouched.
    expect((await fetch(`${base}/api/inbox/acp`)).status).toBe(404);
    expect(readFileSync(join(data, "inbox", "acp", "sessions.json"), "utf8")).toBe(table);
    expect(JSON.parse(readFileSync(join(data, "config.json"), "utf8")).inboxRun).toEqual({ grok: true });
  });
});
