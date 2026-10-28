/**
 * Qwen Code's connection to the Inbox (inbox-agents.ts), with a fake `qwen`
 * on a scratch PATH and a scratch home (tests/helpers/fake-agents.ts; the real
 * qwen is never run and the real ~/.qwen never read). Qwen's own CLI edits its
 * settings.json, so what is guarded here is that connecting or removing never
 * leaves that file broken or without the person's other servers.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createFakeAgents, type FakeAgents } from "../../tests/helpers/fake-agents";
import {
  agentSpec,
  connectInboxAgents,
  createAgentEnvironmentFor,
  formatConnectReport,
  planInboxAgentRemoval,
  qwenDir,
  readAgentEntry,
  readInboxAgents,
  setInboxAgentReach,
  type AgentEnvironment,
} from "./inbox-agents";

const SELF = ["/opt/plannotator/bin/plannotator"];
const OURS = [...SELF, "inbox", "mcp"];

let fake: FakeAgents;
let dataDir: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  fake = createFakeAgents("plannotator-qwen-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}): AgentEnvironment {
  return createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, ...extra } });
}
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents(options(extra));
const qwenCalls = (sub?: string) => fake.calls().filter((call) => call.name === "qwen" && (!sub || call.args[1] === sub));
const settingsPath = () => join(fake.home, ".qwen", "settings.json");
const writeSettings = (text: string, path = settingsPath()) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
/** A user's settings.json with their own server and other settings. */
const MINE = `${JSON.stringify({ general: { vimMode: true }, mcpServers: { github: { command: "gh-mcp", args: ["--stdio"] } }, $version: 3 }, null, 2)}\n`;

describe("connecting Qwen Code", () => {
  test("`qwen mcp add -s user plannotator-inbox <this CLI> inbox mcp`, the person's other settings kept, recorded, then left alone", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect();
    expect(report.added).toEqual(["qwen"]);
    expect(qwenCalls("add")).toEqual([{ name: "qwen", args: ["mcp", "add", "-s", "user", "plannotator-inbox", ...OURS] }]);
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.mcpServers).toEqual({ github: { command: "gh-mcp", args: ["--stdio"] }, "plannotator-inbox": { command: OURS[0], args: ["inbox", "mcp"] } });
    expect(settings.general).toEqual({ vimMode: true });
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", reach: "mcp", path: settingsPath() });
    expect(formatConnectReport(report)[0]).toContain("Qwen Code");

    const again = await connect();
    expect(again.added).toEqual([]);
    expect(again.already).toEqual(["qwen"]);
    expect(qwenCalls("add")).toHaveLength(1);
  });

  test("found by its folder alone (no qwen on PATH): left for a person, nothing written", async () => {
    writeSettings(MINE);
    const report = await connect();
    expect(report.manual).toEqual(["qwen"]);
    expect(report.manual_why).toEqual([{ agent: "qwen", why: "qwen is not on PATH" }]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  test("QWEN_HOME is the folder itself: the entry goes in $QWEN_HOME/settings.json, never ~/.qwen", async () => {
    fake.install("qwen");
    const home = join(fake.root, "elsewhere");
    const report = await connect({ QWEN_HOME: home });
    expect(report.added).toEqual(["qwen"]);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers["plannotator-inbox"]).toEqual({ command: OURS[0], args: ["inbox", "mcp"] });
    expect(existsSync(join(fake.home, ".qwen"))).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.path).toBe(join(home, "settings.json"));
  });

  test("QWEN_HOME as Qwen reads it: `~` expanded, a relative one against the working folder, empty is unset", () => {
    expect(qwenDir(environment({ QWEN_HOME: "~/q" }))).toBe(join(fake.home, "q"));
    expect(qwenDir(environment({ QWEN_HOME: "rel/q" }))).toBe(resolve(process.cwd(), "rel/q"));
    expect(qwenDir(environment({ QWEN_HOME: "  " }))).toBe(join(fake.home, ".qwen"));
  });

  test("a Qwen too old for `qwen mcp add` (before 0.0.8), or a program that only shares the name, is never handed an mcp add", async () => {
    fake.install("qwen");
    const old = await connect({ FAKE_QWEN_VERSION: "0.0.7" });
    expect(old.manual).toEqual(["qwen"]);
    expect(formatConnectReport(old)).toContain(
      "Qwen Code needs connecting by hand: Qwen Code before 0.0.8 has no `qwen mcp add`; update Qwen Code, or add plannotator-inbox to its settings.json by hand.",
    );
    const foreign = await connect({ FAKE_QWEN_VERSION: "qwen (image viewer) 3.1" });
    expect(foreign.manual_why).toEqual([{ agent: "qwen", why: "this qwen did not answer like Qwen Code" }]);
    expect(qwenCalls("add")).toEqual([]);
    // A nightly's version line is Qwen's.
    const nightly = await connect({ FAKE_QWEN_VERSION: "0.27.0-nightly.20261027.a1b2c3d" });
    expect(nightly.added).toEqual(["qwen"]);
  });

  test("an entry the person turned off in Settings is removed, and never added back by a later run", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    expect(await setInboxAgentReach("qwen", false, options())).toBeNull();
    expect(qwenCalls("remove")).toEqual([{ name: "qwen", args: ["mcp", "remove", "-s", "user", "plannotator-inbox"] }]);
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).mcpServers).toEqual({ github: { command: "gh-mcp", args: ["--stdio"] } });
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
    const later = await connect();
    expect(later.added).toEqual([]);
    expect(qwenCalls("add")).toHaveLength(1);
  });
});

