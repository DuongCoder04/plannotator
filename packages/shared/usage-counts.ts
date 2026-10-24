/**
 * Usage counts for experimental features, on this computer: the on/off rule,
 * the local store, the two local facts, and the sender (approval record
 * "experimental-telemetry", 2026-10-24). The registry, the batch and its
 * validator are in @plannotator/core/usage-counts.
 *
 * Who decides:
 *  - Counts are on for a counted feature while that feature is on, unless the
 *    person turned them off (config.json `usageCounts`, `plannotator telemetry
 *    --off`). `PLANNOTATOR_TELEMETRY=0` and `DO_NOT_TRACK=1` turn them off
 *    everywhere. Nothing turns them on: no env var, no flag.
 *  - Off means nothing is recorded, nothing is sent, and unsent counts are
 *    deleted.
 *  - Only the local Plannotator process records and sends, never a browser.
 *  - A build that is not a release (`version` not X.Y.Z, a source run, a test)
 *    sends nothing unless `PLANNOTATOR_TELEMETRY_URL` names a loopback http
 *    endpoint. A release ignores that variable unless the test sandbox is set,
 *    so nothing can redirect real counts.
 *
 * The store, `${dataDir}/usage-counts/` (0700; files 0600, written whole):
 *  - counts.json: `{ v: 1, days: { "<day>": { "<feature>": { rev, events, closed? } } } }`
 *  - facts.json:  `{ v: 1, features: { "<feature>": { firstDay?, firstDaySent?, usedDays? } } }`
 *  - sent.jsonl:  each body exactly as sent, with the local send time; the last 60
 *  - state.json:  the send claim `{ v: 1, attemptedAt?, failedAt?, retryAt? }`
 *  - counts.lock: a mkdir lock, stale after 30 s
 *
 * A day is sent only once it is complete in UTC ("today" never). When a day
 * closes, its two facts are written into it: `days_last7` from the used days
 * in the 7 days ending on it, and `first_day` when it is the first day the
 * feature was used on this computer and that was never sent. A day older than
 * 30 days is dropped unsent. After a global `--off`, facts.json keeps only
 * each feature's first-day marker, so turning counts on again never sends
 * `first_day` twice; every count and used day is deleted.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { join } from "node:path";
import { connect as tlsConnect } from "node:tls";
import {
  addUtcDays,
  buildUsageCountsBatch,
  buildUsageCountsRequest,
  daysLast7Value,
  isRecordableUsageCountEvent,
  isUtcDay,
  parseUsageCountsBatch,
  serializeUsageCountsBatch,
  USAGE_COUNT_CAP,
  USAGE_COUNT_FEATURES,
  USAGE_COUNTS_HOST,
  USAGE_COUNTS_PATH,
  USAGE_COUNTS_QUEUE_DAYS,
  usageCountEvent,
  usageCountFeature,
  utcDay,
  utcDaysBetween,
  type RecordableUsageCountEvent,
  type UsageCountFeatureDef,
  type UsageCountFeatureId,
} from "@plannotator/core/usage-counts";
import { loadConfig, saveConfig, type PlannotatorConfig } from "./config";
import { getPlannotatorDataDir } from "./data-dir";

export const USAGE_COUNTS_DIR = "usage-counts";
const COUNTS_FILE = "counts.json";
const FACTS_FILE = "facts.json";
const SENT_FILE = "sent.jsonl";
const STATE_FILE = "state.json";
const LOCK_DIR = "counts.lock";

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const SENT_KEEP = 60;
/** Used days are kept long enough to close the oldest day the queue keeps. */
const USED_DAYS_KEEP = USAGE_COUNTS_QUEUE_DAYS + 7;

export const USAGE_COUNTS_SEND_INTERVAL_MS = 60 * 60 * 1000;
export const USAGE_COUNTS_FAILURE_RETRY_MS = 6 * 60 * 60 * 1000;
export const USAGE_COUNTS_RATE_LIMIT_MIN_MS = 60 * 60 * 1000;
export const USAGE_COUNTS_RATE_LIMIT_MAX_MS = 24 * 60 * 60 * 1000;
/** At most this many batches per attempt, oldest first. */
export const USAGE_COUNTS_BATCHES_PER_SEND = 14;
const SEND_TIMEOUT_MS = 15_000;

