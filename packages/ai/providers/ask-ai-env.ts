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
 *    exits 0 at once, and the OpenCode plugin and the mod stand down.
 *
 * Bun-free and Node-safe: vendored into the Pi extension.
 */

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