describe("Qwen's settings.json is never left broken", () => {
  test("a settings.json that is not valid JSON: qwen is never run on it, and it stays byte for byte", async () => {
    fake.install("qwen");
    const broken = '{ "mcpServers": { "github": { "command": "gh-mcp" }, \n';
    writeSettings(broken);
    const report = await connect();
    expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json can't be read (it is not plain JSON), so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
    expect(qwenCalls("add")).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(broken);
    expect(readInboxAgents(dataDir).agents.qwen).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0)("a read-only settings.json: qwen is never run on it, the reason is said, and a later run tries again", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    chmodSync(settingsPath(), 0o444);
    try {
      const report = await connect();
      expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json is read-only, so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
      expect(qwenCalls("add")).toEqual([]);
      expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    } finally {
      chmodSync(settingsPath(), 0o644);
    }
    const later = await connect();
    expect(later.added).toEqual(["qwen"]);
  });

  test("a qwen that leaves the file half written: its bytes are put back, nothing is recorded", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect({ FAKE_QWEN_BREAK: "1" });
    expect(qwenCalls("add")).toHaveLength(1);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toBe("~/.qwen/settings.json was changed in a way Plannotator did not expect (it is not valid JSON), so Plannotator put it back as it was");
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(readInboxAgents(dataDir).agents.qwen).toBeUndefined();
  });

  test("a qwen that drops the person's other servers: put back; a file that was not there is not left half written either", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const dropped = await connect({ FAKE_QWEN_DROP: "1" });
    expect(dropped.failed[0]!.reason).toContain('(it lost the server "github")');
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);

    const bare = createFakeAgents("plannotator-qwen-bare-");
    try {
      bare.install("qwen");
      mkdirSync(join(bare.home, ".qwen"), { recursive: true });
      const report = await connectInboxAgents({
        dataDir: join(bare.root, "data"),
        selfCommand: SELF,
        environment: createAgentEnvironmentFor({ platform: "linux", homeDir: bare.home, env: { ...bare.env, FAKE_QWEN_BREAK: "1" } }),
      });
      expect(report.failed).toHaveLength(1);
      expect(existsSync(join(bare.home, ".qwen", "settings.json"))).toBe(false);
    } finally {
      bare.remove();
    }
  });

  test("uninstall removes only Plannotator's entry through `qwen mcp remove`, the person's servers kept; a remove that breaks the file is put back", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    const withEntry = readFileSync(settingsPath(), "utf8");

    // A qwen that breaks the file on remove: put back as it was (the entry still there, said).
    const breaking = planInboxAgentRemoval(dataDir, environment({ FAKE_QWEN_BREAK: "1" }), OURS);
    expect(breaking.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (qwen mcp remove -s user plannotator-inbox)"]);
    expect(await breaking.items[0]!.apply()).toContain("so Plannotator put it back as it was");
    expect(readFileSync(settingsPath(), "utf8")).toBe(withEntry);

    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(await plan.items[0]!.apply()).toBeNull();
    const settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
    expect(settings.mcpServers).toEqual({ github: { command: "gh-mcp", args: ["--stdio"] } });
    expect(settings.general).toEqual({ vimMode: true });
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "absent" });
  });

  test("an entry the person changed to run something else is theirs: never replaced, never removed", async () => {
    fake.install("qwen");
    writeSettings(JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "my-proxy", args: [] } } }));
    const report = await connect();
    expect(report.foreign).toEqual([{ agent: "qwen", path: "~/.qwen/settings.json" }]);
    expect(qwenCalls()).toEqual([]);
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toEqual([]);
  });

  test("the spec names Qwen's own folder and file (read with comments, as Qwen reads it)", () => {
    writeSettings('{\n  // mine\n  "mcpServers": { "plannotator-inbox": { "command": "/opt/plannotator/bin/plannotator", "args": ["inbox", "mcp"] } }\n}\n');
    expect(agentSpec("qwen").file(environment())).toBe(settingsPath());
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });
});
