import type { ServerResponse } from "node:http";
import { isAbsolute, relative } from "node:path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
} from "../generated/file-browser-watch-core.ts";
import { isRepoWatchIgnored } from "../generated/repo-files.ts";
import { getGitMetadataWatchPaths } from "../generated/workspace-status.ts";

// The code-review tree's live All files (`GET /api/repo-files/stream`).
// Mirrors packages/server/review-repo-watch.ts with the node:http transport.

const HEARTBEAT_MS = 30_000;
/** Live updates are debounced so a burst of writes lists the tree once. */
const REPO_WATCH_DEBOUNCE_MS = 500;

interface Subscriber {
	res: ServerResponse;
	onChange: () => void;
}

export interface ReviewRepoWatch {
	/** Answer one page's SSE request: `ready` once, then `changed` after each settled burst. */
	stream(res: ServerResponse, root: string, onChange: () => void): void;
	closeAll(): void;
	/** Tests only. */
	configureForTests: FileBrowserWatchRegistry<Subscriber>["configureForTests"];
}

function serialize(event: Pick<FileBrowserChangeEvent, "type" | "reason" | "timestamp">): string {
	return `data: ${JSON.stringify({ type: event.type, reason: event.reason, timestamp: event.timestamp })}\n\n`;
}

export function createReviewRepoWatch(): ReviewRepoWatch {
	const registry = createFileBrowserWatchRegistry<Subscriber>({
		send: (subscriber, event) => {
			try {
				subscriber.onChange();
				subscriber.res.write(serialize(event));
				return true;
			} catch {
				return false;
			}
		},
		getGitMetadataWatchPaths,
		debounceMs: REPO_WATCH_DEBOUNCE_MS,
	});

	return {
		stream(res, root, onChange) {
			const handle = registry.ensure({
				key: `repo:${root}`,
				watchPath: root,
				watchGit: true,
				ignored: (path) => {
					const rel = relative(root, path);
					if (!rel || rel.startsWith("..") || isAbsolute(rel)) return false;
					return isRepoWatchIgnored(rel);
				},
			});
			res.writeHead(200, {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			});
			const subscriber: Subscriber = { res, onChange };
			registry.attach(handle, subscriber, root);
			res.write(serialize({ type: "ready", reason: "initial", timestamp: Date.now() }));
			const heartbeat = setInterval(() => {
				try {
					res.write(": heartbeat\n\n");
				} catch {
					clearInterval(heartbeat);
					registry.release(handle, subscriber);
				}
			}, HEARTBEAT_MS);
			res.on("close", () => {
				clearInterval(heartbeat);
				registry.release(handle, subscriber);
			});
		},
		closeAll() {
			registry.closeAll();
		},
		configureForTests(overrides) {
			registry.configureForTests(overrides);
		},
	};
}
