import type { InboxAgentId } from "@plannotator/core/inbox-types";
import {
  AGENT_SPECS, agentHomeAllowed, claudeCodeMcpEntry, claudeCodeMcpPath,
  entryArgv, isPlannotatorInboxCommand, type AgentEnvironment,
} from "./inbox-agents";

/** Inspect executable references independently of who owns the MCP entry. */
export function remainingInboxReferences(
  environment: AgentEnvironment,
  binaryPaths: readonly string[],
  projectedRemovals: ReadonlySet<InboxAgentId> = new Set(),
): string[] {
  if (!agentHomeAllowed(environment)) return [];
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return environment.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const executables = new Set([...binaryPaths, "plannotator", ...(environment.platform === "win32" ? ["plannotator.exe"] : [])].map(normalize));
  const references: string[] = [];
  for (const spec of AGENT_SPECS) {
    if (projectedRemovals.has(spec.id)) continue;
    const path = spec.id === "claude-code" ? claudeCodeMcpPath(environment) : spec.file(environment);
    if (!path) continue;
    let container = "mcpServers";
    if (spec.id === "codex") container = "mcp_servers";
    if (spec.id === "amp") container = '["amp.mcpServers"]';
    const field = `${container}["plannotator-inbox"].command`;
    const raw = spec.raw(environment);
    const claude = spec.id === "claude-code" ? claudeCodeMcpEntry(environment, []) : null;
    const read = claude ?? raw;
    if (!read || read.kind === "absent") continue;
    if (read.kind === "unreadable") {
      references.push(`Could not inspect ${path}, ${field}: ${read.reason}. Repair the file and remove only a Plannotator entry if present`);
      continue;
    }
    const argv = read.kind === "value" ? entryArgv(read.value) : read.argv;
    const executable = argv?.[0];
    // Source execution uses Bun/Node; the interpreter alone is not Plannotator.
    const sourceCommand = argv?.length === 4 && isPlannotatorInboxCommand(argv);
    if (executable && (executables.has(normalize(executable)) || sourceCommand)) {
      references.push(`${path}, ${field} still invokes Plannotator. Remove only that entry; preserve unrelated MCP servers`);
    }
  }
  return references;
}
