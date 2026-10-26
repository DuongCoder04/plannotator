import { AGENT_CONFIG, type Origin } from "@plannotator/shared/agents";

/**
 * Detect the calling agent from environment variables set by agent runtimes.
 * Priority:
 *   PLANNOTATOR_ORIGIN (explicit override, validated against AGENT_CONFIG)
 *   > Amp plugin wrappers (PLANNOTATOR_ORIGIN=amp)
 *   > Droid command wrappers (PLANNOTATOR_ORIGIN=droid)
 *   > Codex (CODEX_THREAD_ID)
 *   > Copilot CLI (COPILOT_CLI)
 *   > OpenCode (OPENCODE)
 *   > Gemini CLI (GEMINI_CLI)
 *   > oh-my-pi harness (OMPCODE) — checked after the runtimes above because
 *     OMP exports OMPCODE into every shell it spawns; runtimes launched from
 *     an OMP session must still be detected as themselves.
 *   > DeepSeek Harness (DSH_SHELL) — checked last of all, and skipped when the
 *     caller carries another agent's own marker. DSH sets DSH_SHELL=1 (plus
 *     DSH_SESSION_ID, DSH_HOME) in every model shell it spawns, and every
 *     process started from that shell inherits it (DSH scrubs only DSH_* and
 *     credential-shaped names from its own children, so it keeps other
 *     agents' markers too). An agent started from a DSH shell or terminal
 *     must still be detected as itself, including the agents the chain does
 *     not name: Claude Code (CLAUDECODE, set for every process Claude Code
 *     starts, its hooks included) and Pi (PI_SESSION_ID, set on each bash
 *     call), which otherwise fall back to claude-code as they do outside DSH.
 *     The other way round, an agent that DSH itself was started from, is
 *     ambiguous from env alone; the agent with its own marker wins.
 *
 *   > Mistral Vibe — detected from the pre_tool hook payload (hook_event_name
 *     "pre_tool" + tool_name "exit_plan_mode" is unambiguous vs Claude/Gemini),
 *     so the installer's hook command needs no env prefix. PLANNOTATOR_ORIGIN=
 *     mistral-vibe remains the manual override above.
 *
 * To add a new agent, also add an entry to AGENT_CONFIG in
 * packages/core/agents.ts (see header comment there).
 */
export function detectOrigin(env: Record<string, string | undefined>): Origin {
  const originOverride = env.PLANNOTATOR_ORIGIN as Origin | undefined;
  return (originOverride && originOverride in AGENT_CONFIG) ? originOverride :
    env.CODEX_THREAD_ID ? "codex" :
    env.COPILOT_CLI ? "copilot-cli" :
    env.OPENCODE ? "opencode" :
    env.GEMINI_CLI ? "gemini-cli" :
    env.OMPCODE ? "oh-my-pi" :
    env.DSH_SHELL && !hasNonDshAgentMarker(env) ? "dsh" :
    "claude-code";
}

/**
 * Markers that agents outside the chain above set for the processes they
 * start. Any of them means an inherited DSH_SHELL is not the caller.
 */
const NON_DSH_AGENT_MARKERS = ["CLAUDECODE", "PI_SESSION_ID"] as const;

function hasNonDshAgentMarker(env: Record<string, string | undefined>): boolean {
  return NON_DSH_AGENT_MARKERS.some((key) => !!env[key]);
}
