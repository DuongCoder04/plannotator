/**
 * npm metadata for the review's package cards: weekly downloads, license,
 * release date, deprecation. Runtime-agnostic (fetch only).
 *
 * Nothing here runs until the reviewer turned the lookup on, and the names it
 * is given were already filtered by `packageRouting` (see
 * package-changes-service.ts): a name under a private scope, or any name when
 * the default registry is not npm's, never reaches `lookupPackages`.
 *
 * Sources (measured 2026-10-26):
 *  - license, publish time, latest, deprecated: the full packument,
 *    `GET <registry>/<name>` (the only npm document with per-version `time`;
 *    100 KB to 2 MB gzipped for popular packages).
 *  - weekly downloads: `GET <downloads>/downloads/point/last-week/<a,b,c>`
 *    (bulk for unscoped names; npm refuses scoped names in bulk).
 */
import type { PackageMetadata } from "@plannotator/core/package-changes";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export const NPM_API = "https://api.npmjs.org";
const PACKUMENT_CONCURRENCY = 4;
const TIMEOUT_MS = 8000;
const CACHE_MS = 60 * 60 * 1000;

export interface PackageLookupRequest { name: string; version: string | null }

export interface PackageRouting {
  /** The default registry is not npm's: nothing may be sent. */
  privateDefault: boolean;
  /** Scopes (`@acme`) configured for another registry, or configured at all in Yarn or Bun. */
  privateScopes: Set<string>;
}

const PUBLIC_REGISTRY_HOSTS = new Set(["registry.npmjs.org", "registry.yarnpkg.com"]);

function isPublicRegistry(url: string): boolean {
  try {
    return PUBLIC_REGISTRY_HOSTS.has(new URL(url.trim().replace(/^["']|["']$/g, "")).hostname);
  } catch {
    return false;
  }
}

function scopeOf(raw: string): string | null {
  const s = raw.trim().replace(/^["']|["']$/g, "");
  if (!s) return null;
  return s.startsWith("@") ? s : `@${s}`;
}

/** The registry settings package managers read, as text: `.npmrc`, `.yarnrc.yml`, `bunfig.toml`. */
export interface PackageRoutingFiles {
  npmrc: readonly string[];
  yarnrc: readonly string[];
  bunfig: readonly string[];
}

/**
 * Which names may be sent to npm. Errs toward withholding: a scope that Yarn
 * or Bun configures at all counts as private, and so does every scope when
 * the default registry is not npm's.
 */
export function packageRouting(files: PackageRoutingFiles, env: Record<string, string | undefined> = {}): PackageRouting {
  const routing: PackageRouting = { privateDefault: false, privateScopes: new Set() };
  for (const key of ["npm_config_registry", "NPM_CONFIG_REGISTRY", "YARN_NPM_REGISTRY_SERVER", "BUN_CONFIG_REGISTRY"]) {
    const v = env[key];
    if (v && !isPublicRegistry(v)) routing.privateDefault = true;
  }
  for (const text of files.npmrc) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith(";")) continue;
      const m = /^(@[^:=\s]+:)?registry\s*=\s*(.+)$/.exec(line);
      if (!m || isPublicRegistry(m[2])) continue;
      if (m[1]) routing.privateScopes.add(m[1].slice(0, -1));
      else routing.privateDefault = true;
    }
  }
  for (const text of files.yarnrc) {
    let inScopes = false;
    for (const raw of text.split(/\r?\n/)) {
      if (!raw.trim() || raw.trim().startsWith("#")) continue;
      const indent = raw.length - raw.trimStart().length;
      const line = raw.trim();
      if (indent === 0) {
        inScopes = /^npmScopes:/.test(line);
        const m = /^npmRegistryServer:\s*(.+)$/.exec(line);
        if (m && !isPublicRegistry(m[1])) routing.privateDefault = true;
        continue;
      }
      if (inScopes && indent === 2 && line.endsWith(":")) {
        const scope = scopeOf(line.slice(0, -1));
        if (scope) routing.privateScopes.add(scope);
      }
    }
  }
  for (const text of files.bunfig) {
    let table = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const header = /^\[([^\]]+)\]$/.exec(line);
      if (header) {
        table = header[1].trim();
        continue;
      }
      if (table === "install") {
        const m = /^registry\s*=\s*(.+)$/.exec(line);
        if (m) {
          const url = /url\s*=\s*"([^"]+)"/.exec(m[1])?.[1] ?? m[1];
          if (!isPublicRegistry(url)) routing.privateDefault = true;
        }
      } else if (table === "install.scopes") {
        const m = /^("?[^"=\s]+"?)\s*=/.exec(line);
        const scope = m && scopeOf(m[1]);
        if (scope) routing.privateScopes.add(scope);
      }
    }
  }
  return routing;
}

/** True when the name may be sent to npm under this routing. */
export function isSendable(name: string, routing: PackageRouting): boolean {
  if (routing.privateDefault) return false;
  if (name.startsWith("@")) return !routing.privateScopes.has(name.split("/")[0]);
  return true;
}

/** Test and mirror knob: https, or http on loopback. */
function baseUrl(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  try {
    const u = new URL(value);
    const loopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
    if (u.protocol === "https:" || (u.protocol === "http:" && loopback)) return value.replace(/\/+$/, "");
  } catch {}
  return fallback;
}

interface PackumentSummary { license: string | null; times: Record<string, string>; latest: string | null; deprecated: Record<string, string> }
const packumentCache = new Map<string, { at: number; value: PackumentSummary | "not-found" }>();
const downloadsCache = new Map<string, { at: number; value: number | null }>();

/** Test hook: forget every cached answer. */
export function clearPackageMetadataCache(): void {
  packumentCache.clear();
  downloadsCache.clear();
}

