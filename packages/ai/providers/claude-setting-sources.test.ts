import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";

// A fake `claude` (never the real one): it writes the arguments the SDK gave
// it, one per line, and exits, so the session ends with an error.
const dir = mkdtempSync(join(tmpdir(), "plannotator-fake-claude-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakeClaude(): { path: string; argv: () => string[] } {
  const log = join(dir, `argv-${Math.random().toString(36).slice(2)}.txt`);
  const path = join(dir, `claude-${Math.random().toString(36).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done\nexit 1\n`);
  chmodSync(path, 0o755);
  return { path, argv: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []) };
}

/** The value the SDK passed as `--setting-sources` (either `--x=v` or `--x v`). */
function settingSources(argv: string[]): string[] | undefined {
  const i = argv.findIndex((a) => a === "--setting-sources" || a.startsWith("--setting-sources="));
  if (i < 0) return undefined;
  const value = argv[i].includes("=") ? argv[i].slice(argv[i].indexOf("=") + 1) : argv[i + 1];
  return value.split(",");
}

describe("Ask AI's Claude session loads the user's settings like `claude` does", () => {
  test.skipIf(process.platform === "win32")("passes user, project and local (CLAUDE.local.md, .claude/settings.local.json)", async () => {
    const cli = fakeClaude();
    const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dir, claudeExecutablePath: cli.path });
    const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } });
    for await (const _ of session.query("hello")) {
      // Drain until the fake exits.
    }
    expect(settingSources(cli.argv())?.sort()).toEqual(["local", "project", "user"]);
  }, 15_000);
});
