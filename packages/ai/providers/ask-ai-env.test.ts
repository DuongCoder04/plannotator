/**
 * Every agent process Ask AI starts carries Plannotator's integration off
 * (ask-ai-env.ts), checked against fake CLIs that record what they were
 * started with. No real agent CLI ever runs. Pi and Qwen Code are checked in
 * their own provider tests (pi-sdk-models.test.ts, qwen-sdk.test.ts), the
 * OpenCode provider's call in opencode-sdk.test.ts.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { createOpencodeServer } from "@opencode-ai/sdk/server";
import { isAskAiChild } from "../../shared/child-env.ts";
import { askAiChildEnv, withAskAiChildEnv } from "./ask-ai-env.ts";
import { ClaudeAgentSDKProvider } from "./claude-agent-sdk.ts";
import { CodexAppServerProvider } from "./codex-app-server.ts";

const dir = mkdtempSync(join(tmpdir(), "plannotator-ask-ai-env-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const posix = process.platform !== "win32";

/** The switches as a fake saw them: `KEY=value` lines its shell wrote. */
function switchesIn(file: string): Record<string, string> {
	if (!existsSync(file)) return {};
	return Object.fromEntries(
		readFileSync(file, "utf8")
			.split("\n")
			.filter(Boolean)
			.map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
	);
}

/** A shell prelude that records the three switches in `file`. */
function recordSwitches(file: string): string {
	return [
		`printf 'PLANNOTATOR_ASK_AI_CHILD=%s\\n' "$PLANNOTATOR_ASK_AI_CHILD" >> '${file}'`,
		`printf 'PLANNOTATOR_INBOX_TOOL=%s\\n' "$PLANNOTATOR_INBOX_TOOL" >> '${file}'`,
		`printf 'PLANNOTATOR_AGENT_TOOL=%s\\n' "$PLANNOTATOR_AGENT_TOOL" >> '${file}'`,
	].join("\n");
}

const OFF = { PLANNOTATOR_ASK_AI_CHILD: "1", PLANNOTATOR_INBOX_TOOL: "0", PLANNOTATOR_AGENT_TOOL: "0" };

function fakeCli(name: string, body: string): string {
	const path = join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
	writeFileSync(path, body);
	chmodSync(path, 0o755);
	return path;
}

describe("the marker the integrations read", () => {
	test("is set by askAiChildEnv and read only as the exact value 1", () => {
		expect(isAskAiChild(askAiChildEnv({}))).toBe(true);
		expect(isAskAiChild({})).toBe(false);
		for (const value of ["", "0", "true", "yes", " 1", "1 "]) {
			expect(isAskAiChild({ PLANNOTATOR_ASK_AI_CHILD: value })).toBe(false);
		}
	});
});

describe("Codex: `codex app-server`", () => {
	test.if(posix)("runs with the switches in its env and the Inbox MCP server turned off", async () => {
		const envFile = join(dir, "codex-env.txt");
		const argvFile = join(dir, "codex-argv.txt");
		const script = join(dir, "fake-codex-app-server.mjs");
		writeFileSync(
			script,
			`let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.id === undefined) continue;
    const result = msg.method === "initialize"
      ? { userAgent: "plannotator/0.160.0 (Linux)" }
      : { data: [{ id: "gpt-6-sol", displayName: "GPT-6-Sol", isDefault: true }] };
    process.stdout.write(JSON.stringify({ id: msg.id, result }) + "\\n");
  }
});
`,
		);
		const codex = fakeCli(
			"codex",
			`#!/bin/sh\n${recordSwitches(envFile)}\nfor a in "$@"; do printf '%s\\n' "$a" >> '${argvFile}'; done\nexec '${process.execPath}' '${script}'\n`,
		);
		const provider = new CodexAppServerProvider({ type: "codex-sdk", codexExecutablePath: codex });
		try {
			await provider.fetchModels();
		} finally {
			provider.dispose();
		}
		expect(switchesIn(envFile)).toEqual(OFF);
		const argv = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
		// Codex gives a stdio MCP server only HOME, PATH and a few others, so the
		// env cannot reach the Inbox shim: the server is turned off by a -c override.
		const override = argv[argv.indexOf("-c") + 1] ?? "";
		expect(argv.indexOf("-c")).toBeGreaterThanOrEqual(0);
		expect(argv.indexOf("-c")).toBeLessThan(argv.indexOf("app-server"));
		const value = Bun.TOML.parse(`v = ${override.slice(override.indexOf("=") + 1)}`).v as Record<string, unknown>;
		expect(override.slice(0, override.indexOf("="))).toBe("mcp_servers.plannotator-inbox");
		// A whole stdio server (valid with or without the person's entry), disabled.
		expect(value).toMatchObject({ command: "plannotator", enabled: false, env: { PLANNOTATOR_ASK_AI_CHILD: "1" } });
	}, 15_000);
});

describe("Claude: the Agent SDK's `claude`", () => {
	test.if(posix)("runs with the switches in its env", async () => {
		const envFile = join(dir, "claude-env.txt");
		// Records its env and exits, so the session ends with an error.
		const claude = fakeCli("claude", `#!/bin/sh\n${recordSwitches(envFile)}\nexit 1\n`);
		const provider = new ClaudeAgentSDKProvider({ type: "claude-agent-sdk", cwd: dir, claudeExecutablePath: claude });
		const session = await provider.createSession({ context: { mode: "plan-review", plan: { plan: "# Plan" } } });
		for await (const _ of session.query("hello")) {
			// Drain until the fake exits.
		}
		expect(switchesIn(envFile)).toEqual(OFF);
	}, 15_000);
});

describe("OpenCode: the installed SDK's createOpencodeServer", () => {
	// The SDK takes no env; withAskAiChildEnv relies on it copying process.env
	// synchronously inside the call. This runs the real SDK, not a mock.
	test.if(posix)("copies the switches into `opencode serve`, and process.env is back as it was when the call returns", async () => {
		const binDir = mkdtempSync(join(dir, "bin-"));
		const envFile = join(dir, "opencode-env.txt");
		writeFileSync(
			join(binDir, "opencode"),
			`#!/bin/sh\n${recordSwitches(envFile)}\necho "opencode server listening on http://127.0.0.1:4999"\nexec sleep 30\n`,
		);
		chmodSync(join(binDir, "opencode"), 0o755);
		const saved = { PATH: process.env.PATH, marker: process.env.PLANNOTATOR_ASK_AI_CHILD };
		process.env.PATH = `${binDir}${delimiter}${saved.PATH ?? ""}`;
		delete process.env.PLANNOTATOR_ASK_AI_CHILD;
		let server: { url: string; close(): void } | undefined;
		try {
			const starting = withAskAiChildEnv(() => createOpencodeServer({ hostname: "127.0.0.1", port: 0, timeout: 10_000 }));
			// Restored before the server is even up: no other code sees the switches.
			expect(process.env.PLANNOTATOR_ASK_AI_CHILD).toBeUndefined();
			server = await starting;
			expect(server.url).toBe("http://127.0.0.1:4999");
			expect(switchesIn(envFile)).toEqual(OFF);
		} finally {
			server?.close();
			process.env.PATH = saved.PATH;
			if (saved.marker === undefined) delete process.env.PLANNOTATOR_ASK_AI_CHILD;
			else process.env.PLANNOTATOR_ASK_AI_CHILD = saved.marker;
		}
	}, 15_000);
});
