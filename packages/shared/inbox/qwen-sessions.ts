/**
 * Qwen Code's session registry, read only: `$QWEN_HOME/sessions/<pid>.json`
 * (or `<pid>-<8 hex>.json` for a process hosting several sessions), one
 * record per running session, written by Qwen itself (its cross-session
 * protocol, schema version 1). The stdio shim reads its parent's record on
 * every tool call, because `/clear` and `/resume` give the session a new id
 * under the same process while the MCP server keeps the environment it was
 * started with. Plannotator never writes or deletes a record.
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseQwenSessionRecord, qwenRecordFilePid, type InboxQwenSessionRecord } from "@plannotator/core/inbox-types";

/** A record is a few hundred bytes; anything far larger is not one. */
const RECORD_MAX_BYTES = 64 * 1024;

/**
 * Qwen Code's home folder as Qwen resolves it: `$QWEN_HOME` IS the folder
 * (not a parent of `.qwen`, unlike Gemini's `GEMINI_CLI_HOME`), a leading `~`
 * expanded, a relative one resolved against the working folder, empty taken
 * as unset; else `~/.qwen`.
 */
export function qwenHome(env: Readonly<Record<string, string | undefined>>, homeDir: string, cwd: string): string {
  const value = env.QWEN_HOME?.trim();
  if (!value) return join(homeDir, ".qwen");
  const expanded = value === "~" ? homeDir : value.startsWith("~/") ? join(homeDir, value.slice(2)) : value;
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

export function qwenSessionsDir(home: string): string {
  return join(home, "sessions");
}

/** One record file, read and checked; null when it is missing, not a plain file, too large, not JSON or not usable. */
export function readQwenSessionRecord(path: string, file: { pid: number; shared: boolean }): InboxQwenSessionRecord | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > RECORD_MAX_BYTES) return null;
    return parseQwenSessionRecord(JSON.parse(readFileSync(path, "utf8")) as unknown, file);
  } catch {
    return null;
  }
}

/** Every usable record in the registry (none when the folder is missing). */
export function listQwenSessionRecords(home: string): InboxQwenSessionRecord[] {
  const dir = qwenSessionsDir(home);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: InboxQwenSessionRecord[] = [];
  for (const name of names) {
    const file = qwenRecordFilePid(name);
    if (!file) continue;
    const record = readQwenSessionRecord(join(dir, name), file);
    if (record) records.push(record);
  }
  return records;
}

/**
 * The session the Qwen process `pid` runs now: its `<pid>.json`, else its one
 * `<pid>-<8 hex>.json`. Null when it has none, or several (a process hosting
 * several sessions: only the call itself can say which).
 */
export function qwenSessionOfProcess(home: string, pid: number): InboxQwenSessionRecord | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) return null;
  const dir = qwenSessionsDir(home);
  const bare = readQwenSessionRecord(join(dir, `${pid}.json`), { pid, shared: false });
  if (bare) return bare;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const mine = names.filter((name) => name.startsWith(`${pid}-`)).flatMap((name) => {
    const file = qwenRecordFilePid(name);
    const record = file && file.pid === pid ? readQwenSessionRecord(join(dir, name), file) : null;
    return record ? [record] : [];
  });
  return mine.length === 1 ? mine[0]! : null;
}
