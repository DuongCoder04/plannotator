/**
 * claude-agent-acp and codex-acp run their own bundled Claude / Codex unless
 * CLAUDE_CODE_EXECUTABLE / CODEX_PATH name another one. These start the FAKE
 * ACP agent (tests/fake-acp-agent.ts, never a real adapter) the way Guides
 * starts an adapter, and read back what the adapter process was given.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_CODE, CODEX, OPENCODE, resolveAgentLaunch, type AgentDescriptor } from "./agents";
import { AcpClient } from "./client";
import { isSameProgram } from "./same-program";

const FAKE_AGENT = join(import.meta.dir, "..", "..", "..", "tests", "fake-acp-agent.ts");
const dir = mkdtempSync(join(tmpdir(), "pn-agent-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CLI_VARS = ["CLAUDE_CODE_EXECUTABLE", "CODEX_PATH"] as const;
let saved: Record<string, string | undefined> = {};
beforeEach(() => {
  // The adapter inherits this process's environment: start every test without the user's own values.
  saved = Object.fromEntries(CLI_VARS.map((k) => [k, process.env[k]]));
  for (const k of CLI_VARS) delete process.env[k];
});
afterEach(() => {
  for (const k of CLI_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Programs "on PATH": the fake adapter for the adapter's command, `/opt/me/bin/<name>` for the CLIs given. */
const onPath = (clis: string[]) => (name: string) => (name === process.execPath ? name : clis.includes(name) ? `/opt/me/bin/${name}` : null);

let n = 0;
/** Resolve the agent as Guides does, start the fake adapter with that launch, and answer the CLI variables it saw. */
async function adapterSees(agent: AgentDescriptor, clis: string[], env: Record<string, string | undefined> = process.env) {
  const launch = resolveAgentLaunch(agent, { command: process.execPath, args: [FAKE_AGENT] }, onPath(clis), () => null, process.platform, isSameProgram, env);
  if (!launch.ok) throw new Error(launch.message);
  const script = join(dir, `script-${++n}.json`);
  const log = join(dir, `agent-${n}.log`);
  writeFileSync(script, JSON.stringify({ steps: [] }));
  const client = await AcpClient.start(
    { command: launch.command, args: launch.args, cwd: dir, env: { ...launch.env, FAKE_ACP_SCRIPT: script, FAKE_ACP_LOG: log } },
    { onUpdate: () => {}, requestPermission: async () => ({ outcome: { outcome: "cancelled" } }) },
    { name: "plannotator-vscode", title: "Plannotator", version: "test" },
  );
  client.dispose();
  const entries = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  return { cliEnv: entries.find((e) => e.event === "initialize")?.cliEnv, notice: launch.notice };
}

describe("an adapter runs the user's own CLI, not the copy it bundles", () => {
  it("Claude Code: CLAUDE_CODE_EXECUTABLE is the `claude` on PATH", async () => {
    const seen = await adapterSees(CLAUDE_CODE, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: "/opt/me/bin/claude", CODEX_PATH: null });
    expect(seen.notice).toBeUndefined();
  });

  it("Codex: CODEX_PATH is the `codex` on PATH", async () => {
    const seen = await adapterSees(CODEX, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: "/opt/me/bin/codex" });
  });

  it("keeps a CLAUDE_CODE_EXECUTABLE the user set themselves", async () => {
    process.env.CLAUDE_CODE_EXECUTABLE = "/my/own/claude";
    const seen = await adapterSees(CLAUDE_CODE, ["claude"]);
    expect(seen.cliEnv?.CLAUDE_CODE_EXECUTABLE).toBe("/my/own/claude");
    expect(seen.notice).toBeUndefined();
  });

  it("with no `claude` installed, still starts (the adapter's own copy) and says so", async () => {
    const seen = await adapterSees(CLAUDE_CODE, []);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: null });
    expect(seen.notice).toContain("Install Claude Code and sign in");
  });

  it("adds nothing for an agent that is its own CLI", async () => {
    const seen = await adapterSees(OPENCODE, ["claude", "codex"]);
    expect(seen.cliEnv).toEqual({ CLAUDE_CODE_EXECUTABLE: null, CODEX_PATH: null });
    expect(seen.notice).toBeUndefined();
  });
});
