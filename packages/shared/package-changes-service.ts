/**
 * The review server's package changes: `GET /api/package-changes` and
 * `POST /api/package-changes/lookup`, shared by the Bun server and the Pi
 * mirror (each passes a `PackageChangesHost` built from its own diff state).
 *
 * The server works out everything a card shows and everything a lookup
 * sends. The page names a card by path; it never supplies package names.
 * The lookup answers 403 unless the reviewer turned it on (config.json
 * `packageChanges.lookup`, PLANNOTATOR_PACKAGE_LOOKUP=0 wins), and sends only
 * the names `analysis` listed for that card under `lookup.names`. The page's
 * consent button counts `lookup.total`: every name any card would send.
 *
 * Privacy: a name leaves the machine only when every registry setting that
 * could route it elsewhere was read and none does. Settings come from where
 * the package manager reads them: the working tree in a local review (so a
 * gitignored `.npmrc` counts), the PR head in a PR review, the user's own
 * files and the environment. A setting that exists but cannot be read, or a
 * platform call that fails, withholds every name.
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, parse as parsePath } from "node:path";
import type { DiffFileStatus } from "@plannotator/core/diff-files";
import {
  analyzePackageChanges,
  packageChangeReads,
  type PackageChange,
  type PackageChangeCard,
  type PackageFileSide,
} from "@plannotator/core/package-changes";
import { parsePackageLookupEnv } from "./config";
import {
  isSendable,
  lookupPackages,
  packageRouting,
  type PackageLookupRequest,
  type PackageRouting,
  type PackageRoutingFiles,
} from "./package-metadata";

/** One side of one file, as the host read it. */
export type PackageSideRead =
  | { kind: "ok"; text: string }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

/** Where the review's package-manager settings live. */
export type PackageSettingsSource =
  /** A working tree on this machine: `dirOf` maps a diff path to the absolute directory that holds it (null: unknown). */
  | { kind: "local"; dirOf(path: string): Promise<string | null> }
  /** No working tree (a PR review): settings are read at the new side of the review, through `readSide`. */
  | { kind: "remote" }
  /** Nothing to read them from: nothing is sent. */
  | { kind: "none" };

export interface PackageChangesHost {
  /** The opaque id of the diff the server serves now. */
  snapshotId(): string;
  /** The files in the current diff. */
  diffFiles(): { path: string; oldPath?: string; status: DiffFileStatus }[];
  /** One side of a path at the current diff. A throw counts as unreadable. */
  readSide(side: "old" | "new", path: string, oldPath: string | undefined, base: string | undefined): Promise<PackageSideRead>;
  settings(): PackageSettingsSource;
  /** The user's home directory, or null. */
  homeDir(): string | null;
  /** Reads a settings file on this machine (tests stub it). */
  readLocalFile?(absolutePath: string): PackageSideRead;
  /** Whether the reviewer allowed npm lookups (config and env resolved). */
  lookupEnabled(): boolean;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** What a card's lookup would send. */
export interface PackageCardLookup {
  names: string[];
  /** Registry names kept here (a private scope or host, or every name when a setting says so or could not be read). */
  withheld: string[];
}

export type PackageChangesCardResponse = PackageChangeCard & { lookup: PackageCardLookup };

export interface PackageChangesResponse {
  snapshot: string;
  cards: PackageChangesCardResponse[];
  /** Every name a lookup across all cards would send: the consent button's count. */
  lookup: { total: number };
}

/** The largest manifest or lockfile side read (the core refuses more anyway). */
export const MAX_PACKAGE_FILE_BYTES = 32 * 1024 * 1024;
const SETTINGS_MAX_BYTES = 1024 * 1024;
const READ_CONCURRENCY = 4;

type SettingsKind = keyof Omit<PackageRoutingFiles, "unreadable">;

/** Files read in every directory a package manager would look in, by kind. */
function settingsNames(env: Record<string, string | undefined>): [string, SettingsKind][] {
  const names: [string, SettingsKind][] = [
    [".npmrc", "npmrc"],
    [".yarnrc.yml", "yarnrc"],
    [".yarnrc", "yarnrcClassic"],
    ["bunfig.toml", "bunfig"],
  ];
  const custom = envValue(env, "YARN_RC_FILENAME");
  if (custom && !custom.includes("/") && !custom.includes("\\") && custom !== ".yarnrc.yml") names.push([custom, "yarnrc"]);
  return names;
}

/** An environment value by name, case-insensitively (npm reads its keys that way). */
function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(env)) if (k.toLowerCase() === lower && v) return v;
  return undefined;
}

