/**
 * Qwen Code's connection to the Inbox (inbox-agents.ts), with a fake `qwen`
 * on a scratch PATH and a scratch home (tests/helpers/fake-agents.ts; the real
 * qwen is never run and the real ~/.qwen never read). Plannotator edits Qwen's
 * settings.json itself (JSON with comments), never through `qwen mcp add`,
 * which writes the person's other servers back with their `${VAR}` values
 * filled in (the fake does too). What is guarded here: only Plannotator's
 * entry ever changes, comments and `${VAR}` included, and a file that does not
 * parse or is read-only is left as it is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
let cwdLog: string;

beforeEach(() => {
  fake = createFakeAgents("plannotator-qwen-");
  dataDir = join(fake.root, "data");
  mkdirSync(dataDir, { recursive: true });
  cwdLog = join(fake.root, "cwd.log");
  savedDataDir = process.env.PLANNOTATOR_DATA_DIR;
  process.env.PLANNOTATOR_DATA_DIR = dataDir;
});
afterEach(() => {
  process.env.PLANNOTATOR_DATA_DIR = savedDataDir;
  fake.remove();
});

function environment(extra: Record<string, string> = {}): AgentEnvironment {
  return createAgentEnvironmentFor({ platform: "linux", homeDir: fake.home, env: { ...fake.env, FAKE_AGENT_CWD_LOG: cwdLog, ...extra } });
}
const options = (extra: Record<string, string> = {}) => ({ dataDir, selfCommand: SELF, environment: environment(extra) });
const connect = (extra: Record<string, string> = {}) => connectInboxAgents(options(extra));
/** Every run of the fake qwen, `--version` included, with the folder it ran in. */
const qwenRuns = (): { args: string[]; cwd: string }[] =>
  existsSync(cwdLog)
    ? readFileSync(cwdLog, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { name: string; args: string[]; cwd: string })
        .filter((run) => run.name === "qwen")
    : [];
const settingsPath = () => join(fake.home, ".qwen", "settings.json");
const writeSettings = (text: string, path = settingsPath()) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const ENTRY = { command: OURS[0], args: ["inbox", "mcp"] };
/**
 * A person's settings.json as Qwen keeps it: comments, `$version`, and a
 * server whose token comes from the environment (`${GITHUB_TOKEN}`).
 */
const MINE = `{
  // Mine: the token stays in my environment.
  "$version": 3,
  "general": { "vimMode": true },
  "mcpServers": {
    "github": { "command": "gh-mcp", "args": ["--stdio"], "env": { "GITHUB_TOKEN": "\${GITHUB_TOKEN}" } } // keep
  }
}
`;
const SECRET = { GITHUB_TOKEN: "ghp_not_a_real_token_123" };