// ── On or off ──

export type UsageCountsEnvBlock = "PLANNOTATOR_TELEMETRY" | "DO_NOT_TRACK";

/**
 * The environment's hard off, or null. `PLANNOTATOR_TELEMETRY` 0 / false / off
 * / disabled / no; `DO_NOT_TRACK` set to anything but empty, 0, false, no or
 * off (consoledonottrack.com: `DO_NOT_TRACK=1`). No value turns counts on.
 */
export function usageCountsEnvBlock(env: NodeJS.ProcessEnv = process.env): UsageCountsEnvBlock | null {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt && !["0", "false", "no", "off"].includes(dnt)) return "DO_NOT_TRACK";
  const t = env.PLANNOTATOR_TELEMETRY?.trim().toLowerCase();
  if (t && ["0", "false", "off", "disabled", "no"].includes(t)) return "PLANNOTATOR_TELEMETRY";
  return null;
}

/** What config.json says for one feature: on unless turned off. */
export function configuredUsageCounts(config: PlannotatorConfig, featureId: string): boolean {
  const value = config.usageCounts;
  if (value === false) return false;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) return value[featureId] !== false;
  return true;
}

/**
 * Whether the experimental feature itself is on. Phase 1 reads the raw config
 * key the decision-mode build writes (`experimental.<id> === true`); phase 2
 * passes `resolveExperimental` through `featureEnabled`. A feature turned on
 * only by an env var never counts: no notice was shown.
 */
export function defaultUsageCountFeatureEnabled(config: PlannotatorConfig, featureId: string): boolean {
  const experimental = (config as { experimental?: unknown }).experimental;
  return typeof experimental === "object" && experimental !== null && (experimental as Record<string, unknown>)[featureId] === true;
}

export type UsageCountsReason = "on" | "unknown_feature" | "feature_off" | "ended" | UsageCountsEnvBlock | "config";

export interface UsageCountsDecideOptions {
  env?: NodeJS.ProcessEnv;
  now?: number;
  featureEnabled?: (config: PlannotatorConfig, featureId: string) => boolean;
}

/** Whether a feature's counts may be recorded and sent now, and why not. */
export function usageCountsStatus(config: PlannotatorConfig, featureId: string, options: UsageCountsDecideOptions = {}): { on: boolean; reason: UsageCountsReason } {
  const feature = usageCountFeature(featureId);
  if (!feature) return { on: false, reason: "unknown_feature" };
  const block = usageCountsEnvBlock(options.env ?? process.env);
  if (block) return { on: false, reason: block };
  if (!configuredUsageCounts(config, featureId)) return { on: false, reason: "config" };
  if (!(options.featureEnabled ?? defaultUsageCountFeatureEnabled)(config, featureId)) return { on: false, reason: "feature_off" };
  if (utcDay(options.now ?? Date.now()) > feature.collectUntil) return { on: false, reason: "ended" };
  return { on: true, reason: "on" };
}

export function resolveUsageCounts(config: PlannotatorConfig, featureId: string, options: UsageCountsDecideOptions = {}): boolean {
  return usageCountsStatus(config, featureId, options).on;
}

/**
 * The `usageCounts` value to save for `--on` / `--off`, all features or one.
 * `undefined` means the key goes (the default, on).
 */
export function nextUsageCountsConfig(current: PlannotatorConfig["usageCounts"], on: boolean, featureId?: string): PlannotatorConfig["usageCounts"] {
  if (!featureId) return on ? undefined : false;
  const map: Record<string, boolean> = {};
  if (current === false) for (const f of USAGE_COUNT_FEATURES) map[f.id] = false;
  else if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    for (const [k, v] of Object.entries(current)) if (v === false && usageCountFeature(k)) map[k] = false;
  }
  if (on) delete map[featureId];
  else map[featureId] = false;
  return Object.keys(map).length === 0 ? undefined : map;
}

// ── The store ──

interface DayRecord {
  rev: number;
  events: Record<string, number>;
  closed?: true;
}

