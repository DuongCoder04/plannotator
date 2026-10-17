import type { ServerResponse } from "node:http";
import { isAbsolute, relative } from "node:path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
} from "../generated/file-browser-watch-core.ts";
import {
	REPO_LIVE_POLL_MS,
	createRepoChangeGate,
	isRepoWatchIgnored,
	isUnderIgnoredEntry,
	type RepoChangeGate,
	type RepoLiveMode,
} from "../generated/repo-files.ts";
import { getGitMetadataWatchPaths } from "../generated/workspace-status.ts";

// The code-review tree's live All files (`GET /api/repo-files/stream`).
// Mirrors packages/server/review-repo-watch.ts with the node:http transport:
// `watch` never descends into what git ignores, `poll` for very large
// repositories and multi-repo workspaces, and a page hears `changed` only
// when the working tree's signature moved.

const HEARTBEAT_MS = 30_000;
/** Live updates are debounced so a burst of writes lists the tree once. */
const REPO_WATCH_DEBOUNCE_MS = 500;

interface Subscriber {
	res: ServerResponse;
	notify: () => void;
	deliver: (version: number) => void;
}

export interface RepoLiveOptions {
	mode: RepoLiveMode;
	signature: () => Promise<string | null>;
	ignored?: () => Promise<string[]>;
	onChange: () => void;
	pollMs?: number;
}

export interface ReviewRepoWatch {
	/** Answer one page's SSE request: `ready` once, then `changed` after each real change. */
	stream(res: ServerResponse, root: string, options: RepoLiveOptions): Promise<void>;
	closeAll(): void;
	/** Tests only. */
	configureForTests: FileBrowserWatchRegistry<Subscriber>["configureForTests"];
}

function serialize(event: Pick<FileBrowserChangeEvent, "type" | "reason" | "timestamp">): string {
	return `data: ${JSON.stringify({ type: event.type, reason: event.reason, timestamp: event.timestamp })}\n\n`;
}

interface Live {
	gate: RepoChangeGate;
	subscribers: Set<Subscriber>;
	poll: ReturnType<typeof setInterval> | null;
}

export function createReviewRepoWatch(): ReviewRepoWatch {
	const registry = createFileBrowserWatchRegistry<Subscriber>({
		send: (subscriber) => {
			subscriber.notify();
			return true;
		},
		getGitMetadataWatchPaths,
		debounceMs: REPO_WATCH_DEBOUNCE_MS,
	});
	const lives = new Map<string, Live>();

	return {
		async stream(res, root, options) {
			let live = lives.get(root);
			if (!live) {
				live = { gate: createRepoChangeGate(options.signature), subscribers: new Set(), poll: null };
				lives.set(root, live);
			}
			const shared = live;
			const ignoredSet = options.mode === "watch" && options.ignored
				? new Set(await options.ignored().catch(() => []))
				: new Set<string>();
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			let seen = shared.gate.version;
			let open = true;
			let handle: ReturnType<typeof registry.ensure> | null = null;
			const subscriber: Subscriber = {
				res,
				notify: () => {
					void shared.gate.check().then((version) => subscriber.deliver(version));
				},
				deliver: (version) => {
					if (!open || version === seen) return;
					seen = version;
					options.onChange();
					try {
						res.write(serialize({ type: "changed", reason: "files", timestamp: Date.now() }));
					} catch {
						release();
					}
				},
			};
			const heartbeat = setInterval(() => {
				try {
					res.write(": heartbeat\n\n");
				} catch {
					release();
				}
			}, HEARTBEAT_MS);
			function release() {
				if (!open) return;
				open = false;
				clearInterval(heartbeat);
				if (handle) registry.release(handle, subscriber);
				shared.subscribers.delete(subscriber);
				if (shared.subscribers.size === 0) {
					if (shared.poll) clearInterval(shared.poll);
					lives.delete(root);
				}
			}
			shared.subscribers.add(subscriber);
			if (options.mode === "watch") {
				handle = registry.ensure({
					key: `repo:${root}`,
					watchPath: root,
					watchGit: true,
					ignored: (path) => {
						const rel = relative(root, path);
						if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
						return isRepoWatchIgnored(rel) || isUnderIgnoredEntry(rel, ignoredSet);
					},
				});
				registry.attach(handle, subscriber, root);
			} else if (!shared.poll) {
				shared.poll = setInterval(() => {
					void shared.gate.check().then((version) => {
						for (const each of shared.subscribers) each.deliver(version);
					});
				}, options.pollMs ?? REPO_LIVE_POLL_MS);
			}
			res.write(serialize({ type: "ready", reason: "initial", timestamp: Date.now() }));
			res.on("close", release);
		},
		closeAll() {
			registry.closeAll();
			for (const live of lives.values()) if (live.poll) clearInterval(live.poll);
			lives.clear();
		},
		configureForTests(overrides) {
			registry.configureForTests(overrides);
		},
	};
}