/** The settings files outside the project: user, global, and the Yarn and Bun equivalents. */
function userSettingsFiles(env: Record<string, string | undefined>, home: string | null): [string, SettingsKind][] {
  const out: [string, SettingsKind][] = [];
  const userconfig = envValue(env, "npm_config_userconfig");
  if (userconfig) out.push([userconfig, "npmrc"]);
  else if (home) out.push([join(home, ".npmrc"), "npmrc"]);

  const globalconfig = envValue(env, "npm_config_globalconfig");
  if (globalconfig) out.push([globalconfig, "npmrc"]);
  else {
    // npm's global file is `$PREFIX/etc/npmrc`; the prefix follows the node
    // install (`<prefix>/bin/node`, or `<prefix>/node.exe` on Windows). Every
    // likely prefix is read: one too many only withholds more.
    const prefixes = new Set<string>(["/", "/usr", "/usr/local", "/opt/homebrew"]);
    const prefix = envValue(env, "npm_config_prefix");
    if (prefix) prefixes.add(prefix);
    for (const dir of (envValue(env, "PATH") ?? "").split(process.platform === "win32" ? ";" : ":")) {
      if (!dir) continue;
      const hasNode = ["node", "node.exe"].some((n) => {
        try { return statSync(join(dir, n)).isFile(); } catch { return false; }
      });
      if (!hasNode) continue;
      prefixes.add(dir);
      prefixes.add(dirname(dir));
    }
    for (const p of prefixes) out.push([join(p, "etc", "npmrc"), "npmrc"]);
  }

  if (home) {
    out.push([join(home, ".yarnrc.yml"), "yarnrc"], [join(home, ".yarnrc"), "yarnrcClassic"], [join(home, ".bunfig.toml"), "bunfig"]);
    const custom = envValue(env, "YARN_RC_FILENAME");
    if (custom && !custom.includes("/") && !custom.includes("\\")) out.push([join(home, custom), "yarnrc"]);
  }
  const xdg = envValue(env, "XDG_CONFIG_HOME") ?? (home ? join(home, ".config") : null);
  if (xdg) out.push([join(xdg, ".bunfig.toml"), "bunfig"]);
  return out;
}

/** A settings file on this machine: missing only when it does not exist; anything odd is unreadable. */
export function readLocalSettingsFile(path: string): PackageSideRead {
  try {
    const st = statSync(path);
    if (!st.isFile()) return { kind: "unreadable", reason: "not a file" };
    if (st.size > SETTINGS_MAX_BYTES) return { kind: "unreadable", reason: "too large" };
    return { kind: "ok", text: readFileSync(path, "utf-8") };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", reason: code ?? "unreadable" };
  }
}

function repoAncestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const out = [""];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function absoluteAncestors(dir: string): string[] {
  const out: string[] = [];
  const { root } = parsePath(dir);
  let cur = dir;
  for (;;) {
    out.push(cur);
    if (cur === root) break;
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return out;
}

async function pool<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function lookupVersion(change: PackageChange): string | null {
  return change.afterVersion ?? change.beforeVersion;
}

function cardRequests(card: PackageChangesCardResponse): PackageLookupRequest[] {
  const names = new Set(card.lookup.names);
  const seen = new Set<string>();
  const out: PackageLookupRequest[] = [];
  for (const change of card.changes) {
    if (!change.registryName || !names.has(change.registryName)) continue;
    const version = lookupVersion(change);
    const key = `${change.registryName}@${version ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: change.registryName, version });
  }
  return out;
}

/** A name a lookup may ask about at all: a registry spec, from npm's registry. */
function lookupCandidate(change: PackageChange): string | null {
  if (!change.registryName || (change.source !== "registry" && change.source !== "alias")) return null;
  return change.registryName;
}

export function createPackageChangesService(host: PackageChangesHost) {
  const cache = new Map<string, Promise<PackageChangesResponse>>();
  const readLocal = host.readLocalFile ?? readLocalSettingsFile;

  const readSide = async (side: "old" | "new", path: string, oldPath: string | undefined, base: string | undefined): Promise<PackageSideRead> => {
    try {
      return await host.readSide(side, path, oldPath, base);
    } catch {
      return { kind: "unreadable", reason: "could not be read" };
    }
  };

  /**
   * Both sides of the diff's package files. A side the diff says exists but
   * that comes back missing is unreadable, never absent: a 6 MB lockfile
   * must not read as every package removed.
   */
  const readPackageFiles = async (base: string | undefined) => {
    const diff = new Map(host.diffFiles().map((f) => [f.path, f]));
    const reads = packageChangeReads([...diff.keys()]);
    const side = (read: PackageSideRead, expected: boolean): PackageFileSide => {
      if (read.kind === "ok") return read.text;
      if (read.kind === "unreadable") return { unreadable: read.reason };
      return expected ? { unreadable: "could not be read" } : null;
    };
    return pool(reads, READ_CONCURRENCY, async ({ path, inDiff }) => {
      const entry = diff.get(path);
      if (inDiff && entry) {
        const [oldSide, newSide] = await Promise.all([
          entry.status === "added" ? null : readSide("old", path, entry.oldPath, base).then((r) => side(r, true)),
          entry.status === "deleted" ? null : readSide("new", path, undefined, base).then((r) => side(r, true)),
        ]);
        return { path, inDiff, old: oldSide, new: newSide };
      }
      // A manifest the diff leaves unchanged reads the same on both sides.
      const now = side(await readSide("new", path, undefined, base), false);
      return { path, inDiff, old: now, new: now };
    });
  };

  /** Every registry setting that applies to these cards. Fails closed. */
  const readRouting = async (cards: PackageChangeCard[], base: string | undefined): Promise<PackageRouting> => {
    const files: { npmrc: string[]; yarnrc: string[]; yarnrcClassic: string[]; bunfig: string[]; unreadable: boolean } = {
      npmrc: [], yarnrc: [], yarnrcClassic: [], bunfig: [], unreadable: false,
    };
    const take = (read: PackageSideRead, kind: SettingsKind) => {
      if (read.kind === "ok") files[kind].push(read.text);
      else if (read.kind === "unreadable") files.unreadable = true;
    };
    const names = settingsNames(host.env);
    const anchors = new Set<string>();
    for (const card of cards) {
      anchors.add(card.path);
      if (card.lockfile) anchors.add(card.lockfile);
    }

    const source = host.settings();
    if (source.kind === "none") {
      files.unreadable = true;
    } else if (source.kind === "local") {
      // Every directory from the package up to the filesystem root: Yarn
      // reads all of them, npm and Bun a subset. One too many only withholds more.
      const dirs = new Set<string>();
      for (const anchor of anchors) {
        const dir = await source.dirOf(anchor).catch(() => null);
        if (!dir) {
          files.unreadable = true;
          continue;
        }
        for (const d of absoluteAncestors(dir)) dirs.add(d);
      }
      for (const dir of dirs) for (const [name, kind] of names) take(readLocal(join(dir, name)), kind);
    } else {
      const dirs = new Set<string>();
      for (const anchor of anchors) for (const d of repoAncestors(anchor)) dirs.add(d);
      const paths = [...dirs].flatMap((dir) => names.map(([name, kind]) => [dir ? `${dir}/${name}` : name, kind] as const));
      const reads = await pool(paths, READ_CONCURRENCY, ([path]) => readSide("new", path, undefined, base));
      reads.forEach((read, i) => take(read, paths[i][1]));
    }

    for (const [path, kind] of userSettingsFiles(host.env, host.homeDir())) take(readLocal(path), kind);
    return packageRouting(files, host.env);
  };

  const compute = async (base: string | undefined): Promise<PackageChangesResponse> => {
    const snapshot = host.snapshotId();
    const cards = analyzePackageChanges(await readPackageFiles(base));

    // Settings are read only while a lookup can happen at all, and only for
    // cards that have a name to send.
    const candidates = cards.filter((c) => c.changes.some((ch) => lookupCandidate(ch)));
    const routing = candidates.length > 0 && parsePackageLookupEnv(host.env) !== false
      ? await readRouting(candidates, base)
      : null;

    // A name any card withholds (a lockfile fetches it from another host) is withheld on every card.
    const withheld = new Set<string>();
    for (const card of cards) {
      for (const change of card.changes) {
        const name = lookupCandidate(change);
        if (name && (routing === null || change.privateSource || !isSendable(name, routing))) withheld.add(name);
      }
    }
    const all = new Set<string>();
    const out = cards.map((card) => {
      const names = new Set<string>();
      const kept = new Set<string>();
      for (const change of card.changes) {
        // Only a spec that names a registry version: a bare tag or `*` may
        // be a workspace package when no lockfile says otherwise.
        const name = lookupCandidate(change);
        if (!name) continue;
        (withheld.has(name) ? kept : names).add(name);
      }
      for (const n of names) all.add(n);
      return { ...card, lookup: { names: [...names].sort(), withheld: [...kept].sort() } };
    });
    return { snapshot, cards: out, lookup: { total: all.size } };
  };

  const analysis = (base: string | undefined): Promise<PackageChangesResponse> => {
    const key = `${host.snapshotId()}\u0000${base ?? ""}`;
    let hit = cache.get(key);
    if (!hit) {
      hit = compute(base);
      cache.set(key, hit);
      hit.catch(() => cache.delete(key));
      // A handful of views per session: keep the last few.
      while (cache.size > 4) cache.delete(cache.keys().next().value!);
    }
    return hit;
  };

  return {
    /** `GET /api/package-changes?snapshot=&base=` */
    async get(params: { snapshot: string | null; base: string | undefined }): Promise<{ status: number; body: unknown }> {
      if (params.snapshot && params.snapshot !== host.snapshotId()) {
        return { status: 409, body: { error: "Diff snapshot is stale" } };
      }
      return { status: 200, body: await analysis(params.base) };
    },

    /** `POST /api/package-changes/lookup { snapshot, base, path }` */
    async lookup(body: unknown): Promise<{ status: number; body: unknown }> {
      if (!host.lookupEnabled()) return { status: 403, body: { error: "lookup_off" } };
      const b = (body ?? {}) as { snapshot?: unknown; base?: unknown; path?: unknown };
      if (typeof b.path !== "string" || !b.path) return { status: 400, body: { error: "Missing path" } };
      if (typeof b.snapshot === "string" && b.snapshot && b.snapshot !== host.snapshotId()) {
        return { status: 409, body: { error: "Diff snapshot is stale" } };
      }
      const base = typeof b.base === "string" && b.base ? b.base : undefined;
      const result = await analysis(base);
      const card = result.cards.find((c) => c.path === b.path);
      if (!card) return { status: 404, body: { error: "No package changes for that path" } };
      const requests = cardRequests(card);
      if (requests.length === 0) return { status: 200, body: { packages: [], offline: false } };
      return { status: 200, body: await lookupPackages(requests, { fetchImpl: host.fetchImpl, env: host.env }) };
    },
  };
}

export type PackageChangesService = ReturnType<typeof createPackageChangesService>;
