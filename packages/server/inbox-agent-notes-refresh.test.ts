/**
 * The installed notes brought up to date by the Inbox's start
 * (refreshInboxNotes), with no action by the person. The owner's terms: it
 * must find the beginning and end of our note reliably and deterministically,
 * and touch nothing else. The failures these catch: a note the person edited,
 * removed or locked rewritten; a file with broken markers rewritten; another
 * writer's change lost; line endings, BOM, mode or a symlink changed; a file
 * two agents share written twice or left reading "edited" for one of them.
 * Every case runs in a scratch home (tests/helpers/fake-agents.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import { INBOX_NOTE_BLOCK, noteStatus, readInboxAgentNotes, refreshInboxNotes, removeInboxNote } from "./inbox-agent-notes";
import { createAgentEnvironmentFor, type AgentEnvironment } from "./inbox-agents";
import { startInboxServer } from "./inbox";

let fake: FakeAgents;
let dataDir: string;
let e: AgentEnvironment;

beforeEach(() => {
  fake = createFakeAgents("plannotator-notes-refresh-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: fake.env });
});
afterEach(() => fake.remove());

const file = (...parts: string[]) => join(fake.home, ...parts);
const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const bytes = (path: string) => readFileSync(path);
const read = (path: string) => readFileSync(path, "utf8");
const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");

// The v1 block exactly as 0.28.x wrote it, frozen on purpose: these are the bytes on users' disks.
const V1_START = "<!-- plannotator-inbox:start v1 · added by Plannotator. Remove it in the Inbox's Settings or with `plannotator uninstall` -->";
const V1_BLOCK = [
  V1_START,
  "## Plannotator Inbox",
  "",
  "The person keeps a Plannotator Inbox on this computer: a window where they read what agents send and answer when they can.",
  "If you have a `plannotator_inbox` tool or a `plannotator-inbox` MCP server, use its `send_message` when the person isn't here to answer in this chat: to ask a decision only they can make (as a `:::question` block), or to hand over finished long work (put the files to read in `attachments`). Then keep working.",
  "Their reply comes back to this session by itself where your agent supports that; otherwise call `wait_for_reply`. When they are here, ask in this chat instead.",
  "<!-- plannotator-inbox:end -->",
].join("\n");

/** agent-notes.json as 0.28.x left it: a v1 record per agent, naming the file's resolved path. */
function v1Records(entries: Record<string, string>): void {
  mkdirSync(join(dataDir, "inbox"), { recursive: true });
  const notes = Object.fromEntries(
    Object.entries(entries).map(([agent, path]) => [agent, { path: realpathSync(path), created: false, version: 1, block_sha256: sha(V1_BLOCK), at: "2026-10-01T00:00:00.000Z" }]),
  );
  writeFileSync(join(dataDir, "inbox", "agent-notes.json"), JSON.stringify({ v: 1, notes }));
}

const results = (options?: Parameters<typeof refreshInboxNotes>[2]) => refreshInboxNotes(dataDir, e, options).map((r) => `${r.agent}:${r.result}`);

