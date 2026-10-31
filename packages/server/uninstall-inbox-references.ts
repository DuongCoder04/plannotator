import { readFileSync } from "node:fs";
import { INBOX_AGENT_LABELS, type InboxAgentId } from "@plannotator/core/inbox-types";
import {
  AGENT_SPECS, agentHomeAllowed, claudeCodeMcpEntry, claudeCodeMcpPath, displayPath, entryArgv,
  INBOX_MCP_SERVER_NAME, inboxEntryRemovalHint, isPlannotatorInboxCommand, type AgentEnvironment, type InboxEntryRead,
} from "./inbox-agents";
import type { Unreadable } from "./uninstall-host-references";

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
    let read: InboxEntryRead | EntryRead | null = claude ? claudeCodeMcpEntry(environment, []) : spec.raw(environment);
    if (read?.kind === "unreadable" && read.reason.startsWith("it is larger than")) read = overCap(path, read.reason, claude);
    if (!read || read.kind === "absent") continue;
    const owner = INBOX_AGENT_LABELS[spec.id];
    if (read.kind === "unreadable") {
      scan.unreadable.push({
        file: path,
        reason: read.reason,
        ...(read.reason.includes("the most Plannotator reads") ? { next: `To continue, remove that entry yourself (${inboxEntryRemovalHint(spec.id)})` } : {}),
        owner,
      });
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

type EntryRead = { kind: "absent" } | { kind: "value"; value: unknown } | { kind: "unreadable"; reason: string };

/**
 * A file over the Inbox's size cap, read once in full: uninstall runs once,
 * and the cap is for reads a running Inbox repeats. One that never names the
 * entry can't hold it. Claude Code's ~/.claude.json (its history makes it
 * big) is parsed; another agent's is said, with how to remove the entry.
 */
function overCap(path: string, tooLarge: string, claude: boolean): EntryRead {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch {
    return { kind: "unreadable", reason: tooLarge };
  }
  if (!bytes.includes(INBOX_MCP_SERVER_NAME)) return { kind: "absent" };
  if (!claude) return { kind: "unreadable", reason: `${tooLarge}, the most Plannotator reads, and it mentions "${INBOX_MCP_SERVER_NAME}"` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8").replace(/^﻿/, ""));
  } catch {
    return { kind: "unreadable", reason: "it is not plain JSON" };
  }
  const servers = (parsed as { mcpServers?: unknown } | null)?.mcpServers;
  const value = servers && typeof servers === "object" ? (servers as Record<string, unknown>)[INBOX_MCP_SERVER_NAME] : undefined;
  return value === undefined ? { kind: "absent" } : { kind: "value", value };
}