describe("connecting Qwen Code", () => {
  test("its settings.json gets the entry and nothing else: comments and the person's ${VAR} stay as written, qwen mcp is never run", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect(SECRET);
    expect(report.added).toEqual(["qwen"]);
    const text = readFileSync(settingsPath(), "utf8");
    // Byte for byte, the person's text is all still there; the only new text is the entry.
    expect(text).toContain('"GITHUB_TOKEN": "${GITHUB_TOKEN}" } }, // keep');
    expect(text).toContain("// Mine: the token stays in my environment.");
    expect(text).not.toContain(SECRET.GITHUB_TOKEN);
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
    // `qwen mcp add` writes every server back resolved (the fake does as Qwen 0.26 does): it is never run.
    expect(fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "mcp")).toEqual([]);
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", reach: "mcp", path: settingsPath() });
    expect(formatConnectReport(report)[0]).toContain("Qwen Code");

    const again = await connect(SECRET);
    expect(again.added).toEqual([]);
    expect(again.already).toEqual(["qwen"]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(text);
  });

  test("every qwen run is in the home folder, never the Inbox's working folder (Qwen rewrites that folder's .qwen/settings.json); its version is asked once", async () => {
    fake.install("qwen");
    await connect();
    const runs = qwenRuns();
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.cwd).toBe(fake.home);
    // The connect step and the trusted-sender check share one answer.
    expect(runs.filter((run) => run.args[0] === "--version")).toHaveLength(1);
  });

  test("found by its folder alone (no qwen on PATH): connected the same way", async () => {
    writeSettings(MINE);
    const report = await connect();
    expect(report.added).toEqual(["qwen"]);
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });

  test("QWEN_HOME is the folder itself: the entry goes in $QWEN_HOME/settings.json, never ~/.qwen", async () => {
    fake.install("qwen");
    const home = join(fake.root, "elsewhere");
    const report = await connect({ QWEN_HOME: home });
    expect(report.added).toEqual(["qwen"]);
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    expect(existsSync(join(fake.home, ".qwen"))).toBe(false);
    expect(readInboxAgents(dataDir).agents.qwen?.path).toBe(join(home, "settings.json"));
  });

  test("QWEN_HOME as Qwen reads it: `~` expanded, untrimmed, empty is unset, and from ~/.qwen/.env or ~/.env when not in the environment", () => {
    expect(qwenDir(environment({ QWEN_HOME: "~/q" }))).toBe(join(fake.home, "q"));
    expect(qwenDir(environment({ QWEN_HOME: "" }))).toBe(join(fake.home, ".qwen"));
    expect(qwenDir(environment({ QWEN_HOME: "/x/q " }))).toBe("/x/q ");
    writeFileSync(join(fake.home, ".env"), "OTHER=1\nQWEN_HOME=~/from-home-env\n");
    expect(qwenDir(environment())).toBe(join(fake.home, "from-home-env"));
    mkdirSync(join(fake.home, ".qwen"), { recursive: true });
    writeFileSync(join(fake.home, ".qwen", ".env"), "# Qwen's own\nexport QWEN_HOME=\"/srv/qwen\" # moved\n");
    expect(qwenDir(environment())).toBe("/srv/qwen");
    // The environment wins over both files, even empty.
    expect(qwenDir(environment({ QWEN_HOME: "/env/q" }))).toBe("/env/q");
    expect(qwenDir(environment({ QWEN_HOME: "" }))).toBe(join(fake.home, ".qwen"));
  });

  test("a relative QWEN_HOME names a different folder in every project: left to the person, nothing written", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    const report = await connect({ QWEN_HOME: "rel/q" });
    expect(report.manual).toEqual(["qwen"]);
    expect(report.manual_why?.[0]?.why).toContain("QWEN_HOME is a relative path");
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(join(fake.home, "rel"))).toBe(false);
  });

  test("a program that only shares the name is never taken for Qwen Code; any Qwen Code version is (a nightly too)", async () => {
    fake.install("qwen");
    const foreign = await connect({ FAKE_QWEN_VERSION: "qwen (image viewer) 3.1" });
    expect(foreign.manual_why).toEqual([{ agent: "qwen", why: "this qwen did not answer like Qwen Code" }]);
    expect(existsSync(settingsPath())).toBe(false);
    const old = await connect({ FAKE_QWEN_VERSION: "0.0.7" });
    expect(old.added).toEqual(["qwen"]);
    const nightly = createFakeAgents("plannotator-qwen-nightly-");
    try {
      nightly.install("qwen");
      const report = await connectInboxAgents({
        dataDir: join(nightly.root, "data"),
        selfCommand: SELF,
        environment: createAgentEnvironmentFor({ platform: "linux", homeDir: nightly.home, env: { ...nightly.env, FAKE_QWEN_VERSION: "0.27.0-nightly.20261027.a1b2c3d" } }),
      });
      expect(report.added).toEqual(["qwen"]);
    } finally {
      nightly.remove();
    }
  });

  test("turned off in Settings: only the entry goes (the file back byte for byte), and a later run never adds it back", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect(SECRET);
    expect(await setInboxAgentReach("qwen", false, options(SECRET))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");
    const later = await connect(SECRET);
    expect(later.added).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });
});