class LookupError extends Error {
  constructor(readonly offline: boolean, message: string) { super(message); }
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<unknown | "not-found"> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { accept: "application/json", "user-agent": "plannotator-review" },
    });
  } catch (err) {
    throw new LookupError(true, err instanceof Error && err.name === "TimeoutError" ? "timed out" : "offline");
  }
  if (res.status === 404) return "not-found";
  if (res.status === 429) throw new LookupError(false, "rate limited");
  if (!res.ok) throw new LookupError(false, `npm ${res.status}`);
  return res.json();
}

function licenseOf(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string") return (v as { type: string }).type;
  return null;
}

async function packument(fetchImpl: typeof fetch, registry: string, name: string): Promise<PackumentSummary | "not-found"> {
  const key = `${registry} ${name}`;
  const hit = packumentCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const data = await getJson(fetchImpl, `${registry}/${name.replace("/", "%2F")}`);
  let value: PackumentSummary | "not-found" = "not-found";
  if (data !== "not-found" && data && typeof data === "object") {
    const d = data as Record<string, unknown>;
    const versions = (d.versions && typeof d.versions === "object" ? d.versions : {}) as Record<string, Record<string, unknown>>;
    const deprecated: Record<string, string> = {};
    for (const [v, m] of Object.entries(versions)) if (typeof m?.deprecated === "string" && m.deprecated) deprecated[v] = m.deprecated;
    const tags = (d["dist-tags"] ?? {}) as Record<string, unknown>;
    const latest = typeof tags.latest === "string" ? tags.latest : null;
    value = {
      license: licenseOf(d.license) ?? (latest ? licenseOf(versions[latest]?.license) : null),
      times: (d.time && typeof d.time === "object" ? d.time : {}) as Record<string, string>,
      latest,
      deprecated,
    };
  }
  packumentCache.set(key, { at: Date.now(), value });
  return value;
}

async function weeklyDownloads(fetchImpl: typeof fetch, api: string, names: string[]): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  const todo = names.filter((n) => {
    const hit = downloadsCache.get(`${api} ${n}`);
    if (hit && Date.now() - hit.at < CACHE_MS) { out.set(n, hit.value); return false; }
    return true;
  });
  const unscoped = todo.filter((n) => !n.startsWith("@"));
  const scoped = todo.filter((n) => n.startsWith("@"));
  const record = (n: string, v: number | null) => { out.set(n, v); downloadsCache.set(`${api} ${n}`, { at: Date.now(), value: v }); };
  const jobs: Promise<void>[] = [];
  for (let i = 0; i < unscoped.length; i += 100) {
    const batch = unscoped.slice(i, i + 100);
    jobs.push(getJson(fetchImpl, `${api}/downloads/point/last-week/${batch.join(",")}`).then((data) => {
      // A single name answers its own object, several a map of them.
      const map = data === "not-found" ? {} : batch.length === 1 ? { [batch[0]]: data } : (data as Record<string, unknown>);
      for (const n of batch) {
        const d = map[n] as { downloads?: unknown } | null | undefined;
        record(n, typeof d?.downloads === "number" ? d.downloads : null);
      }
    }));
  }
  for (const n of scoped) {
    jobs.push(getJson(fetchImpl, `${api}/downloads/point/last-week/${n}`).then((d) => {
      record(n, d !== "not-found" && typeof (d as { downloads?: unknown })?.downloads === "number" ? (d as { downloads: number }).downloads : null);
    }));
  }
  await Promise.all(jobs);
  return out;
}

export interface PackageLookupResult {
  packages: PackageMetadata[];
  /** Set when some lookups failed: a word or two (`offline`, `rate limited`). */
  failure?: string;
  offline: boolean;
}

/** Looks up exactly the given names: the caller has already filtered them. */
export async function lookupPackages(
  requests: readonly PackageLookupRequest[],
  deps: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<PackageLookupResult> {
  const env = deps.env ?? {};
  const fetchImpl = deps.fetchImpl ?? fetch;
  const registry = baseUrl(env.PLANNOTATOR_PACKAGE_REGISTRY_URL, NPM_REGISTRY);
  const api = baseUrl(env.PLANNOTATOR_PACKAGE_DOWNLOADS_URL, NPM_API);
  const results: PackageMetadata[] = requests.map((r) => ({ name: r.name, version: r.version, status: "ok" }));
  let offline = false;
  let failure: string | undefined;
  const fail = (err: unknown) => {
    const e = err instanceof LookupError ? err : new LookupError(false, "failed");
    if (e.offline) offline = true;
    failure ??= e.message;
  };

  const names = [...new Set(results.map((r) => r.name))];
  const downloadsJob = weeklyDownloads(fetchImpl, api, names).catch((err) => { fail(err); return new Map<string, number | null>(); });
  let next = 0;
  const worker = async () => {
    while (next < results.length) {
      const r = results[next++];
      try {
        const p = await packument(fetchImpl, registry, r.name);
        if (p === "not-found") { r.status = "not-found"; continue; }
        const v = r.version && p.times[r.version] ? r.version : null;
        Object.assign(r, {
          license: p.license,
          latest: p.latest,
          publishedAt: v ? p.times[v] : null,
          deprecated: v ? p.deprecated[v] ?? null : null,
        });
      } catch (err) {
        r.status = "error";
        fail(err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PACKUMENT_CONCURRENCY, results.length) }, worker));
  const downloads = await downloadsJob;
  for (const r of results) {
    if (r.status === "ok") r.weeklyDownloads = downloads.get(r.name) ?? null;
  }
  return { packages: results, offline, ...(failure ? { failure } : {}) };
}
