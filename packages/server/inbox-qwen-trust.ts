/**
 * Plannotator as a trusted sender in Qwen Code: the token that lets the Inbox
 * put the person's reply into a running Qwen session (inbox-qwen-wake.ts).
 *
 * Qwen Code delivers a message from another program without review only when
 * it presents a controller token (`qpc_<64 hex>`), which
 * `qwen sessions controllers add --label <label> --json` mints once and Qwen
 * never shows again (Qwen 0.24 or later). The owner's answer (2026-10-27):
 * Plannotator mints its own when it connects Qwen Code, says so in the
 * Connected band, and revokes it when Qwen Code is turned off in Settings →
 * Agents or Plannotator is uninstalled. `INBOX_QWEN_TRUST_ON_CONNECT` is that
 * answer; with it false, only `ensureQwenTrust(..., { force: true })` (a
 * Settings switch) would mint one.
 *
 * The token is kept at `<data dir>/inbox/qwen-trust.json` (0600, its folder
 * 0700), with the Qwen home it was minted in (a token is valid in that home
 * only) and the grant's id (what revoking takes). No token: no wake, and a
 * Qwen session's replies wait for it to read the Inbox.
 *
 * A grant the person revoked themselves (`qwen sessions controllers remove`)
 * is never minted again by itself: the file keeps `revoked_outside_at`, and
 * only turning Qwen Code off and on again in Settings mints a new one.
 */

import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { INBOX_QWEN_WAKE_MIN_VERSION } from "@plannotator/core/inbox-types";
import { inboxDir } from "@plannotator/shared/inbox/schema";
import { qwenHome } from "@plannotator/shared/inbox/qwen-sessions";
import { writeAgentFileAtomic } from "./agent-files";
import type { AgentEnvironment } from "./inbox-agents";

/** The owner's answer: Plannotator registers itself as Qwen's trusted sender when it connects Qwen Code. */
export const INBOX_QWEN_TRUST_ON_CONNECT = true;

/** The first Qwen Code with `qwen sessions controllers` (v0.24.0). */
export const INBOX_QWEN_TRUST_MIN_VERSION = INBOX_QWEN_WAKE_MIN_VERSION;

/** The grant's label: Qwen shows it to the model with each message (`origin="controller" controller="…"`) and to the person in `qwen sessions controllers list`. */
export const INBOX_QWEN_TRUST_LABEL = "Plannotator Inbox";

export const INBOX_QWEN_TRUST_FILE = "qwen-trust.json";

/** One `qwen` call may take this long. */
const QWEN_CALL_TIMEOUT_MS = 15_000;

const TOKEN = /^qpc_[0-9a-f]{64}$/;
const GRANT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export interface QwenTrustFile {
  v: 1;
  /** The Qwen home the grant is in. */
  home: string;
  id?: string;
  token?: string;
  created_at?: string;
  /** The person revoked the grant in Qwen: never minted again by itself. */
  revoked_outside_at?: string;
  /** The last reason a mint failed, so the terminal says a lasting one once. */
  failed?: string;
}

export function qwenTrustPath(dataDir: string): string {
  return join(inboxDir(dataDir), INBOX_QWEN_TRUST_FILE);
}

export function readQwenTrust(dataDir: string): QwenTrustFile | null {
  try {
    const parsed = JSON.parse(readFileSync(qwenTrustPath(dataDir), "utf8")) as Partial<QwenTrustFile>;
    if (!parsed || parsed.v !== 1 || typeof parsed.home !== "string" || !parsed.home) return null;
    const grant = typeof parsed.id === "string" && GRANT_ID.test(parsed.id) && typeof parsed.token === "string" && TOKEN.test(parsed.token);
    return {
      v: 1,
      home: parsed.home,
      ...(grant ? { id: parsed.id, token: parsed.token } : {}),
      ...(typeof parsed.created_at === "string" ? { created_at: parsed.created_at } : {}),
      ...(typeof parsed.revoked_outside_at === "string" ? { revoked_outside_at: parsed.revoked_outside_at } : {}),
      ...(typeof parsed.failed === "string" ? { failed: parsed.failed } : {}),
    };
  } catch {
    return null;
  }
}

function writeQwenTrust(dataDir: string, file: QwenTrustFile): void {
  writeAgentFileAtomic(qwenTrustPath(dataDir), `${JSON.stringify(file, null, 2)}\n`, 0o600);
}