interface CountsFile {
  v: 1;
  days: Record<string, Record<string, DayRecord>>;
}

interface FeatureFacts {
  firstDay?: string;
  firstDaySent?: true;
  usedDays?: string[];
}

interface FactsFile {
  v: 1;
  features: Record<string, FeatureFacts>;
}

interface SendState {
  v: 1;
  attemptedAt?: number;
  failedAt?: number;
  retryAt?: number;
}

export function usageCountsDir(dataDir: string = getPlannotatorDataDir()): string {
  return join(dataDir, USAGE_COUNTS_DIR);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Read counts.json, keeping only shapes it could have written. */
function readCounts(dir: string): CountsFile {
  const raw = readJson(join(dir, COUNTS_FILE));
  const out: CountsFile = { v: 1, days: {} };
  if (!isPlainObject(raw) || !isPlainObject(raw.days)) return out;
  for (const [day, features] of Object.entries(raw.days)) {
    if (!isUtcDay(day) || !isPlainObject(features)) continue;
    for (const [featureId, record] of Object.entries(features)) {
      if (!usageCountFeature(featureId) || !isPlainObject(record) || !isPlainObject(record.events)) continue;
      const rev = typeof record.rev === "number" && Number.isInteger(record.rev) ? record.rev : 0;
      const events: Record<string, number> = {};
      for (const [k, v] of Object.entries(record.events)) if (typeof v === "number" && Number.isFinite(v)) events[k] = v;
      (out.days[day] ??= {})[featureId] = { rev, events, ...(record.closed === true ? { closed: true as const } : {}) };
    }
  }
  return out;
}

function readFacts(dir: string): FactsFile {
  const raw = readJson(join(dir, FACTS_FILE));
  const out: FactsFile = { v: 1, features: {} };
  if (!isPlainObject(raw) || !isPlainObject(raw.features)) return out;
  for (const [featureId, facts] of Object.entries(raw.features)) {
    if (!usageCountFeature(featureId) || !isPlainObject(facts)) continue;
    const f: FeatureFacts = {};
    if (isUtcDay(facts.firstDay)) f.firstDay = facts.firstDay;
    if (facts.firstDaySent === true) f.firstDaySent = true;
    if (Array.isArray(facts.usedDays)) f.usedDays = [...new Set(facts.usedDays.filter(isUtcDay))].sort();
    out.features[featureId] = f;
  }
  return out;
}

function readState(dir: string): SendState {
  const raw = readJson(join(dir, STATE_FILE));
  const out: SendState = { v: 1 };
  if (!isPlainObject(raw)) return out;
  for (const k of ["attemptedAt", "failedAt", "retryAt"] as const) {
    const v = raw[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Windows keeps its ACLs.
  }
}

function writeFileWhole(dir: string, name: string, contents: string): void {
  ensureDir(dir);
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function removeFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

function writeCounts(dir: string, counts: CountsFile): void {
  if (Object.keys(counts.days).length === 0) return removeFile(join(dir, COUNTS_FILE));
  writeFileWhole(dir, COUNTS_FILE, `${JSON.stringify(counts)}\n`);
}

function writeFacts(dir: string, facts: FactsFile): void {
  for (const [k, f] of Object.entries(facts.features)) {
    if (f.usedDays && f.usedDays.length === 0) delete f.usedDays;
    if (Object.keys(f).length === 0) delete facts.features[k];
  }
  if (Object.keys(facts.features).length === 0) return removeFile(join(dir, FACTS_FILE));
  writeFileWhole(dir, FACTS_FILE, `${JSON.stringify(facts)}\n`);
}

/** Remove the folder when nothing is left in it. */
function removeDirIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    // Not there, or not empty.
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Run `fn` under the folder's mkdir lock; answers undefined when the lock cannot be had (never blocks for long, never throws). */
function withLock<T>(dir: string, fn: () => T): T | undefined {
  ensureDir(dir);
  const lock = join(dir, LOCK_DIR);
  const end = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
          rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > end) return undefined;
      sleepSync(10);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // Taken over as stale.
    }
  }
}

