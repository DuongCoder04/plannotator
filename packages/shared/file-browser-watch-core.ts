/**
 * Shared engine for the file-browser SSE watchers (Bun and Pi runtimes).
 *
 * #1313: the historical per-runtime implementations built a chokidar watcher
 * over the whole workspace synchronously on the request path. chokidar's
 * directory scan monopolizes the event loop for roughly 40ms per directory
 * under Bun, so a 228-directory repository froze the entire server for about
 * nine seconds, and because teardown was immediate on the last unsubscribe,
 * every EventSource reconnect paid the scan again. This module fixes the
 * class, once, for both runtimes:
 *
 * 1. Watcher construction is deferred off the request path, so the SSE ready
 *    event and concurrent API requests are served before any scan starts.
 * 2. Teardown gets a reconnect grace window. A reload or transient disconnect
 *    reuses the warm watcher instead of rebuilding it from scratch.
 * 3. On macOS and Windows the content watcher is the platform's native
 *    recursive fs.watch. Linux uses one fs.watch per directory, not per file,
 *    and stops with a logged refresh if the bounded directory-watch budget is
 *    exceeded. Chokidar remains the fallback on other platforms.
 *
 * The registry is transport-generic: the Bun runtime subscribes
 * ReadableStream controllers, the Pi runtime subscribes node:http responses.
 * Only the `send` callback differs.
 */