/** The Qwen home this environment's `qwen` uses. */
export function qwenTrustHome(e: Pick<AgentEnvironment, "env" | "homeDir">): string {
  return qwenHome(e.env, e.homeDir, process.cwd());
}

/** The token to present to a session of the Qwen home `home`, or null (none, or minted for another home). */
export function qwenWakeToken(dataDir: string, home: string): string | null {
  const file = readQwenTrust(dataDir);
  return file?.token && file.home === home ? file.token : null;
}

/** `0.26.2` (also `0.27.0-nightly.20261020.abc`) as [major, minor, patch]; null for anything else. */
export function parseQwenVersion(text: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)?$/m.exec(text.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function qwenHasTrust(version: readonly [number, number, number] | null): boolean {
  if (!version) return false;
  const min = INBOX_QWEN_TRUST_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (version[i]! !== min[i]!) return version[i]! > min[i]!;
  return true;
}

export type QwenTrustOutcome =
  /** Minted now. */
  | { kind: "added" }
  /** There already, and Qwen still lists it. */
  | { kind: "kept" }
  /** No `qwen` on PATH, or one older than 0.24: no token, no wake. */
  | { kind: "none"; why: string }
  /** The person revoked it in Qwen; not minted again by itself. */
  | { kind: "revoked_outside" }
  /** `repeated`: the same reason as the last run's, so the terminal does not say it again. */
  | { kind: "failed"; reason: string; repeated?: boolean };

function said(text: string): string {
  return text.trim().split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 200) ?? "";
}

/** The grants Qwen lists (`--json`: one `{id,label,createdAt}` per line), or null when the list could not be read. */
async function listGrants(bin: string, e: AgentEnvironment, signal?: AbortSignal): Promise<{ id: string; label: string }[] | null> {
  const run = await e.run([bin, "sessions", "controllers", "list", "--json"], { timeoutMs: QWEN_CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) });
  if (run.timedOut || run.exitCode !== 0) return null;
  const grants: { id: string; label: string }[] = [];
  for (const line of run.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; label?: unknown };
      if (typeof value.id === "string" && typeof value.label === "string") grants.push({ id: value.id, label: value.label });
    } catch {
      return null;
    }
  }
  return grants;
}

/**
 * Make sure Plannotator holds a working token for this environment's Qwen
 * home: kept when Qwen still lists the grant, minted when there is none.
 * `force` (the person turned Qwen Code on in Settings) mints again after a
 * revoke outside. A grant labelled ours that this file does not hold (the
 * file was lost) is revoked first, so Qwen never keeps an orphan.
 */