/**
 * Close every complete day: write its two facts into it, once. Drop days
 * older than the queue keeps, and used days older than any open day needs.
 */
function closeDays(counts: CountsFile, facts: FactsFile, today: string): void {
  for (const day of Object.keys(counts.days)) {
    if (utcDaysBetween(day, today) > USAGE_COUNTS_QUEUE_DAYS) delete counts.days[day];
  }
  for (const [day, features] of Object.entries(counts.days)) {
    if (day >= today) continue;
    for (const [featureId, record] of Object.entries(features)) {
      if (record.closed) continue;
      const f = facts.features[featureId] ?? {};
      const from = addUtcDays(day, -6);
      const used = (f.usedDays ?? []).filter((d) => d >= from && d <= day).length;
      const bucket = daysLast7Value(used);
      if (bucket !== null) record.events.days_last7 = bucket;
      if (f.firstDay === day && !f.firstDaySent) record.events.first_day = 1;
      record.closed = true;
    }
  }
  const keepFrom = addUtcDays(today, -USED_DAYS_KEEP);
  for (const f of Object.values(facts.features)) {
    if (f.usedDays) f.usedDays = f.usedDays.filter((d) => d >= keepFrom);
  }
}

/** Delete one feature's unsent counts and used days (its first-day marker stays). */
function forgetFeature(counts: CountsFile, facts: FactsFile, featureId: string): void {
  for (const [day, features] of Object.entries(counts.days)) {
    delete features[featureId];
    if (Object.keys(features).length === 0) delete counts.days[day];
  }
  const f = facts.features[featureId];
  if (f) delete f.usedDays;
}

export interface UsageCountsDeps extends UsageCountsDecideOptions {
  dataDir?: string;
  /** Read config.json (default loadConfig). */
  config?: () => PlannotatorConfig;
}

function depsDir(deps: UsageCountsDeps): string {
  return usageCountsDir(deps.dataDir ?? getPlannotatorDataDir());
}

/**
 * Record one event for a feature, for today (UTC). The only way counts enter
 * the store. `day` events are set to 1; `count` events add, capped at 100.
 * When counts are off for the feature nothing is written, and its unsent
 * counts are deleted. Never throws; answers whether it recorded.
 */
export function recordUsageCount<F extends UsageCountFeatureId>(featureId: F, event: RecordableUsageCountEvent<F>, deps: UsageCountsDeps = {}): boolean {
  try {
    const feature = usageCountFeature(featureId);
    if (!feature || !isRecordableUsageCountEvent(feature, event)) return false;
    const config = (deps.config ?? loadConfig)();
    const now = deps.now ?? Date.now();
    const dir = depsDir(deps);
    if (!usageCountsStatus(config, featureId, { ...deps, now }).on) {
      forgetUsageCounts({ ...deps, feature: featureId });
      return false;
    }
    const today = utcDay(now);
    const done = withLock(dir, () => {
      const counts = readCounts(dir);
      const facts = readFacts(dir);
      closeDays(counts, facts, today);
      const record = ((counts.days[today] ??= {})[featureId] ??= { rev: feature.rev, events: {} });
      const def = usageCountEvent(feature, event)!;
      if (def.kind === "day") record.events[def.id] = 1;
      else record.events[def.id] = Math.min(USAGE_COUNT_CAP, (record.events[def.id] ?? 0) + 1);
      if (def.id === feature.useEvent) {
        const f = (facts.features[featureId] ??= {});
        f.firstDay ??= today;
        f.usedDays = [...new Set([...(f.usedDays ?? []), today])].sort();
      }
      writeCounts(dir, counts);
      writeFacts(dir, facts);
      return true;
    });
    return done === true;
  } catch {
    return false;
  }
}

/**
 * Delete unsent counts: one feature's (its days and used days), or every
 * feature's (counts, used days, the sent log and the send state; only the
 * first-day markers stay). Removes the folder when nothing is left.
 */
