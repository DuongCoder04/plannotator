/**
 * Safe updates, step 1 (owner-approved, .product/approved/safe-updates-step1/).
 *
 * Why: the update wrapper used to download install.sh with the system `curl`,
 * and on macOS that curl still trusts the root certificates whose keys leaked
 * in the eMudhra incident, so anyone holding them could serve a different
 * install script or binary. This module is the part the running Plannotator
 * does with its OWN fetch (Bun 1.4.4 blocks those keys) before anything runs:
 *
 *   1. download the install script (https://plannotator.ai/install.sh, or the
 *      PLANNOTATOR_INSTALL_SCRIPT_URL test/mirror knob) and the `.sha256` of
 *      the binary install.sh will pick on this machine (required), plus the
 *      other CPU type's when it can be read (optional);
 *   2. write the script and `expected-sha256` into a private temp dir (0700,
 *      files 0600) and print that dir.
 *
 * The POSIX update wrapper (auto-update.ts) runs it as `plannotator
 * update-prepare <version>`, then runs the saved script with
 * PLANNOTATOR_EXPECTED_SHA256, which install.sh compares its own download
 * against before it replaces anything (exit UPDATE_CHECKSUM_MISMATCH on a
 * mismatch, the old binary kept). Any failure here means nothing runs and nothing changes: exit
 * UPDATE_PREPARE_FAILED, an `update:` line on stderr (update.log), and a
 * later retry. There is never a fallback to downloading the script with curl.
 *
 * Windows is unchanged: Windows blocks the leaked keys in its own store, which
 * the PowerShell wrapper's Invoke-WebRequest uses.
 */

import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedOverrideUrl } from "@plannotator/shared/update-check";
import { AUTO_UPDATE_LOCK_STALE_MS, UPDATE_PREPARE_FAILED, installScriptUrl } from "./auto-update";

export { UPDATE_CHECKSUM_MISMATCH, UPDATE_PREPARE_FAILED } from "./auto-update";

export const UPDATE_DIR_PREFIX = "plannotator-update-";
export const UPDATE_PREPARE_TIMEOUT_MS = 30_000;
/** A script larger than this is not ours (install.sh is about 125 KB). */
const MAX_SCRIPT_BYTES = 4 * 1024 * 1024;
/** Present in every install.sh: a page that lacks it (a proxy's error page) is never run. */
const SCRIPT_MARKER = 'REPO="backnotprop/plannotator"';
const DEFAULT_RELEASE_DOWNLOAD_URL = "https://github.com/backnotprop/plannotator/releases/download";

/** "0.28.33", "v0.28.33" -> "v0.28.33"; anything else (a pre-release, junk) -> null. */
export function normalizeReleaseTag(version: string): string | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return m ? `v${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

/** The binaries this OS's install script may download: it picks the CPU type itself. */
export function candidateAssets(platform: NodeJS.Platform): string[] {
  const os = platform === "darwin" ? "darwin" : "linux";
  return [`plannotator-${os}-arm64`, `plannotator-${os}-x64`];
}

/**
 * The binary install.sh will pick on this machine. It reads `uname -m` with
 * no Rosetta detection, and a child of this process sees the same CPU type
 * this process runs as (an x64 build under Rosetta: x86_64), so it is
 * `process.arch`. Null for a CPU type install.sh does not ship.
 */
export function nativeAsset(platform: NodeJS.Platform, arch: string): string | null {
  if (arch !== "arm64" && arch !== "x64") return null;
  return `plannotator-${platform === "darwin" ? "darwin" : "linux"}-${arch}`;
}

/** Where release assets download from: PLANNOTATOR_RELEASE_DOWNLOAD_URL (`https:` or loopback `http:`), else GitHub. */
export function releaseDownloadUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.PLANNOTATOR_RELEASE_DOWNLOAD_URL?.trim().replace(/\/+$/, "");
  return raw && isAllowedOverrideUrl(raw) ? raw : DEFAULT_RELEASE_DOWNLOAD_URL;
}

export type PrepareResult =
  /** `notes`: the other CPU type's checksum, when it could not be read (optional; never a failure). */
  | { ok: true; dir: string; expected: string; scriptChecksPin: boolean; notes: string[] }
  | { ok: false; error: string };

export interface PrepareDeps {
  version: string;
  platform: NodeJS.Platform;
  /** This process's CPU type (default `process.arch`): its checksum is required, the other one's is not. */
  arch?: string;
  env?: NodeJS.ProcessEnv;
  tmpRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

async function fetchText(url: string, f: typeof fetch, timeoutMs: number): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  try {
    const res = await f(url, {
      redirect: "follow",
      headers: { "user-agent": "plannotator-update" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Bun 1.3.14 hands back a refusing proxy's 502 as a response, 1.4.4 throws; both end here.
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${host}` };
    return { ok: true, text: await res.text() };
  } catch (err) {
    return { ok: false, error: `${host}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}` };
  }
}

