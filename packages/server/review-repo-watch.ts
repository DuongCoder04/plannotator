import { isAbsolute, relative } from "path";
import {
	createFileBrowserWatchRegistry,
	type FileBrowserChangeEvent,
	type FileBrowserWatchRegistry,
} from "@plannotator/shared/file-browser-watch-core";
import { isRepoWatchIgnored } from "@plannotator/shared/repo-files";
import { getGitMetadataWatchPaths } from "@plannotator/shared/workspace-status";

// The code-review tree's live All files (`GET /api/repo-files/stream`): the
// repository root is watched with the same engine as annotate's file browser
// (deferred warmup, reconnect grace, native recursive fs.watch on macOS and
// Windows, chokidar on Linux). An event tells the server its listing is stale
// and tells the page to list again; the diff itself never redraws by itself.

const HEARTBEAT_MS = 30_000;
/** Live updates are debounced so a burst of writes lists the tree once. */
const REPO_WATCH_DEBOUNCE_MS = 500;
const encoder = new TextEncoder();

interface Subscriber {
	controller: ReadableStreamDefaultController;
	onChange: () => void;
}

export interface ReviewRepoWatch {
	/** The SSE response for one page: `ready` once, then `changed` after each settled burst. */
	stream(root: string, onChange: () => void, disableIdleTimeout?: () => void): Response;
	closeAll(): void;
	/** Tests only. */
	configureForTests: FileBrowserWatchRegistry<Subscriber>["configureForTests"];
}

function serialize(event: Pick<FileBrowserChangeEvent, "type" | "reason" | "timestamp">): Uint8Array {
	return encoder.encode(`data: ${JSON.stringify({ type: event.type, reason: event.reason, timestamp: event.timestamp })}\n\n`);
}

export function createReviewRepoWatch(): ReviewRepoWatch {
	const registry = createFileBrowserWatchRegistry<Subscriber>({
		send: (subscriber, event) => {
			try {
				subscriber.onChange();
				subscriber.controller.enqueue(serialize(event));
				return true;
			} catch {
				return false;
			}
		},
		getGitMetadataWatchPaths,
		debounceMs: REPO_WATCH_DEBOUNCE_MS,
	});

	return {
		stream(root, onChange, disableIdleTimeout) {
			disableIdleTimeout?.();
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
			let subscriber: Subscriber | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			const stream = new ReadableStream({
				start(controller) {
					subscriber = { controller, onChange };
					registry.attach(handle, subscriber, root);
					controller.enqueue(serialize({ type: "ready", reason: "initial", timestamp: Date.now() }));
					heartbeat = setInterval(() => {
						try {
							controller.enqueue(encoder.encode(": heartbeat\n\n"));
						} catch {
							if (subscriber) registry.release(handle, subscriber);
							if (heartbeat) clearInterval(heartbeat);
						}
					}, HEARTBEAT_MS);
				},
				cancel() {
					if (heartbeat) clearInterval(heartbeat);
					if (subscriber) registry.release(handle, subscriber);
				},
			});
			return new Response(stream, {
				headers: {
					"Content-Type": "text/event-stream",
					"Cache-Control": "no-cache",
					Connection: "keep-alive",
				},
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
