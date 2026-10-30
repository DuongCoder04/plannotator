/**
 * The environment of every agent process Ask AI starts (Claude, Codex,
 * OpenCode, Pi, Qwen Code): the live env with Plannotator's own integration
 * switched off inside it.
 *
 * Ask AI drives an agent headlessly, and that agent loads the person's
 * configuration, Plannotator's integration included: the Inbox MCP server
 * (`plannotator inbox mcp`), the agent tool, and the plan hooks (Claude Code's
 * ExitPlanMode PermissionRequest, the Codex Stop hook, Qwen Code's
 * exit_plan_mode). Left on, a question could post to the person's Inbox or
 * block on a plan review nobody is waiting for. So the child gets:
 *
 *  - `PLANNOTATOR_INBOX_TOOL=0` and `PLANNOTATOR_AGENT_TOOL=0`: the switches
 *    the Claude Code mod, the OpenCode plugin and the Pi extension already
 *    read, and which win over config.json (`resolveInboxTool` /
 *    `resolveAgentTool` in packages/shared/config.ts).
 *  - `PLANNOTATOR_ASK_AI_CHILD=1`: the marker the rest honours
 *    (`isAskAiChild` in packages/shared/child-env.ts): the Inbox MCP shim
 *    lists no tools, the plan-review hook (`plannotator` with no arguments)
 *    exits 0 at once, and the OpenCode plugin stands down.
 *
 * Codex does not pass the env to a stdio MCP server, so codex-app-server.ts
 * also turns the Inbox server off by config (`codexAskAiConfigArgs`, below).
 * Claude sessions disallow it by name (claude-agent-sdk.ts).
 *
 * The review server's agent jobs (code review, Code Tour, Guided Review,
 * `agent-jobs.ts` in both runtimes) get the same env and, for `codex exec`,
 * the same `-c` override: none of them uses Plannotator's integration (each
 * returns its result on stdout or in its `-o` file).
 *
 * Bun-free and Node-safe: vendored into the Pi extension.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The marker's name. Only the exact value "1" counts. */
export const ASK_AI_CHILD_ENV = "PLANNOTATOR_ASK_AI_CHILD";

/** What `askAiChildEnv` lays over the env it copies. */
export const ASK_AI_CHILD_SWITCHES: Readonly<Record<string, string>> = {
	PLANNOTATOR_INBOX_TOOL: "0",
	PLANNOTATOR_AGENT_TOOL: "0",
	[ASK_AI_CHILD_ENV]: "1",
};