export function forgetUsageCounts(deps: Pick<UsageCountsDeps, "dataDir"> & { feature?: string } = {}): void {
  const dir = depsDir(deps);
  if (!existsSync(dir)) return;
  withLock(dir, () => {
    const counts = readCounts(dir);
    const facts = readFacts(dir);
    if (deps.feature) {
      forgetFeature(counts, facts, deps.feature);
    } else {
      counts.days = {};
      for (const f of Object.values(facts.features)) delete f.usedDays;
      removeFile(join(dir, SENT_FILE));
      removeFile(join(dir, STATE_FILE));
    }
    writeCounts(dir, counts);
    writeFacts(dir, facts);
  });
  removeDirIfEmpty(dir);
}

export interface PendingUsageCountsBatch {
  feature: UsageCountFeatureId;
  day: string;
  body: string;
}

/** The batches waiting, oldest first, for features whose counts are on. Reads only. */
export function pendingUsageCountBatches(deps: UsageCountsDeps = {}): PendingUsageCountsBatch[] {
  const dir = depsDir(deps);
  if (!existsSync(dir)) return [];
  const config = (deps.config ?? loadConfig)();
  const now = deps.now ?? Date.now();
  const counts = readCounts(dir);
  const facts = readFacts(dir);
  closeDays(counts, facts, utcDay(now));
  return batchesOf(counts, (id) => usageCountsStatus(config, id, { ...deps, now }).on);
}

function batchesOf(counts: CountsFile, on: (featureId: string) => boolean): PendingUsageCountsBatch[] {
  const out: PendingUsageCountsBatch[] = [];
  for (const day of Object.keys(counts.days).sort()) {
    for (const feature of USAGE_COUNT_FEATURES) {
      const record = counts.days[day]?.[feature.id];
      if (!record?.closed || !on(feature.id)) continue;
      const batch = buildUsageCountsBatch(feature.id, record.rev, day, record.events);
      if (batch) out.push({ feature: batch.feature, day, body: serializeUsageCountsBatch(batch) });
    }
  }
  return out;
}

/** Today's counts so far (they stay on this computer until the UTC day ends). */
export function todayUsageCounts(deps: UsageCountsDeps = {}): Record<string, Record<string, number>> {
  const dir = depsDir(deps);
  if (!existsSync(dir)) return {};
  const today = utcDay(deps.now ?? Date.now());
  const counts = readCounts(dir);
  const out: Record<string, Record<string, number>> = {};
  for (const [featureId, record] of Object.entries(counts.days[today] ?? {})) {
    const batch = buildUsageCountsBatch(featureId, record.rev, today, record.events);
    if (batch) out[featureId] = batch.events;
  }
  return out;
}

export interface SentUsageCounts {
  at: string;
  body: string;
}

/** The last batches sent, oldest first. */
export function sentUsageCounts(deps: Pick<UsageCountsDeps, "dataDir"> = {}): SentUsageCounts[] {
  return readSent(depsDir(deps));
}