describe("QWEN_HOME is not the same as when the entry was added (set in one shell, not in another)", () => {
  const other = () => join(fake.root, "other-qwen");
  const otherSettings = () => join(other(), "settings.json");

  test("uninstall removes the entry from the file it was written in, byte for byte, and touches nothing in the other home", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    const plan = planInboxAgentRemoval(dataDir, environment({ QWEN_HOME: other() }), OURS);
    expect(plan.skipped).toEqual([]);
    expect(plan.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(existsSync(other())).toBe(false);
  });

  test("a run under the new home moves the entry: out of the old file (back byte for byte), into the new one, never called removed outside", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    const moved = await connect({ QWEN_HOME: other() });
    expect(moved.added).toEqual(["qwen"]);
    expect(moved.failed).toEqual([]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    const record = readInboxAgents(dataDir).agents.qwen!;
    expect(record).toMatchObject({ state: "added", path: otherSettings() });
    expect(record.removed_outside_at).toBeUndefined();
    // Only the new file's entry is left for uninstall, from whichever shell it runs.
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(existsSync(otherSettings())).toBe(false);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  test.skipIf(process.getuid?.() === 0)("an old file that cannot be written keeps the entry and its record: said once, nothing added in the new home, moved at a later run", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    const added = readFileSync(settingsPath(), "utf8");
    chmodSync(settingsPath(), 0o444);
    try {
      const first = await connect({ QWEN_HOME: other() });
      expect(first.added).toEqual([]);
      expect(first.failed).toHaveLength(1);
      expect(first.failed[0]!.reason).toContain("could not be moved");
      expect((await connect({ QWEN_HOME: other() })).failed).toEqual([]);
      expect(readFileSync(settingsPath(), "utf8")).toBe(added);
      expect(existsSync(otherSettings())).toBe(false);
      expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", path: settingsPath() });
      expect(readInboxAgents(dataDir).agents.qwen?.removed_outside_at).toBeUndefined();
    } finally {
      chmodSync(settingsPath(), 0o644);
    }
    expect((await connect({ QWEN_HOME: other() })).added).toEqual(["qwen"]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
  });

  test("the Settings switch acts on the recorded file: off removes it there; on in a new home takes the old one out first", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    expect(await setInboxAgentReach("qwen", false, options({ QWEN_HOME: other() }))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(readInboxAgents(dataDir).agents.qwen?.state).toBe("off");

    expect(await setInboxAgentReach("qwen", true, options())).toBeNull();
    expect(await setInboxAgentReach("qwen", true, options({ QWEN_HOME: other() }))).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    expect(JSON.parse(readFileSync(otherSettings(), "utf8")).mcpServers["plannotator-inbox"]).toEqual(ENTRY);
    expect(readInboxAgents(dataDir).agents.qwen).toMatchObject({ state: "added", path: otherSettings() });
  });
});

describe("Qwen's settings.json is never left broken", () => {
  test("a settings.json that is not valid JSON: left byte for byte, the reason said", async () => {
    fake.install("qwen");
    const broken = '{ "mcpServers": { "github": { "command": "gh-mcp" }, \n';
    writeSettings(broken);
    const report = await connect();
    expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json can't be read (it is not plain JSON), so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
    expect(readFileSync(settingsPath(), "utf8")).toBe(broken);
    expect(readInboxAgents(dataDir).agents.qwen).toBeUndefined();
  });

  test("a trailing comma (which Qwen itself refuses) is not valid either: left as it is", async () => {
    const trailing = '{\n  "mcpServers": { "github": { "command": "gh-mcp" }, },\n}\n';
    writeSettings(trailing);
    const report = await connect();
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]!.reason).toContain("so Plannotator left it as it was");
    expect(readFileSync(settingsPath(), "utf8")).toBe(trailing);
  });

  test.skipIf(process.getuid?.() === 0)("a read-only settings.json: left as it is, the reason said, and a later run tries again", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    chmodSync(settingsPath(), 0o444);
    try {
      const report = await connect();
      expect(report.failed).toEqual([{ agent: "qwen", reason: "~/.qwen/settings.json is read-only, so Plannotator left it as it was", path: "~/.qwen/settings.json" }]);
      expect(readFileSync(settingsPath(), "utf8")).toBe(MINE);
    } finally {
      chmodSync(settingsPath(), 0o644);
    }
    const later = await connect();
    expect(later.added).toEqual(["qwen"]);
  });

  test("uninstall removes only Plannotator's entry; an entry Qwen reformatted around is cut alone, comments kept", async () => {
    fake.install("qwen");
    writeSettings(MINE);
    await connect();
    // Qwen rewrote the file meanwhile (its own format-keeping writer: another key, the entry where it was).
    const rewritten = readFileSync(settingsPath(), "utf8").replace('"$version": 3,', '"$version": 4,\n  "ui": { "theme": "dark" }, // new');
    writeFileSync(settingsPath(), rewritten);
    const plan = planInboxAgentRemoval(dataDir, environment(), OURS);
    expect(plan.items.map((item) => item.describe)).toEqual(["MCP server plannotator-inbox from Qwen Code (~/.qwen/settings.json, that entry only)"]);
    expect(await plan.items[0]!.apply()).toBeNull();
    expect(readFileSync(settingsPath(), "utf8")).toBe(MINE.replace('"$version": 3,', '"$version": 4,\n  "ui": { "theme": "dark" }, // new'));
    expect(fake.calls().filter((call) => call.name === "qwen" && call.args[0] === "mcp")).toEqual([]);
  });

  test("a settings.json Plannotator created is deleted again on removal once only the empty containers are left", async () => {
    fake.install("qwen");
    await connect();
    expect(readInboxAgents(dataDir).agents.qwen?.created).toBe(true);
    expect(await planInboxAgentRemoval(dataDir, environment(), OURS).items[0]!.apply()).toBeNull();
    expect(existsSync(settingsPath())).toBe(false);
  });

  test("an entry the person changed to run something else is theirs: never replaced, never removed", async () => {
    fake.install("qwen");
    writeSettings(JSON.stringify({ mcpServers: { "plannotator-inbox": { command: "my-proxy", args: [] } } }));
    const report = await connect();
    expect(report.foreign).toEqual([{ agent: "qwen", path: "~/.qwen/settings.json" }]);
    expect(planInboxAgentRemoval(dataDir, environment(), OURS).items).toEqual([]);
  });

  test("the spec names Qwen's own folder and file (read with comments, as Qwen reads it)", () => {
    writeSettings('{\n  // mine\n  "mcpServers": { "plannotator-inbox": { "command": "/opt/plannotator/bin/plannotator", "args": ["inbox", "mcp"] } }\n}\n');
    expect(agentSpec("qwen").file(environment())).toBe(settingsPath());
    expect(readAgentEntry("qwen", environment(), [OURS])).toEqual({ kind: "ours", argv: OURS });
  });
});
