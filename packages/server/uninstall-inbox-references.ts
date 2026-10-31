import { INBOX_AGENT_LABELS, type InboxAgentId } from "@plannotator/core/inbox-types";
import {
  AGENT_SPECS, agentHomeAllowed, claudeCodeMcpEntry, claudeCodeMcpPath, displayPath, entryArgv,
  INBOX_MCP_SERVER_NAME, inboxEntryRemovalHint, isPlannotatorInboxCommand, type AgentEnvironment,
} from "./inbox-agents";
import type { Unreadable } from "./uninstall-host-references";

/**
 * The most of one agent file this check reads. The Inbox's own caps (1 MiB,
 * 32 MiB for ~/.claude.json) are for reads a running Inbox repeats; uninstall
 * runs once, so a big file (Claude Code's history) is still read and checked.
 */
const UNINSTALL_READ_MAX_BYTES = 512 * 1024 * 1024;

export type InboxReferenceScan = {
  /** Entries no record says Plannotator added that still run it: named with how to remove them, never a reason to keep the CLI. */
  warnings: string[];
  /** Agent configs that could not be read. */
  unreadable: Array<Unreadable & { owner: string }>;
};

/**
 * Every agent's `plannotator-inbox` entry that still runs Plannotator,
 * whoever added it. `skip`: the agents whose entry uninstall already removed
 * or named (`planInboxAgentRemoval`).
 */
export function remainingInboxReferences(
  environment: AgentEnvironment,
  binaryPaths: readonly string[],
  skip: ReadonlySet<InboxAgentId>,
): InboxReferenceScan {
  const scan: InboxReferenceScan = { warnings: [], unreadable: [] };
  if (!agentHomeAllowed(environment)) return scan;
  const normalize = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    return environment.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const executables = new Set([...binaryPaths, "plannotator", ...(environment.platform === "win32" ? ["plannotator.exe"] : [])].map(normalize));
  for (const spec of AGENT_SPECS) {
    if (skip.has(spec.id)) continue;
    const claude = spec.id === "claude-code";
    const path = claude ? claudeCodeMcpPath(environment) : spec.file(environment);
    if (!path) continue;
    const read = claude ? claudeCodeMcpEntry(environment, [], UNINSTALL_READ_MAX_BYTES) : spec.raw(environment, UNINSTALL_READ_MAX_BYTES);
    if (!read || read.kind === "absent") continue;
    const owner = INBOX_AGENT_LABELS[spec.id];
    if (read.kind === "unreadable") {
      scan.unreadable.push({ file: path, reason: read.reason, owner });
      continue;
    }
    const argv = read.kind === "value" ? entryArgv(read.value) : read.argv;
    const executable = argv?.[0];
    // Source execution uses Bun/Node; the interpreter alone is not Plannotator.
    const sourceCommand = argv?.length === 4 && isPlannotatorInboxCommand(argv);
    if (executable && (executables.has(normalize(executable)) || sourceCommand)) {
      scan.warnings.push(
        `Skipped: ${owner}'s "${INBOX_MCP_SERVER_NAME}" in ${displayPath(path, environment)} runs Plannotator and will fail to start once it is gone, but no record says Plannotator added it, so it is left (to remove it, ${inboxEntryRemovalHint(spec.id)}).`,
      );
    }
  }
  return scan;
}