function readSent(dir: string): SentUsageCounts[] {
  try {
    return readFileSync(join(dir, SENT_FILE), "utf-8")
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const v = JSON.parse(line);
          return typeof v?.at === "string" && typeof v?.body === "string" ? [{ at: v.at, body: v.body }] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendSent(dir: string, body: string, now: number): void {
  const lines = [...readSent(dir), { at: new Date(now).toISOString(), body }].slice(-SENT_KEEP);
  writeFileWhole(dir, SENT_FILE, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

// ── Where counts go ──

export interface UsageCountsEndpoint {
  hostname: string;
  port: number;
  secure: boolean;
  /** The Host header. */
  host: string;
  /** For display. */
  url: string;
}

export const USAGE_COUNTS_ENDPOINT: UsageCountsEndpoint = {
  hostname: USAGE_COUNTS_HOST,
  port: 443,
  secure: true,
  host: USAGE_COUNTS_HOST,
  url: `https://${USAGE_COUNTS_HOST}${USAGE_COUNTS_PATH}`,
};

export function isReleaseVersion(version: string | undefined): boolean {
  return typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version);
}

/** A loopback `http:` origin, or null. */
export function parseUsageCountsTestUrl(value: string | undefined): UsageCountsEndpoint | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = hostname === "localhost" || hostname === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
  if (!loopback) return null;
  const port = url.port ? Number(url.port) : 80;
  return { hostname, port, secure: false, host: url.host, url: `${url.origin}${USAGE_COUNTS_PATH}` };
}

/**
 * Where this process may send, or null for nowhere. A release build sends to
 * the counts service; `PLANNOTATOR_TELEMETRY_URL` (loopback http only) applies
 * only to a build that is not a release or under the test sandbox. A build
 * that is not a release with no test endpoint sends nothing.
 */
export function resolveUsageCountsEndpoint(version: string | undefined, env: NodeJS.ProcessEnv = process.env): UsageCountsEndpoint | null {
  const release = isReleaseVersion(version);
  const testUrl = !release || env.PLANNOTATOR_TEST_SANDBOX ? parseUsageCountsTestUrl(env.PLANNOTATOR_TELEMETRY_URL) : null;
  if (testUrl) return testUrl;
  return release ? USAGE_COUNTS_ENDPOINT : null;
}

// ── The transport ──

export interface UsageCountsResponse {
  status: number;
  retryAfter: string | null;
}

export type UsageCountsTransport = (endpoint: UsageCountsEndpoint, request: string) => Promise<UsageCountsResponse>;

/**
 * Write the request bytes on a socket of our own (TLS for the service, plain
 * TCP for a loopback test endpoint), so no runtime adds a header: what
 * buildUsageCountsRequest returns is exactly what goes out. Reads the status
 * line and headers, then closes.
 */
export const socketUsageCountsTransport: UsageCountsTransport = (endpoint, request) =>
  new Promise((resolve, reject) => {
    const socket = endpoint.secure
      ? tlsConnect({ host: endpoint.hostname, port: endpoint.port, servername: endpoint.hostname })
      : netConnect({ host: endpoint.hostname, port: endpoint.port });
    let settled = false;
    let head = "";
    const finish = (error: Error | null, response?: UsageCountsResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response!);
    };
    const timer = setTimeout(() => finish(new Error("timed out")), SEND_TIMEOUT_MS);
    socket.once(endpoint.secure ? "secureConnect" : "connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1 && head.length < 16_384) return;
      const lines = head.slice(0, end === -1 ? head.length : end).split("\r\n");
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0] ?? "");
      if (!status) return finish(new Error("not an HTTP answer"));
      const retry = lines.find((l) => /^retry-after:/i.test(l));
      finish(null, { status: Number(status[1]), retryAfter: retry ? retry.slice(retry.indexOf(":") + 1).trim() : null });
    });
    socket.on("error", (error: Error) => finish(error));
    socket.on("close", () => finish(new Error("closed before an answer")));
  });

// ── The sender ──

export function isUsageCountsSendDue(state: { attemptedAt?: number; failedAt?: number; retryAt?: number }, now: number): boolean {
  if (typeof state.retryAt === "number" && state.retryAt > now && state.retryAt - now <= USAGE_COUNTS_RATE_LIMIT_MAX_MS) return false;
  const attempt = state.attemptedAt;
  if (typeof attempt !== "number" || attempt > now) return true;
  const failed = typeof state.failedAt === "number" && state.failedAt >= attempt;
  return now - attempt >= (failed ? USAGE_COUNTS_FAILURE_RETRY_MS : USAGE_COUNTS_SEND_INTERVAL_MS);
}

function retryAfterMs(value: string | null, now: number): number {
  let ms = NaN;
  if (value && /^\d+$/.test(value)) ms = Number(value) * 1000;
  else if (value) ms = Date.parse(value) - now;
  if (!Number.isFinite(ms)) ms = USAGE_COUNTS_RATE_LIMIT_MIN_MS;
  return Math.min(USAGE_COUNTS_RATE_LIMIT_MAX_MS, Math.max(USAGE_COUNTS_RATE_LIMIT_MIN_MS, ms));
}

export interface SendUsageCountsDeps extends UsageCountsDeps {
  /** The CLI's release version (`__CLI_VERSION__`); undefined for a source run. */
  version: string | undefined;
  transport?: UsageCountsTransport;
  /** Skip the hourly window (`plannotator telemetry --send`). Every on/off rule still holds. */
  force?: boolean;
  log?: (line: string) => void;
}

