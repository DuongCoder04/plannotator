/**
 * The ACP runner (inbox-acp-runner.ts) against a real Inbox and the FAKE ACP
 * agent (tests/helpers/fake-acp-agent.ts), never a real agent. The fake is
 * started as Grok Build would be, and calls the real `plannotator inbox mcp`
 * (the CLI from source) the runner hands it, so its answers land through the
 * Inbox's own MCP tools. Every test has its own temp data dir.
 *
 * Spec "Inbox replies as real turns for Cursor and Grok", step 1, tests 1 to 9.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { InboxRunStatus } from "@plannotator/core/inbox-acp";
import type { InboxListSection, InboxMessage, InboxThread } from "@plannotator/core/inbox-types";

type InboxListModel = { sections: InboxListSection[] };
import { INBOX_NEW_THREAD_INSTRUCTION, INBOX_WAKE_INSTRUCTION } from "@plannotator/shared/inbox/connection";
import { NO_BROWSER } from "../../tests/helpers/no-browser";
import { removeStubbedHtml, stubHookDistHtml } from "../../tests/helpers/hook-dist-stub";
import { startInboxServer, type InboxServer } from "./inbox";
import { createAgentEnvironmentFor } from "./inbox-agents";

const FAKE_AGENT = resolve(import.meta.dir, "..", "..", "tests", "helpers", "fake-acp-agent.ts");
const CLI = resolve(import.meta.dir, "..", "..", "apps", "hook", "server", "index.ts");
const SECRET = "sk-test-SECRET-7f3a9c";

let stubs: string[] = [];
beforeAll(() => {
  stubs = stubHookDistHtml();
});
afterAll(() => removeStubbedHtml(stubs));

const roots: string[] = [];
const servers: InboxServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) server.stop();
  // The agents' process groups get SIGTERM, then SIGKILL after 3 s.
  await Bun.sleep(100);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Step = Record<string, unknown>;

interface World {
  server: InboxServer;
  dataDir: string;
  project: string;
  projectId: string;
  log: () => Record<string, unknown>[];
  base: string;
  restart: () => Promise<InboxServer>;
}

async function world(script: { turns?: Step[][]; steps?: Step[]; loadSessionError?: string; [k: string]: unknown }): Promise<World> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-acp-runner-")));
  roots.push(root);
  const project = join(root, "billing");
  mkdirSync(project, { recursive: true });
  const dataDir = join(root, "data");
  const home = join(root, "home");
  mkdirSync(home, { recursive: true });
  const scriptPath = join(root, "script.json");
  const logPath = join(root, "fake.log");
  writeFileSync(scriptPath, JSON.stringify({ loadSession: true, closeSession: true, steps: [], ...script }));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: home,
    NO_BROWSER,
    PLANNOTATOR_INBOX_CONNECT: "0",
    PLANNOTATOR_TEST_SANDBOX: process.env.PLANNOTATOR_TEST_SANDBOX,
  };
  const make = () =>
    startInboxServer({
      dataDir,
      selfCommand: [process.execPath, "run", CLI],
      agentEnvironment: createAgentEnvironmentFor({ platform: process.platform, homeDir: home, env }),
      acpRunner: { launches: { grok: { command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_SCRIPT: scriptPath, FAKE_ACP_LOG: logPath } } }, stopGraceMs: 1500 },
    });
  const server = await make();
  servers.push(server);
  const projectId = server.store.ensureProject({ name: "billing", root: project }).id;
  const w: World = {
    server,
    dataDir,
    project,
    projectId,
    base: `http://127.0.0.1:${server.port}`,
    log: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line))
        : [],
    restart: async () => {
      w.server.stop();
      servers.splice(servers.indexOf(w.server), 1);
      await Bun.sleep(200);
      const next = await make();
      servers.push(next);
      w.server = next;
      w.base = `http://127.0.0.1:${next.port}`;
      return next;
    },
  };
  return w;
}

async function until<T>(read: () => T | Promise<T>, what: string, ms = 30_000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value as NonNullable<T>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const post = (w: World, path: string, body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  fetch(`${w.base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ serverSession: w.server.serverSession, ...body }) });

async function startRun(w: World, body = "Please check why the invoice totals are off.") {
  const res = await post(w, "/api/inbox/acp/start", { agent: "grok", project_id: w.projectId, body, idempotency_key: `k-${Math.random()}` });
  expect(res.status).toBe(200);
  return (await res.json()) as { thread_id: string; run: { key: string } };
}

const status = async (w: World, key: string) => ((await (await fetch(`${w.base}/api/inbox/acp/${key}`)).json()) as { run: InboxRunStatus }).run;
const thread = (w: World, id: string): InboxThread => w.server.store.thread(id)!;
const agentMessages = (w: World, id: string, key: string) => thread(w, id).messages.filter((m) => m.author.kind === "agent" && m.author.session === key);
const ended = (w: World, key: string, turns: number) => until(async () => {
  const run = await status(w, key);
  return run.state === "idle" && run.turns.length >= turns && run.turns.at(-1)!.ended_at ? run : null;
}, `turn ${turns} to end`);

function reply(w: World, to: InboxMessage, words: string) {
  return post(w, `/api/inbox/messages/${to.id}/reply`, { idempotency_key: `r-${Math.random()}`, words });
}

/** The fake answers with the Inbox's own send_message (asking permission first, as Grok does), then says a word. */
const answersInInbox = (body: string): Step[] => [
  { mcp: { name: "send_message", server: "plannotator-inbox", ask: true, args: { body, reply_to: "$REPLY_TO" } } },
  { say: "done" },
];