export async function ensureQwenTrust(dataDir: string, e: AgentEnvironment, options: { force?: boolean; signal?: AbortSignal; now?: () => Date } = {}): Promise<QwenTrustOutcome> {
  const at = (options.now ?? (() => new Date()))().toISOString();
  const home = qwenTrustHome(e);
  const bin = e.which("qwen");
  if (!bin) return { kind: "none", why: "qwen is not on PATH" };
  const runOptions = { timeoutMs: QWEN_CALL_TIMEOUT_MS, ...(options.signal ? { signal: options.signal } : {}) };
  let file = readQwenTrust(dataDir);
  const earlier = file?.failed;
  // A grant for another Qwen home (QWEN_HOME changed): kept for revoking, never presented here.
  if (file && file.home !== home) {
    if (file.token) return { kind: "failed", reason: `Plannotator's trusted-sender token is in ${file.home}, not ${home}; turn Qwen Code off and on in Settings → Agents to move it` };
    file = null;
  }
  if (file?.revoked_outside_at && !options.force) return { kind: "revoked_outside" };

  const version = await e.run([bin, "--version"], runOptions);
  if (version.timedOut) return { kind: "failed", reason: "qwen --version did not finish" };
  const parsed = version.exitCode === 0 ? parseQwenVersion(version.stdout) : null;
  if (!qwenHasTrust(parsed)) {
    return { kind: "none", why: parsed ? `Qwen Code ${parsed.join(".")} has no trusted senders (0.24 or later has)` : "this qwen did not answer like Qwen Code" };
  }

  const grants = await listGrants(bin, e, options.signal);
  if (file?.id && file.token) {
    // Unreadable list: the token is kept as it is.
    if (grants === null || grants.some((grant) => grant.id === file!.id)) return { kind: "kept" };
    // The person revoked it in Qwen.
    writeQwenTrust(dataDir, { v: 1, home, revoked_outside_at: at });
    if (!options.force) return { kind: "revoked_outside" };
  }
  // A grant with our label we hold no token for (this file was lost): revoked, so the new one can take the label.
  for (const grant of grants ?? []) {
    if (grant.label.toLowerCase() !== INBOX_QWEN_TRUST_LABEL.toLowerCase() || !GRANT_ID.test(grant.id)) continue;
    await e.run([bin, "sessions", "controllers", "remove", grant.id], runOptions);
  }

  const add = await e.run([bin, "sessions", "controllers", "add", "--label", INBOX_QWEN_TRUST_LABEL, "--json"], runOptions);
  const fail = (reason: string): QwenTrustOutcome => {
    try {
      writeQwenTrust(dataDir, { v: 1, home, failed: reason });
    } catch {
      // Said again next time.
    }
    return { kind: "failed", reason, ...(earlier === reason ? { repeated: true } : {}) };
  };
  if (add.timedOut) return fail("qwen sessions controllers add did not finish");
  if (add.exitCode !== 0) return fail(`qwen sessions controllers add exited with code ${add.exitCode}${said(add.stderr) ? ` (${said(add.stderr)})` : ""}`);
  let grant: { id?: unknown; token?: unknown } | null = null;
  for (const line of add.stdout.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object") {
        grant = value as { id?: unknown; token?: unknown };
        break;
      }
    } catch {
      // Not the JSON line.
    }
  }
  if (!grant || typeof grant.id !== "string" || !GRANT_ID.test(grant.id) || typeof grant.token !== "string" || !TOKEN.test(grant.token)) {
    return fail("qwen sessions controllers add did not answer with a token");
  }
  try {
    writeQwenTrust(dataDir, { v: 1, home, id: grant.id, token: grant.token, created_at: at });
  } catch (error) {
    // Never leave a grant in Qwen that nothing holds.
    await e.run([bin, "sessions", "controllers", "remove", grant.id], runOptions);
    return { kind: "failed", reason: `the token could not be kept (${error instanceof Error ? error.message : String(error)})` };
  }
  return { kind: "added" };
}

/** What revoking would run, for uninstall's dry run and its warnings; null when Plannotator holds no grant. */
export function qwenTrustRemoval(dataDir: string, e: AgentEnvironment): { describe: string; manual: string | null; apply: () => Promise<string | null> } | null {
  const file = readQwenTrust(dataDir);
  if (!file?.id || !file.token) return null;
  const id = file.id;
  const command = `qwen sessions controllers remove ${id}`;
  const describe = `Plannotator's trusted-sender token in Qwen Code (${command})`;
  const home = qwenTrustHome(e);
  const elsewhere = file.home !== home;
  const bin = e.which("qwen");
  const manual = elsewhere ? `QWEN_HOME=${file.home} ${command}` : !bin ? command : null;
  return {
    describe,
    manual,
    apply: async () => {
      if (manual) return `run \`${manual}\``;
      const run = await e.run([bin!, "sessions", "controllers", "remove", id], { timeoutMs: QWEN_CALL_TIMEOUT_MS });
      // Gone already (the person removed it): nothing left to revoke.
      const gone = run.exitCode === 1 && /no controller has the id/i.test(`${run.stderr}\n${run.stdout}`);
      if (run.timedOut) return `${command} did not finish`;
      if (run.exitCode !== 0 && !gone) return `${command} exited with code ${run.exitCode}`;
      rmSync(qwenTrustPath(dataDir), { force: true });
      return null;
    },
  };
}

/**
 * The one switch: `on` makes sure the token is there (see ensureQwenTrust,
 * forced: the person asked), off revokes it. Returns an error reason, or null.
 */
export async function setQwenTrust(on: boolean, dataDir: string, e: AgentEnvironment): Promise<string | null> {
  if (on) {
    const outcome = await ensureQwenTrust(dataDir, e, { force: true });
    return outcome.kind === "failed" ? outcome.reason : null;
  }
  const removal = qwenTrustRemoval(dataDir, e);
  if (!removal) {
    rmSync(qwenTrustPath(dataDir), { force: true });
    return null;
  }
  return removal.apply();
}