import chokidar, { type FSWatcher as ChokidarWatcher } from "chokidar";
import { lstatSync, watch as nodeFsWatch, statSync, type FSWatcher as NodeWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export interface FileBrowserChangeEvent {
	type: "ready" | "changed";
	dirPath: string;
	reason: "files" | "git" | "initial";
	timestamp: number;
}

export interface FileBrowserWatchTarget {
	key: string;
	watchPath: string;
	watchGit: boolean;
	exactFilePath?: string;
	ignored?: (path: string) => boolean;
}

export interface FileBrowserWatchRegistryOptions<S> {
	/** Deliver one serialized event to one subscriber; false drops the subscriber. */
	send: (subscriber: S, event: FileBrowserChangeEvent) => boolean;
	getGitMetadataWatchPaths: (watchPath: string) => string[];
	/** Reconnect grace before an unsubscribed watcher is torn down. */
	teardownGraceMs?: number;
	debounceMs?: number;
	/** Tests force the platform fallback (named "chokidar" for compatibility),
	 * or force the native branch and its fallback paths on Linux CI. */
	contentWatchBackend?: "auto" | "chokidar" | "native";
	/** Test seam for fs.watch failure modes in native and directory backends. */
	nativeWatch?: typeof nodeFsWatch;
}

export interface WatchEntryHandle {
	readonly key: string;
}

interface DirectoryWatch {
	watcher: NodeWatcher;
	identity: string;
}

interface WatchEntry<S> extends WatchEntryHandle {
	key: string;
	subscribers: Map<S, string>;
	contentWatcher: ChokidarWatcher | NodeWatcher | null;
	directoryWatchers?: Map<string, DirectoryWatch>;
	gitWatcher: ChokidarWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
	/** Deferred off-request construction (#1313). */
	warmupTimer: ReturnType<typeof setTimeout> | null;
	/** Pending reconnect-grace teardown (#1313). */
	teardownTimer: ReturnType<typeof setTimeout> | null;
	closed: boolean;
}

export interface FileBrowserWatchRegistry<S> {
	ensure(target: FileBrowserWatchTarget): WatchEntryHandle;
	attach(handle: WatchEntryHandle, subscriber: S, clientDirPath: string): void;
	release(handle: WatchEntryHandle, subscriber: S): void;
	/** Immediate teardown of every entry. Server stop and tests. */
	closeAll(): void;
	/**
	 * Tests only: entry count and how many content watchers were ever
	 * constructed. The grace-period test pins that a reconnect does not
	 * rebuild (starts stays flat), which is exactly the #1313 regression.
	 */
	diagnostics(): { entries: number; contentWatcherStarts: number };
	/** Tests only: override timing/backend without module-scope mutation. */
	configureForTests(overrides: Partial<Pick<FileBrowserWatchRegistryOptions<S>, "teardownGraceMs" | "debounceMs" | "contentWatchBackend" | "nativeWatch">>): void;
}

const DEFAULT_TEARDOWN_GRACE_MS = 30_000;
const DEFAULT_DEBOUNCE_MS = 180;
// The 228-directory workspace measured for #1313 fits; this registry cap
// bounds directory-watch growth on much larger trees.
const MAX_DIRECTORY_WATCHES = 512;

function getFileSignature(filePath: string): string {
	try {
		const stats = statSync(filePath, { bigint: true });
		return stats.isDirectory()
			? "directory"
			: `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
	} catch {
		return "missing";
	}
}

export function createExactFileWatchListener(
	watchPath: string,
	exactFilePath: string,
	onChange: () => void,
): (event: unknown, filename: string | Buffer | null | undefined) => void {
	let signature = getFileSignature(exactFilePath);
	return (_event, filename) => {
		try {
			const nextSignature = getFileSignature(exactFilePath);
			// Events on the watched directory itself arrive without a filename, as
			// null on some platforms and undefined on others (Bun on Linux).
			const eventMatches = filename == null
				|| resolve(watchPath, filename.toString()) === exactFilePath;
			if (eventMatches || nextSignature !== signature) {
				signature = nextSignature;
				onChange();
			}
		} catch {
			// A watcher event must never take down the server.
		}
	};
}

function nativeRecursiveSupported(): boolean {
	return process.platform === "darwin" || process.platform === "win32";
}

export function createFileBrowserWatchRegistry<S>(
	initialOptions: FileBrowserWatchRegistryOptions<S>,
): FileBrowserWatchRegistry<S> {
	const options = { ...initialOptions };
	const watchers = new Map<string, WatchEntry<S>>();
	let contentWatcherStarts = 0;
	let directoryWatcherCount = 0;

	const teardownGraceMs = () => options.teardownGraceMs ?? DEFAULT_TEARDOWN_GRACE_MS;
	const debounceMs = () => options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

	function broadcast(entry: WatchEntry<S>, reason: "files" | "git"): void {
		const hadSubscribers = entry.subscribers.size > 0;
		for (const [subscriber, clientDirPath] of entry.subscribers) {
			const event: FileBrowserChangeEvent = {
				type: "changed",
				dirPath: clientDirPath,
				reason,
				timestamp: Date.now(),
			};
			let delivered = false;
			try {
				delivered = options.send(subscriber, event);
			} catch {
				delivered = false;
			}
			if (!delivered) entry.subscribers.delete(subscriber);
		}
		// Dead subscribers discovered here never call release(), so an entry
		// emptied by delivery failures must still enter the teardown grace or
		// it lives until closeAll.
		if (hadSubscribers && entry.subscribers.size === 0) scheduleTeardown(entry);
	}

	function scheduleBroadcast(entry: WatchEntry<S>, reason: "files" | "git"): void {
		if (entry.closed) return;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		entry.debounceTimer = setTimeout(() => {
			entry.debounceTimer = null;
			broadcast(entry, reason);
		}, debounceMs());
	}

	function isCurrent(entry: WatchEntry<S>): boolean {
		return !entry.closed && watchers.get(entry.key) === entry;
	}

	function closeDirectoryWatchers(directoryWatchers: Map<string, DirectoryWatch>): void {
		for (const { watcher } of directoryWatchers.values()) {
			try {
				watcher.close();
			} catch {
				// Continue releasing the remaining directory watches.
			}
		}
		directoryWatcherCount -= directoryWatchers.size;
		directoryWatchers.clear();
	}

	function startChokidarContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): ChokidarWatcher {
		const watcher = chokidar.watch(target.watchPath, {
			ignoreInitial: true,
			persistent: true,
			ignored: target.ignored,
			awaitWriteFinish: {
				stabilityThreshold: 120,
				pollInterval: 30,
			},
		});
		watcher.on("all", () => scheduleBroadcast(entry, "files"));
		watcher.on("error", () => scheduleBroadcast(entry, "files"));
		return watcher;
	}

	async function startDirectoryContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): Promise<void> {
		const directoryWatchers = new Map<string, DirectoryWatch>();
		let failed = false;
		entry.directoryWatchers = directoryWatchers;

		const closeAll = () => closeDirectoryWatchers(directoryWatchers);

		const fail = (reason: string, error?: unknown) => {
			if (failed) return;
			failed = true;
			closeAll();
			console.error(`[plannotator] Directory file watching stopped for ${target.watchPath}: ${reason}`, error ?? "");
			scheduleBroadcast(entry, "files");
		};

		const removeDirectoryTree = (directory: string): void => {
			const prefix = `${directory}${sep}`;
			const removed = new Map<string, DirectoryWatch>();
			for (const [path, owned] of directoryWatchers) {
				if (path !== directory && !path.startsWith(prefix)) continue;
				removed.set(path, owned);
				directoryWatchers.delete(path);
			}
			closeDirectoryWatchers(removed);
		};

		const watchChildren = async (directory: string): Promise<void> => {
			let children;
			try {
				children = await readdir(directory, { withFileTypes: true });
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
				fail("directory scan failed", error);
				return;
			}

			const childDirectories = new Set(children.filter((child) => child.isDirectory()).map((child) => join(directory, child.name)));
			const prefix = `${directory}${sep}`;
			for (const path of directoryWatchers.keys()) {
				if (!path.startsWith(prefix)) continue;
				const remainder = path.slice(prefix.length);
				if (!remainder.includes(sep) && !childDirectories.has(path)) {
					removeDirectoryTree(path);
				}
			}
			for (const childPath of childDirectories) {
				if (!target.ignored?.(childPath)) await watchTree(childPath);
				if (failed || !isCurrent(entry)) return;
			}
		};

		const watchTree = async (directory: string): Promise<void> => {
			if (failed || !isCurrent(entry) || target.ignored?.(directory)) return;
			let identity: string;
			try {
				const stats = statSync(directory, { bigint: true });
				if (!stats.isDirectory()) return;
				identity = `${stats.dev}:${stats.ino}`;
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					removeDirectoryTree(directory);
					return;
				}
				fail("directory inspection failed", error);
				return;
			}

			const existing = directoryWatchers.get(directory);
			if (existing?.identity === identity) return;
			if (existing) removeDirectoryTree(directory);
			if (directoryWatcherCount >= MAX_DIRECTORY_WATCHES) {
				fail(`registry directory watch limit (${MAX_DIRECTORY_WATCHES}) reached`);
				return;
			}

			let watcher: NodeWatcher;
			try {
				watcher = (options.nativeWatch ?? nodeFsWatch)(directory, { persistent: true }, (event, filename) => {
					if (directoryWatchers.get(directory)?.watcher !== watcher) return;
					scheduleBroadcast(entry, "files");
					if (event === "rename" || filename == null) void watchChildren(directory);
					if (filename == null) return;
					const changedPath = join(directory, filename.toString());
					try {
						if (lstatSync(changedPath).isDirectory()) {
							if (!target.ignored?.(changedPath)) void watchTree(changedPath);
						} else if (event === "rename") {
							removeDirectoryTree(changedPath);
						}
					} catch (error) {
						if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
							removeDirectoryTree(changedPath);
						} else {
							fail("directory inspection failed", error);
						}
					}
				});
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					scheduleBroadcast(entry, "files");
					return;
				}
				fail("watch creation failed", error);
				return;
			}
			directoryWatchers.set(directory, { watcher, identity });
			directoryWatcherCount += 1;
			watcher.on("error", (error) => {
				if (directoryWatchers.get(directory)?.watcher !== watcher) return;
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					removeDirectoryTree(directory);
					scheduleBroadcast(entry, "files");
					return;
				}
				fail("watcher error", error);
			});
			await watchChildren(directory);
		};

		await watchTree(target.watchPath);
		if (failed || !isCurrent(entry)) closeAll();
	}

	function startFallbackContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		if (process.platform === "linux") {
			void startDirectoryContentWatcher(entry, target);
			return;
		}
		entry.contentWatcher = startChokidarContentWatcher(entry, target);
	}

	function startContentWatcher(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		contentWatcherStarts += 1;
		if (target.exactFilePath) {
			const exactFilePath = target.exactFilePath;
			const watcher = (options.nativeWatch ?? nodeFsWatch)(
				target.watchPath,
				{ persistent: true },
				createExactFileWatchListener(target.watchPath, exactFilePath, () => scheduleBroadcast(entry, "files")),
			);
			watcher.on("error", () => scheduleBroadcast(entry, "files"));
			entry.contentWatcher = watcher;
			return;
		}

		const backend = options.contentWatchBackend ?? "auto";
		if (backend === "native" || (backend === "auto" && nativeRecursiveSupported())) {
			try {
				const nativeWatch = options.nativeWatch ?? nodeFsWatch;
				const watcher = nativeWatch(target.watchPath, { recursive: true, persistent: true }, (_event, filename) => {
					try {
						if (filename != null) {
							const abs = resolve(target.watchPath, filename.toString());
							if (target.ignored?.(abs)) return;
						}
						scheduleBroadcast(entry, "files");
					} catch {
						// A watcher event must never take down the server.
					}
				});
				watcher.on("error", (error) => {
					// Native watching failed at runtime. Swap to the platform fallback
					// and force one refresh so changes during the swap are not lost.
					try {
						watcher.close();
					} catch {
						// Already closed.
					}
					if (isCurrent(entry) && entry.contentWatcher === watcher) {
						console.error(
							`[plannotator] Native file watching failed for ${target.watchPath}; switching to the fallback watcher:`,
							error,
						);
						contentWatcherStarts += 1;
						startFallbackContentWatcher(entry, target);
						scheduleBroadcast(entry, "files");
					}
				});
				entry.contentWatcher = watcher;
				return;
			} catch (error) {
				// Native creation failed. Fall through to chokidar.
				console.error(
					`[plannotator] Native file watching unavailable for ${target.watchPath}; using the fallback watcher:`,
					error,
				);
			}
		}
		startFallbackContentWatcher(entry, target);
	}

	function buildWatchers(entry: WatchEntry<S>, target: FileBrowserWatchTarget): void {
		if (!isCurrent(entry)) return;
		try {
			startContentWatcher(entry, target);
		} catch (error) {
			// A watcher that cannot start must not take down the stream, but the
			// subscriber is now living without live refreshes; say so.
			console.error(`[plannotator] File watcher failed to start for ${target.watchPath}:`, error);
		}
		try {
			const gitWatchPaths = target.watchGit
				? options.getGitMetadataWatchPaths(target.watchPath)
				: [];
			if (gitWatchPaths.length > 0) {
				entry.gitWatcher = chokidar.watch(gitWatchPaths, {
					ignoreInitial: true,
					persistent: true,
					// These are exact metadata files. Keep this non-recursive so a future
					// target cannot make startup walk the repository's entire refs tree.
					depth: 0,
					awaitWriteFinish: {
						stabilityThreshold: 80,
						pollInterval: 30,
					},
				});
				entry.gitWatcher.on("all", () => scheduleBroadcast(entry, "git"));
				entry.gitWatcher.on("error", () => scheduleBroadcast(entry, "git"));
			}
		} catch (error) {
			// Same containment for the git metadata watcher.
			console.error(`[plannotator] Git metadata watcher failed to start for ${target.watchPath}:`, error);
		}
	}

	function closeEntry(entry: WatchEntry<S>): void {
		entry.closed = true;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		if (entry.warmupTimer) clearTimeout(entry.warmupTimer);
		if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
		entry.debounceTimer = null;
		entry.warmupTimer = null;
		entry.teardownTimer = null;
		if (entry.directoryWatchers) closeDirectoryWatchers(entry.directoryWatchers);
		try {
			void entry.contentWatcher?.close();
		} catch {
			// A throwing close must not block the rest of the teardown.
		}
		try {
			void entry.gitWatcher?.close();
		} catch {
			// Same.
		}
		if (watchers.get(entry.key) === entry) {
			watchers.delete(entry.key);
		}
	}

	function scheduleTeardown(entry: WatchEntry<S>): void {
		if (entry.closed) return;
		if (entry.teardownTimer) clearTimeout(entry.teardownTimer);
		const timer = setTimeout(() => {
			entry.teardownTimer = null;
			if (entry.subscribers.size === 0) closeEntry(entry);
		}, teardownGraceMs());
		// The grace window must never hold the process open after the server
		// is otherwise done.
		(timer as { unref?: () => void }).unref?.();
		entry.teardownTimer = timer;
	}

	return {
		ensure(target) {
			const existing = watchers.get(target.key);
			if (existing) {
				// A resubscription inside the grace window reuses the warm entry.
				if (existing.teardownTimer) {
					clearTimeout(existing.teardownTimer);
					existing.teardownTimer = null;
				}
				return existing;
			}
			const entry: WatchEntry<S> = {
				key: target.key,
				subscribers: new Map(),
				contentWatcher: null,
				gitWatcher: null,
				debounceTimer: null,
				warmupTimer: null,
				teardownTimer: null,
				closed: false,
			};
			// Construction is deferred off the request path: the caller's SSE
			// ready event and concurrent API requests are served before any
			// directory scan begins (#1313).
			entry.warmupTimer = setTimeout(() => {
				entry.warmupTimer = null;
				buildWatchers(entry, target);
			}, 0);
			watchers.set(target.key, entry);
			return entry;
		},
		attach(handle, subscriber, clientDirPath) {
			const entry = watchers.get(handle.key);
			if (!entry || entry.closed) return;
			entry.subscribers.set(subscriber, clientDirPath);
		},
		release(handle, subscriber) {
			const entry = watchers.get(handle.key);
			if (!entry) return;
			entry.subscribers.delete(subscriber);
			if (entry.subscribers.size === 0) scheduleTeardown(entry);
		},
		closeAll() {
			for (const entry of [...watchers.values()]) closeEntry(entry);
		},
		diagnostics() {
			return { entries: watchers.size, contentWatcherStarts };
		},
		configureForTests(overrides) {
			Object.assign(options, overrides);
		},
	};
}