describe("the ACP runner", () => {
  test("1, 5: compose starts a session; the agent answers through the real `plannotator inbox mcp`, its Inbox tool allowed with no card", async () => {
    const w = await world({ turns: [answersInInbox("The totals skip refunds; I will fix the query.")] });
    const started = await startRun(w);
    const key = started.run.key;
    expect(key).toMatch(/^run_/);
    const run = await ended(w, key, 1);
    expect(run.turn!.outcome).toBe("done");
    expect(run.turn!.answered).toBe("inbox");
    expect(run.permission).toBeNull();
    const [answer] = agentMessages(w, started.thread_id, key);
    expect(answer!.body).toBe("The totals skip refunds; I will fix the query.");
    expect(answer!.author).toMatchObject({ host: "grok", session: key, name: "Grok Build" });
    expect(answer!.wakes).toBe(true);
    // The root was delivered as the turn's prompt: the new-thread wake, the person's words.
    expect(w.server.store.message(started.thread_id)!.delivery?.session).toBe(key);
    const log = w.log();
    const prompt = log.find((e) => e.event === "prompt")!;
    expect(prompt.text).toContain(INBOX_NEW_THREAD_INSTRUCTION);
    expect(prompt.text).toContain("Please check why the invoice totals are off.");
    expect(log.find((e) => e.event === "newSession")).toMatchObject({ cwd: w.project, mcpServers: [{ name: "plannotator-inbox" }] });
    // The Inbox tool: allowed once, automatically.
    expect(log.find((e) => e.event === "mcpPermission")).toMatchObject({ title: "plannotator-inbox__send_message", outcome: { outcome: "selected", optionId: "allow-once" } });
    expect(log.some((e) => e.event === "closeSession")).toBe(true);
    // The session table: 0600, the agent's own session id kept.
    const table = join(w.dataDir, "inbox", "acp", "sessions.json");
    expect(statSync(table).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(table, "utf8")).sessions[0]).toMatchObject({ key, agent: "grok", acp_session_id: run.acp_session_id, cwd: w.project });
    expect(run.resume_command).toContain(`grok -r ${run.acp_session_id}`);
  }, 60_000);

  test("2, 3: a reply loads the stored session and is the prompt; a turn with no Inbox message posts its final text", async () => {
    const w = await world({ turns: [answersInInbox("First answer."), [{ tool: { title: "Read src/invoice.ts" } }, { say: "Thinking aloud. " }, { tool: { title: "Edit src/invoice.ts" } }, { say: "Fixed: refunds are subtracted now." }]] });
    const started = await startRun(w);
    const key = started.run.key;
    const first = await ended(w, key, 1);
    const [answer] = agentMessages(w, started.thread_id, key);
    expect((await reply(w, answer!, "Go ahead and fix it.")).status).toBe(200);
    const second = await ended(w, key, 2);
    expect(second.turn!.outcome).toBe("done");
    expect(second.turn!.answered).toBe("final_text");
    const log = w.log();
    expect(log.find((e) => e.event === "loadSession")).toMatchObject({ sessionId: first.acp_session_id, cwd: w.project });
    const prompts = log.filter((e) => e.event === "prompt");
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.text).toContain(INBOX_WAKE_INSTRUCTION);
    expect(prompts[1]!.text).toContain("Go ahead and fix it.");
    // The final text: only what came after the last tool, as Grok Build's own message.
    const posted = agentMessages(w, started.thread_id, key).at(-1)!;
    expect(posted.body).toBe("Fixed: refunds are subtracted now.");
    expect(posted.reply_to).toBe(second.turn!.replies[0]!);
    expect(second.activity.tools.map((t) => t.title)).toEqual(["Read src/invoice.ts", "Edit src/invoice.ts"]);
  }, 60_000);

  test("4: a permission is a card, the thread is in Stopped on you, the answer goes back as given; Stop answers cancelled", async () => {
    const w = await world({
      turns: [
        [{ permission: { title: "Run `rm -rf build`" } }, { say: "Cleaned." }],
        [{ permission: { title: "Run `make deploy`" } }, { say: "never" }],
      ],
    });
    const started = await startRun(w);
    const key = started.run.key;
    const waiting = await until(async () => (await status(w, key)).permission, "the permission");
    expect(waiting.title).toBe("Run `rm -rf build`");
    expect(waiting.options.map((o) => o.id)).toEqual(["allow-once", "allow-always", "reject-once"]);
    expect((await status(w, key)).state).toBe("permission");
    const list = (await (await fetch(`${w.base}/api/inbox/threads?archived=exclude`)).json()) as InboxListModel;
    const row = list.sections.flatMap((s) => s.threads).find((r) => r.thread_id === started.thread_id)!;
    expect(row.section).toBe("stopped");
    expect(row.run).toMatchObject({ key, state: "permission", permission_title: "Run `rm -rf build`" });
    // A stale request id is refused; the real one goes back as given.
    expect((await post(w, `/api/inbox/acp/${key}/permission`, { permission_id: "prm_nope", option_id: "allow-once" })).status).toBe(409);
    expect((await post(w, `/api/inbox/acp/${key}/permission`, { permission_id: waiting.id, option_id: "allow-always" })).status).toBe(200);
    const first = await ended(w, key, 1);
    expect(first.turn!.answered).toBe("final_text");
    expect(w.log().find((e) => e.event === "permission")).toMatchObject({ outcome: { outcome: "selected", optionId: "allow-always" } });
    // The second turn waits on a permission until Stop.
    const [answer] = agentMessages(w, started.thread_id, key);
    await reply(w, answer!, "Deploy it.");
    await until(async () => (await status(w, key)).permission?.title === "Run `make deploy`", "the second permission");
    expect((await post(w, `/api/inbox/acp/${key}/stop`, {})).status).toBe(200);
    const stopped = await ended(w, key, 2);
    expect(stopped.turn!.outcome).toBe("stopped");
    // A stopped turn's last words are not posted as its answer.
    expect(stopped.turn!.answered).toBe("none");
    expect(agentMessages(w, started.thread_id, key)).toHaveLength(1);
    const outcomes = w.log().filter((e) => e.event === "permission").map((e) => e.outcome);
    expect(outcomes.at(-1)).toEqual({ outcome: "cancelled" });
    expect(w.log().some((e) => e.event === "cancel")).toBe(true);
  }, 60_000);

  test("6: the Inbox stops: no agent process is left; the next start reads the turn as interrupted and sends nothing again", async () => {
    const w = await world({ turns: [[{ spawnStubborn: true }, { sleep: 60_000 }]] });
    const started = await startRun(w);
    const key = started.run.key;
    const stubborn = await until(() => w.log().find((e) => e.event === "stubborn")?.pid as number | undefined, "the stubborn child");
    const agentPid = await until(() => w.server.runner.pids()[0], "the agent's pid");
    await w.restart();
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0); // inbox-guard: own child (the fake agent and its grandchild, never an Inbox)
        return true;
      } catch {
        return false;
      }
    };
    await until(() => !alive(agentPid) && !alive(stubborn), "the agent and its grandchild to be gone", 10_000);
    const run = await status(w, key);
    expect(run.turn!.outcome).toBe("interrupted");
    expect(w.server.store.pendingReplies(key)).toHaveLength(0);
    await Bun.sleep(300);
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(1);
  }, 60_000);

  test("7: a failing session/load sends nothing and says why", async () => {
    const w = await world({ loadSessionError: "the session file is unreadable", turns: [answersInInbox("Hello.")] });
    const started = await startRun(w);
    const key = started.run.key;
    await ended(w, key, 1);
    const [answer] = agentMessages(w, started.thread_id, key);
    const sent = (await (await reply(w, answer!, "And the tax lines?")).json()) as { reply: InboxMessage };
    const failed = await ended(w, key, 2);
    expect(failed.turn!.outcome).toBe("failed");
    expect(failed.turn!.error).toContain("could not reopen this session, so nothing was sent");
    expect(w.server.store.message(sent.reply.id)!.delivery ?? null).toBeNull();
    expect(w.log().filter((e) => e.event === "prompt")).toHaveLength(1);
    // Never a fallback to a new session (it would lose the history).
    expect(w.log().filter((e) => e.event === "newSession")).toHaveLength(1);
  }, 60_000);

  test("8: the guards refuse another site and a stale serverSession", async () => {
    const w = await world({ turns: [[{ say: "hi" }]] });
    const body = { agent: "grok", project_id: w.projectId, body: "x", idempotency_key: "g1" };
    expect((await post(w, "/api/inbox/acp/start", body, { Origin: "http://evil.example" })).status).toBe(403);
    expect((await post(w, "/api/inbox/acp/start", { ...body, serverSession: "not-this-one" })).status).toBe(409);
    expect((await fetch(`${w.base}/api/inbox/acp`, { headers: { "Sec-Fetch-Site": "cross-site" } })).status).toBe(403);
    expect(w.server.store.listRows()).toHaveLength(0);
  }, 30_000);

  test("9: an `_x.ai/*` notification carrying a secret never reaches disk, the window or the list", async () => {
    const w = await world({ turns: [[{ extNotify: { method: "_x.ai/mcp/servers_updated", params: { servers: [{ name: "github", env: { GITHUB_TOKEN: SECRET } }] } } }, { say: "ok" }]] });
    const events: string[] = [];
    const controller = new AbortController();
    void fetch(`${w.base}/api/inbox/events?cursor=0&window=w-acp-test-1&permission=default&origin=http%3A%2F%2Flocalhost`, { signal: controller.signal })
      .then(async (res) => {
        const reader = res.body!.getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          events.push(new TextDecoder().decode(value));
        }
      })
      .catch(() => {});
    const started = await startRun(w);
    const run = await ended(w, started.run.key, 1);
    expect(w.log().some((e) => e.event === "extNotify")).toBe(true);
    controller.abort();
    expect(JSON.stringify(run)).not.toContain(SECRET);
    expect(events.join("")).not.toContain(SECRET);
    expect(events.join("")).toContain("event: runs");
    expect(JSON.stringify(await (await fetch(`${w.base}/api/inbox/threads`)).json())).not.toContain(SECRET);
    const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
    for (const file of walk(w.dataDir)) expect(readFileSync(file, "utf8").includes(SECRET)).toBe(false);
  }, 60_000);
});