/**
 * Download and stage. Never throws; on any failure nothing is left on disk.
 */
export async function prepareUpdate(deps: PrepareDeps): Promise<PrepareResult> {
  const env = deps.env ?? process.env;
  const f = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? UPDATE_PREPARE_TIMEOUT_MS;
  const tag = normalizeReleaseTag(deps.version);
  if (!tag) return { ok: false, error: `not a release version: ${deps.version}` };
  if (deps.platform === "win32") return { ok: false, error: "Windows updates do not use this step" };

  const native = nativeAsset(deps.platform, deps.arch ?? process.arch);
  if (!native) return { ok: false, error: `no Plannotator build for this CPU type (${deps.arch ?? process.arch})` };
  // The native first: it is required. The other CPU type's checksum is only
  // pinned when it can be read, so a release that stops shipping one CPU type
  // never stops updates for the other.
  const assets = [native, ...candidateAssets(deps.platform).filter((a) => a !== native)];
  const base = releaseDownloadUrl(env);
  const [script, ...sums] = await Promise.all([
    fetchText(installScriptUrl(deps.platform, env), f, timeoutMs),
    ...assets.map((a) => fetchText(`${base}/${tag}/${a}.sha256`, f, timeoutMs)),
  ]);
  if (!script!.ok) return { ok: false, error: `install script: ${script!.error}` };
  const body = script!.text;
  if (!body.startsWith("#!") || !body.includes(SCRIPT_MARKER) || body.length > MAX_SCRIPT_BYTES) {
    return { ok: false, error: "install script: the download is not Plannotator's install script" };
  }
  const pairs: string[] = [];
  const notes: string[] = [];
  for (let i = 0; i < assets.length; i++) {
    const r = sums[i]!;
    const m = r.ok ? /^([0-9a-fA-F]{64})(?:\s|$)/.exec(r.text) : null;
    if (m) {
      pairs.push(`${assets[i]}=${m[1]!.toLowerCase()}`);
      continue;
    }
    const reason = `${assets[i]}.sha256: ${r.ok ? "not a SHA-256 checksum" : r.error}`;
    if (assets[i] === native) return { ok: false, error: reason };
    notes.push(`${reason} (not this machine's CPU type; skipped)`);
  }

  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(deps.tmpRoot ?? tmpdir(), UPDATE_DIR_PREFIX));
    chmodSync(dir, 0o700);
    writeFileSync(join(dir, "install.sh"), body, { mode: 0o600 });
    writeFileSync(join(dir, "expected-sha256"), pairs.join(" "), { mode: 0o600 });
    return { ok: true, dir, expected: pairs.join(" "), scriptChecksPin: body.includes("PLANNOTATOR_EXPECTED_SHA256"), notes };
  } catch (err) {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return { ok: false, error: `could not stage the update: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * The dirs a wrapper killed outright (SIGKILL, a power cut) left behind:
 * removed at the start of the next update once older than the lock's own
 * stale age, so a live run's dir is never touched.
 */
export function sweepStaleUpdateDirs(tmpRoot: string = tmpdir(), now: number = Date.now(), maxAgeMs: number = AUTO_UPDATE_LOCK_STALE_MS): number {
  let removed = 0;
  let names: string[] = [];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(UPDATE_DIR_PREFIX)) continue;
    const path = join(tmpRoot, name);
    try {
      if (now - statSync(path).mtimeMs >= maxAgeMs) {
        rmSync(path, { recursive: true, force: true });
        removed++;
      }
    } catch {}
  }
  return removed;
}

export interface UpdatePrepareCommandDeps extends Omit<PrepareDeps, "version"> {
  out?: (text: string) => void;
  err?: (text: string) => void;
  now?: () => number;
}

/**
 * `plannotator update-prepare <version>` (internal; the POSIX update wrapper
 * runs it). Prints the staged dir on stdout, and nothing else; reasons go to
 * stderr. Exit 0, or UPDATE_PREPARE_FAILED.
 */
export async function runUpdatePrepareCommand(args: string[], deps: UpdatePrepareCommandDeps): Promise<number> {
  const out = deps.out ?? ((t: string) => process.stdout.write(t));
  const err = deps.err ?? ((t: string) => process.stderr.write(t));
  const version = args[0];
  if (!version || args.length !== 1) {
    err("update: usage: plannotator update-prepare <version>\n");
    return UPDATE_PREPARE_FAILED;
  }
  sweepStaleUpdateDirs(deps.tmpRoot ?? tmpdir(), (deps.now ?? Date.now)());
  const result = await prepareUpdate({ ...deps, version });
  if (!result.ok) {
    err(`update: could not download the update (${result.error}); nothing was changed\n`);
    return UPDATE_PREPARE_FAILED;
  }
  for (const note of result.notes) err(`update: ${note}\n`);
  if (!result.scriptChecksPin) {
    err("update: this install script does not check the pinned checksum yet; it runs as before\n");
  }
  out(`${result.dir}\n`);
  return 0;
}

