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
 *   > DeepSeek Harness (DSH_SHELL) — DSH scrubs inherited DSH_* variables and
 *     sets DSH_SHELL=1 (plus DSH_SESSION_ID, DSH_HOME) in every shell it
 *     spawns, so the marker is always its own. Checked after the runtimes
 *     above for the same reason as OMPCODE below: a runtime launched from a
 *     DSH shell or terminal must still be detected as itself.
 *   > oh-my-pi harness (OMPCODE) — checked last because OMP exports OMPCODE
 *     into every shell it spawns; runtimes launched from an OMP session must
 *     still be detected as themselves. OMPCODE still wins over the terminal
 *     fallback below.
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
    env.DSH_SHELL ? "dsh" :
    env.OMPCODE ? "oh-my-pi" :
    "claude-code";
}