/** A copy of `env` (default: the LIVE process.env) with Plannotator's integration off. */
export function askAiChildEnv(
	env: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> {
	return { ...env, ...ASK_AI_CHILD_SWITCHES };
}

/**
 * Run `start` with `ASK_AI_CHILD_SWITCHES` set on process.env, and put
 * process.env back before returning. Only for a spawn API that takes no env
 * and copies process.env synchronously inside the call: the OpenCode SDK's
 * `createOpencodeServer` (its `cross-spawn` call with `{ ...process.env }`
 * comes before its first await). JavaScript runs one call at a time, so no
 * other code, a concurrent Ask AI start included, sees the change.
 * `ask-ai-env.test.ts` runs the installed SDK against a fake `opencode` to
 * keep that true.
 */
export function withAskAiChildEnv<T>(start: () => T): T {
	const saved = Object.keys(ASK_AI_CHILD_SWITCHES).map((key) => [key, process.env[key]] as const);
	Object.assign(process.env, ASK_AI_CHILD_SWITCHES);
	try {
		return start();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/** The Inbox MCP server Plannotator connects to Codex (`INBOX_MCP_SERVER_NAME` in packages/server/inbox-agents.ts). */
const CODEX_INBOX_SERVER = "plannotator-inbox";

/**
 * The global `-c` override every `codex app-server` that Ask AI starts gets,
 * and every `codex exec` agent job of the review server (code review, Code
 * Tour, Guided Review). It turns off the Inbox MCP server. The marker in the
 * agent's env (`askAiChildEnv`) cannot do this, because Codex starts a stdio MCP server with
 * a cleared environment that holds only HOME, PATH and a few others
 * (codex-rs/rmcp-client `create_env_for_mcp_server`). Codex hooks get the
 * whole env, so the Stop hook does see the marker.
 *
 * Codex deep-merges `-c` tables over config.toml and then rejects an entry
 * that has both `command` and `url`, or neither. So:
 *  - the person's entry has a `url` (the HTTP transport): only
 *    `enabled=false`, because the entry already has its transport;
 *  - otherwise: a whole disabled stdio server. It is merged over a stdio entry,
 *    or added when there is none. Its own `env` carries the marker, so a Codex
 *    that ignored `enabled` would still start a shim that lists no tools.
 * Known gap, not handled: only `$CODEX_HOME/config.toml` is read. A `url`
 * entry for `plannotator-inbox` in a project's `.codex/config.toml` makes the
 * stub invalid, and app-server (without `--strict-config`) then warns
 * "Invalid configuration; using defaults." and runs that Ask AI session or job on
 * Codex's default config. That is rare. Literal strings and no spaces: the
 * argument stays unquoted on the cmd.exe line of a Windows `.cmd` shim.
 */
export function codexAskAiConfigArgs(configText: string | null): string[] {
  if (configText !== null && codexInboxEntryHasUrl(configText)) {
    return ["-c", `mcp_servers.${CODEX_INBOX_SERVER}.enabled=false`];
  }
  return [
    "-c",
    `mcp_servers.${CODEX_INBOX_SERVER}={command='plannotator',args=['inbox','mcp'],env={PLANNOTATOR_ASK_AI_CHILD='1'},enabled=false}`,
  ];
}

/** `$CODEX_HOME/config.toml` (a relative CODEX_HOME resolved against `cwd`, as Codex does), else `~/.codex/config.toml`; null when unreadable. Read only. */
export function readCodexConfigText(cwd: string, env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const home = env.CODEX_HOME?.trim();
  try {
    return readFileSync(join(home ? resolve(cwd, home) : join(homedir(), ".codex"), "config.toml"), "utf8");
  } catch {
    return null;
  }
}

/** A TOML key (`a."b-c".d`) as its parts; null when the text is not a plain key. */
function tomlKeyPath(text: string): string[] | null {
  const part = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  const parts: string[] = [];
  let at = 0;
  while (at < text.length) {
    part.lastIndex = at;
    const match = part.exec(text);
    if (!match) return null;
    parts.push(match[1] ?? match[2] ?? match[3]!);
    at = part.lastIndex;
    if (match[4] !== ".") break;
  }
  return parts.length > 0 && at >= text.length ? parts : null;
}

/** The first key of each top-level member of an inline table (`{ url = "…", env = { … } }`). */
function inlineTableKeys(value: string): string[] {
  let inner = value.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').trim();
  if (!inner.startsWith("{")) return [];
  const close = inner.lastIndexOf("}");
  inner = inner.slice(1, close < 0 ? undefined : close);
  // Drop nested tables and arrays, innermost first, so only top-level members remain.
  const nested = /[{[][^{}[\]]*[}\]]/;
  while (nested.test(inner)) inner = inner.replace(new RegExp(nested.source, "g"), "");
  return inner
    .split(",")
    .map((member) => tomlKeyPath(member.slice(0, Math.max(0, member.indexOf("="))))?.[0])
    .filter((key): key is string => key !== undefined);
}

/**
 * Whether config.toml's `mcp_servers.plannotator-inbox` has a `url`, in any
 * form: its `[mcp_servers.plannotator-inbox]` table, an inline table, or
 * dotted keys. A line scan, not a full TOML parser: something it cannot read
 * counts as no `url` (the same gap as a project config, see
 * `codexAskAiConfigArgs`).
 */
export function codexInboxEntryHasUrl(configText: string): boolean {
  let table: string[] = [];
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = /^\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line);
    if (header) {
      table = tomlKeyPath(header[1]!) ?? [""];
      continue;
    }
    const eq = line.indexOf("=");
    const key = eq > 0 ? tomlKeyPath(line.slice(0, eq)) : null;
    if (!key) continue;
    const path = [...table, ...key];
    if (path[0] !== "mcp_servers" || path[1] !== CODEX_INBOX_SERVER) continue;
    if (path.length > 2 ? path[2] === "url" : inlineTableKeys(line.slice(eq + 1)).includes("url")) return true;
  }
  return false;
}