export type SendUsageCountsStatus = "nowhere" | "off" | "nothing" | "not_due" | "busy" | "sent" | "failed" | "rate_limited";

export interface SendUsageCountsResult {
  status: SendUsageCountsStatus;
  sent: number;
  dropped: number;
  endpoint: string | null;
}

/**
 * Send the waiting batches: one request per (feature, complete day), oldest
 * first, at most USAGE_COUNTS_BATCHES_PER_SEND, at most one attempt an hour
 * (6 h after a failure; a 429's Retry-After clamped to 1–24 h). The attempt is
 * claimed in state.json before any request, so processes sharing a data dir
 * send once. Before each request the on/off rule is read again from
 * config.json and the env; a feature found off is deleted, not sent. A batch
 * leaves the store only after a 2xx; a 4xx drops it (it can never pass). Never
 * throws.
 */
export async function sendUsageCounts(deps: SendUsageCountsDeps): Promise<SendUsageCountsResult> {
  const endpoint = resolveUsageCountsEndpoint(deps.version, deps.env ?? process.env);
  const result: SendUsageCountsResult = { status: "nowhere", sent: 0, dropped: 0, endpoint: endpoint?.url ?? null };
  const dir = depsDir(deps);
  const readConfig = deps.config ?? loadConfig;
  const nowOf = () => deps.now ?? Date.now();
  const onFor = (featureId: string) => usageCountsStatus(readConfig(), featureId, { ...deps, now: nowOf() }).on;
  try {
    // Off: delete what waits, before anything else, whether or not this build sends.
    if (existsSync(dir)) {
      for (const feature of USAGE_COUNT_FEATURES) if (!onFor(feature.id)) forgetUsageCounts({ dataDir: deps.dataDir, feature: feature.id });
    }
    if (!endpoint) return result;
    if (!USAGE_COUNT_FEATURES.some((f) => onFor(f.id))) return { ...result, status: "off" };
    if (!existsSync(dir)) return { ...result, status: "nothing" };

    const claimed = withLock(dir, () => {
      const now = nowOf();
      const counts = readCounts(dir);
      const facts = readFacts(dir);
      closeDays(counts, facts, utcDay(now));
      writeCounts(dir, counts);
      writeFacts(dir, facts);
      const batches = batchesOf(counts, onFor).slice(0, USAGE_COUNTS_BATCHES_PER_SEND);
      if (batches.length === 0) return { batches, due: true };
      const state = readState(dir);
      if (!deps.force && !isUsageCountsSendDue(state, now)) return { batches: [], due: false };
      writeFileWhole(dir, STATE_FILE, `${JSON.stringify({ v: 1, attemptedAt: now })}\n`);
      return { batches, due: true };
    });
    if (!claimed) return { ...result, status: "busy" };
    if (!claimed.due) return { ...result, status: "not_due" };
    if (claimed.batches.length === 0) return { ...result, status: "nothing" };

    const transport = deps.transport ?? socketUsageCountsTransport;
    for (const batch of claimed.batches) {
      if (!onFor(batch.feature)) {
        forgetUsageCounts({ dataDir: deps.dataDir, feature: batch.feature });
        continue;
      }
      // The client runs the Worker's validator on its own batch.
      if (!parseUsageCountsBatch(batch.body, { today: utcDay(nowOf()) })) {
        dropBatch(dir, batch, false);
        result.dropped++;
        continue;
      }
      let response: UsageCountsResponse;
      try {
        response = await transport(endpoint, buildUsageCountsRequest(endpoint.host, batch.body));
      } catch (error) {
        deps.log?.(`usage counts: send failed (${error instanceof Error ? error.message : "error"})`);
        markState(dir, { failedAt: nowOf() });
        return { ...result, status: "failed" };
      }
      if (response.status >= 200 && response.status < 300) {
        dropBatch(dir, batch, true);
        appendSentUnderLock(dir, batch.body, nowOf());
        result.sent++;
      } else if (response.status === 429) {
        markState(dir, { retryAt: nowOf() + retryAfterMs(response.retryAfter, nowOf()) });
        return { ...result, status: "rate_limited" };
      } else if (response.status >= 400 && response.status < 500) {
        deps.log?.(`usage counts: the service refused a batch (${response.status}); dropped`);
        dropBatch(dir, batch, false);
        result.dropped++;
      } else {
        deps.log?.(`usage counts: the service answered ${response.status}`);
        markState(dir, { failedAt: nowOf() });
        return { ...result, status: "failed" };
      }
    }
    return { ...result, status: result.sent > 0 ? "sent" : "nothing" };
  } catch (error) {
    deps.log?.(`usage counts: ${error instanceof Error ? error.message : "error"}`);
    return { ...result, status: "failed" };
  }
}