describe("refreshInboxNotes: each case of the file, decided by the markers and the hash alone", () => {
  test("one untouched earlier note: replaced by this version in place, every other byte, the mode and the record kept current; a second run writes nothing", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `# Mine\n\nKeep tests green.\n\n${V1_BLOCK}\nAfter the note.\n`);
    chmodSync(path, 0o640);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:refreshed"]);
    expect(read(path)).toBe(`# Mine\n\nKeep tests green.\n\n${INBOX_NOTE_BLOCK}\nAfter the note.\n`);
    expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readInboxAgentNotes(dataDir).notes.codex).toMatchObject({ version: 2, block_sha256: sha(INBOX_NOTE_BLOCK) });
    expect(noteStatus("codex", dataDir, e).state).toBe("added");
    const ino = statSync(path).ino;
    expect(results()).toEqual(["codex:current"]);
    expect(statSync(path).ino).toBe(ino);
  });

  test("no block (the person removed the note): never put back", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, "# Mine\n");
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:none"]);
    expect(read(path)).toBe("# Mine\n");
    expect(readInboxAgentNotes(dataDir).notes.codex?.version).toBe(1);
  });

  test("one note the person edited: left as it is", () => {
    const path = file(".codex", "AGENTS.md");
    const edited = `${V1_BLOCK.replace("Then keep working.", "Then keep working. Never at night.")}\n`;
    write(path, edited);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:edited"]);
    expect(read(path)).toBe(edited);
  });

  test("an earlier note with no record (agent-notes.json lost): not this function's to touch", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `${V1_BLOCK}\n`);
    expect(results()).toEqual([]);
    expect(read(path)).toBe(`${V1_BLOCK}\n`);
  });

  test("two start lines: damaged, nothing written", () => {
    const path = file(".codex", "AGENTS.md");
    const text = `${V1_START}\nA line of mine.\n${V1_BLOCK}\n`;
    write(path, text);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:damaged"]);
    expect(read(path)).toBe(text);
  });

  test("an end line before the start line: damaged, nothing written", () => {
    const path = file(".codex", "AGENTS.md");
    const [start, ...rest] = V1_BLOCK.split("\n");
    const end = rest.pop()!;
    const text = `${end}\n${start}\n${rest.join("\n")}\n`;
    write(path, text);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:damaged"]);
    expect(read(path)).toBe(text);
  });

  test("CRLF: the new block in CRLF too, every other byte (and the BOM) as it was", () => {
    const path = file(".codex", "AGENTS.md");
    const crlf = (text: string) => text.replace(/\n/g, "\r\n");
    write(path, `﻿${crlf(`# Mine\n\n${V1_BLOCK}\n`)}`);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:refreshed"]);
    expect(bytes(path).equals(Buffer.from(`﻿${crlf(`# Mine\n\n${INBOX_NOTE_BLOCK}\n`)}`, "utf8"))).toBe(true);
    expect(read(path).replace(/\r\n/g, "")).not.toContain("\n");
  });

  test("a symlinked AGENTS.md shared by two agents (Pi's a link to Codex's): written once at the target, the link kept, both notes current", () => {
    const real = file(".codex", "AGENTS.md");
    write(real, `Shared.\n\n${V1_BLOCK}\n`);
    mkdirSync(file(".pi", "agent"), { recursive: true });
    symlinkSync(real, file(".pi", "agent", "AGENTS.md"));
    v1Records({ codex: real, pi: file(".pi", "agent", "AGENTS.md") });
    expect(results()).toEqual(["codex:refreshed", "pi:shared"]);
    expect(lstatSync(file(".pi", "agent", "AGENTS.md")).isSymbolicLink()).toBe(true);
    expect(read(real)).toBe(`Shared.\n\n${INBOX_NOTE_BLOCK}\n`);
    expect(noteStatus("codex", dataDir, e).state).toBe("added");
    expect(noteStatus("pi", dataDir, e).state).toBe("added");
    // Off for both still gives the file back as the person had it.
    expect(removeInboxNote("codex", dataDir, e)).toMatchObject({ ok: true, action: "kept-shared" });
    expect(removeInboxNote("pi", dataDir, e)).toMatchObject({ ok: true, action: "removed" });
    expect(read(real)).toBe("Shared.\n");
  });

  test("a read-only file: left alone, its mode too", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `${V1_BLOCK}\n`);
    chmodSync(path, 0o444);
    v1Records({ codex: path });
    expect(results()).toEqual(["codex:read-only"]);
    expect(read(path)).toBe(`${V1_BLOCK}\n`);
    expect(statSync(path).mode & 0o777).toBe(0o444);
  });

  test("a file changed between the read and the write: not clobbered; the next start refreshes it with that change kept", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `${V1_BLOCK}\n`);
    v1Records({ codex: path });
    expect(results({ beforeWrite: (target) => appendFileSync(target, "Written meanwhile.\n") })).toEqual(["codex:changed"]);
    expect(read(path)).toBe(`${V1_BLOCK}\nWritten meanwhile.\n`);
    expect(readInboxAgentNotes(dataDir).notes.codex?.version).toBe(1);
    expect(results()).toEqual(["codex:refreshed"]);
    expect(read(path)).toBe(`${INBOX_NOTE_BLOCK}\nWritten meanwhile.\n`);
  });

  test("a missing file: nothing created", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `${V1_BLOCK}\n`);
    v1Records({ codex: path });
    rmSync(path);
    expect(results()).toEqual(["codex:missing"]);
  });

  test("PLANNOTATOR_INBOX_NOTES=0: nothing refreshed", () => {
    const path = file(".codex", "AGENTS.md");
    write(path, `${V1_BLOCK}\n`);
    v1Records({ codex: path });
    e = createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, PLANNOTATOR_INBOX_NOTES: "0" } });
    expect(results()).toEqual([]);
    expect(read(path)).toBe(`${V1_BLOCK}\n`);
  });
});

test("the Inbox's start refreshes an installed untouched note by itself", async () => {
  const path = file(".claude", "rules", "plannotator-inbox.md");
  write(path, `${V1_BLOCK}\n`);
  v1Records({ "claude-code": path });
  const inbox = await startInboxServer({ dataDir, agentEnvironment: e, binaryPath: null, phones: false });
  try {
    expect(read(path)).toBe(`${INBOX_NOTE_BLOCK}\n`);
  } finally {
    inbox.stop();
  }
});
