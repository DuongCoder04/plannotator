/**
 * The review server's package changes: `GET /api/package-changes` and
 * `POST /api/package-changes/lookup`, shared by the Bun server and the Pi
 * mirror (each passes a `PackageChangesHost` built from its own diff state).
 *
 * The server works out everything a card shows and everything a lookup
 * sends. The page names a card by path; it never supplies package names.
 * The lookup answers 403 unless the reviewer turned it on (config.json
 * `packageChanges.lookup`, PLANNOTATOR_PACKAGE_LOOKUP=0 wins), and sends only
 * the names `analysis` listed for that card under `lookup.names`, the same
 * list the page counts in its consent line.
 */
import {
  analyzePackageChanges,
  packageChangeReads,
  type PackageChange,
  type PackageChangeCard,
} from "@plannotator/core/package-changes";
import {
  isSendable,
  lookupPackages,
  packageRouting,
  type PackageLookupRequest,
  type PackageRouting,
} from "./package-metadata";

export interface PackageChangesHost {
  /** The opaque id of the diff the server serves now. */
  snapshotId(): string;
  /** Paths of the files in the current diff (new paths). */
  diffPaths(): string[];
  /** Both sides of a path for the current diff, or null when the server has no access. */
  readFile(path: string, base: string | undefined): Promise<{ oldContent: string | null; newContent: string | null } | null>;
  /** `~/.npmrc` as text, or null. */
  readHomeNpmrc(): string | null;
  /** Whether the reviewer allowed npm lookups (config and env resolved). */
  lookupEnabled(): boolean;
  env: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
}

/** What a card's lookup would send: the page counts these in its consent line. */
export interface PackageCardLookup {
  names: string[];
  /** Registry names kept here (a private scope, or a private default registry). */
  withheld: string[];
}

export type PackageChangesCardResponse = PackageChangeCard & { lookup: PackageCardLookup };

export interface PackageChangesResponse {
  snapshot: string;
  cards: PackageChangesCardResponse[];
}

const ROUTING_FILES = { npmrc: ".npmrc", yarnrc: ".yarnrc.yml", bunfig: "bunfig.toml" } as const;

function ancestors(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  const out = [""];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

function lookupVersion(change: PackageChange): string | null {
  return change.afterVersion ?? change.beforeVersion;
}

function cardRequests(card: PackageChangeCard, names: Set<string>): PackageLookupRequest[] {
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

export function createPackageChangesService(host: PackageChangesHost) {
  const cache = new Map<string, Promise<PackageChangesResponse>>();

  const compute = async (base: string | undefined): Promise<PackageChangesResponse> => {
    const snapshot = host.snapshotId();
    const reads = packageChangeReads(host.diffPaths());
    const files = await Promise.all(reads.map(async ({ path, inDiff }) => {
      const contents = await host.readFile(path, base).catch(() => null);
      return { path, inDiff, old: contents?.oldContent ?? null, new: contents?.newContent ?? null };
    }));
    const cards = analyzePackageChanges(files);

    // Registry settings from every directory between a card and the repository root.
    const dirs = new Set<string>();
    for (const card of cards) for (const dir of ancestors(card.path)) dirs.add(dir);
    const routingText = { npmrc: [] as string[], yarnrc: [] as string[], bunfig: [] as string[] };
    await Promise.all([...dirs].flatMap((dir) => (Object.keys(ROUTING_FILES) as (keyof typeof ROUTING_FILES)[]).map(async (kind) => {
      const path = dir ? `${dir}/${ROUTING_FILES[kind]}` : ROUTING_FILES[kind];
      const contents = await host.readFile(path, base).catch(() => null);
      if (contents?.newContent) routingText[kind].push(contents.newContent);
    })));
    const home = host.readHomeNpmrc();
    if (home) routingText.npmrc.push(home);
    const routing: PackageRouting = packageRouting(routingText, host.env);

    return {
      snapshot,
      cards: cards.map((card) => {
        const names = new Set<string>();
        const withheld = new Set<string>();
        for (const change of card.changes) {
          // Only a spec that names a registry version: a bare tag or `*` may
          // be a workspace package when no lockfile says otherwise.
          if (!change.registryName || (change.source !== "registry" && change.source !== "alias")) continue;
          (isSendable(change.registryName, routing) ? names : withheld).add(change.registryName);
        }
        return { ...card, lookup: { names: [...names].sort(), withheld: [...withheld].sort() } };
      }),
    };
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
      const requests = cardRequests(card, new Set(card.lookup.names));
      if (requests.length === 0) return { status: 200, body: { packages: [], offline: false } };
      return { status: 200, body: await lookupPackages(requests, { fetchImpl: host.fetchImpl, env: host.env }) };
    },
  };
}

export type PackageChangesService = ReturnType<typeof createPackageChangesService>;