function dropBatch(dir: string, batch: PendingUsageCountsBatch, sent: boolean): void {
  withLock(dir, () => {
    const counts = readCounts(dir);
    const facts = readFacts(dir);
    const record = counts.days[batch.day]?.[batch.feature];
    if (sent && record?.events.first_day === 1) (facts.features[batch.feature] ??= {}).firstDaySent = true;
    if (counts.days[batch.day]) {
      delete counts.days[batch.day]![batch.feature];
      if (Object.keys(counts.days[batch.day]!).length === 0) delete counts.days[batch.day];
    }
    writeCounts(dir, counts);
    writeFacts(dir, facts);
  });
}

function appendSentUnderLock(dir: string, body: string, now: number): void {
  withLock(dir, () => appendSent(dir, body, now));
}

function markState(dir: string, patch: Partial<SendState>): void {
  withLock(dir, () => {
    writeFileWhole(dir, STATE_FILE, `${JSON.stringify({ ...readState(dir), ...patch })}\n`);
  });
}

// ── --show and --off / --on ──

export interface UsageCountsFeatureReport {
  id: UsageCountFeatureId;
  name: string;
  rev: number;
  collectUntil: string;
  enabled: boolean;
  counts: { on: boolean; reason: UsageCountsReason };
  events: { id: string; label: string }[];
  today: Record<string, number>;
  waiting: PendingUsageCountsBatch[];
}

export interface UsageCountsReport {
  endpoint: string | null;
  envBlock: UsageCountsEnvBlock | null;
  config: PlannotatorConfig["usageCounts"] | null;
  features: UsageCountsFeatureReport[];
  sent: SentUsageCounts[];
}

/** Everything `plannotator telemetry --show` prints. Reads only; no network. */
export function describeUsageCounts(deps: UsageCountsDeps & { version: string | undefined }): UsageCountsReport {
  const config = (deps.config ?? loadConfig)();
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now();
  const waiting = pendingUsageCountBatches({ ...deps, config: () => config, now });
  const today = todayUsageCounts({ ...deps, now });
  return {
    endpoint: resolveUsageCountsEndpoint(deps.version, env)?.url ?? null,
    envBlock: usageCountsEnvBlock(env),
    config: config.usageCounts ?? null,
    features: (USAGE_COUNT_FEATURES as readonly UsageCountFeatureDef[]).map((f) => {
      const status = usageCountsStatus(config, f.id, { ...deps, env, now });
      return {
        id: f.id as UsageCountFeatureId,
        name: f.name,
        rev: f.rev,
        collectUntil: f.collectUntil,
        enabled: (deps.featureEnabled ?? defaultUsageCountFeatureEnabled)(config, f.id),
        counts: status,
        events: f.events.map((e) => ({ id: e.id, label: e.label })),
        today: status.on ? (today[f.id] ?? {}) : {},
        waiting: waiting.filter((b) => b.feature === f.id),
      };
    }),
    sent: sentUsageCounts(deps),
  };
}

/**
 * Turn counts off or on in config.json, for every feature or one. Off also
 * deletes the unsent counts. On never overrides the env's hard off.
 */
export function setUsageCounts(on: boolean, options: { feature?: string; dataDir?: string } = {}): PlannotatorConfig["usageCounts"] {
  const next = nextUsageCountsConfig(loadConfig().usageCounts, on, options.feature);
  saveConfig({ usageCounts: next });
  if (!on) forgetUsageCounts({ dataDir: options.dataDir, feature: options.feature });
  return next;
}
