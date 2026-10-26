/**
 * Annotate's live app mode never proxies a Plannotator server (Pi side; the
 * Bun mirror is packages/server/live-proxy-plannotator.test.ts).
 *
 * Over the vendored modules the Pi extension runs: the Pi servers mark their
 * responses and refuse a request the live proxy forwarded; the probe refuses
 * a target by port (the data dir's registries) and by the Plannotator server
 * header, and `--app` says so; the node:http proxy refuses the editor's own
 * port and never lets a proxied same-origin write reach a scratch Inbox or a
 * Pi annotate server.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startInboxServer, type InboxServer } from "../../../packages/server/inbox";
import { buildForceAppFailureMessage, probeLiveAppTarget } from "../generated/live-probe.ts";
import { LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE, type LiveAppProxy } from "../generated/live-proxy-core.ts";
import { startLiveAppProxyNode } from "../generated/live-proxy-node.ts";
import { listPlannotatorServerPorts } from "../generated/plannotator-ports.ts";
import {
	LIVE_PROXIED_REFUSED_CODE,
	PLANNOTATOR_LIVE_PROXY_HEADER,
	PLANNOTATOR_SERVER_HEADER,
} from "../generated/plannotator-server-marker.ts";
import { startAnnotateServer } from "./serverAnnotate.ts";

const MINIMAL_HTML = "<html><body>editor</body></html>";
const KEYS = ["PLANNOTATOR_DATA_DIR", "PLANNOTATOR_PORT", "PLANNOTATOR_REMOTE", "PLANNOTATOR_AI", "PLANNOTATOR_INBOX_CONNECT"] as const;
const saved: Record<string, string | undefined> = {};
let root: string;
let dataDir: string;
const cleanups: (() => void | Promise<void>)[] = [];

beforeEach(() => {
	for (const key of KEYS) saved[key] = process.env[key];
	root = realpathSync(mkdtempSync(join(tmpdir(), "plannotator-pi-live-plannotator-")));
	dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	process.env.PLANNOTATOR_DATA_DIR = dataDir;
	process.env.PLANNOTATOR_REMOTE = "0";
	process.env.PLANNOTATOR_AI = "disabled";
	process.env.PLANNOTATOR_INBOX_CONNECT = "0";
	delete process.env.PLANNOTATOR_PORT;
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	for (const key of KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(root, { recursive: true, force: true });
});

async function scratchInbox(): Promise<InboxServer> {
	const server = await startInboxServer({ dataDir, binaryPath: null, phones: false });
	cleanups.push(() => server.stop());
	return server;
}

async function piAnnotate() {
	const server = await startAnnotateServer({ markdown: "# T", filePath: join(root, "t.md"), htmlContent: MINIMAL_HTML });
	cleanups.push(() => server.stop());
	return server;
}

async function proxyTo(targetUrl: string): Promise<LiveAppProxy> {
	const proxy = await startLiveAppProxyNode({
		targetUrl,
		editorOrigins: ["http://localhost:1", "http://127.0.0.1:1"],
		bridgeJs: "/* bridge */",
	});
	cleanups.push(() => proxy.stop());
	return proxy;
}

function proxiedPost(proxy: LiveAppProxy, path: string, body: unknown): Promise<Response> {
	return fetch(`http://127.0.0.1:${proxy.port}${path}`, {
		method: "POST",
		headers: {
			Host: `localhost:${proxy.port}`,
			Origin: `http://localhost:${proxy.port}`,
			"Sec-Fetch-Site": "same-origin",
			"Sec-Fetch-Mode": "cors",
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
}

function readConfig(): string | null {
	try {
		return readFileSync(join(dataDir, "config.json"), "utf8");
	} catch {
		return null;
	}
}

describe("pi: annotate's live app mode never proxies a Plannotator server", () => {
	test("the Pi annotate server marks its responses and refuses a proxied request", async () => {
		const server = await piAnnotate();
		const page = await fetch(`${server.url}/`);
		expect(page.headers.get(PLANNOTATOR_SERVER_HEADER)).not.toBeNull();
		const proxied = await fetch(`${server.url}/api/plan`, { headers: { [PLANNOTATOR_LIVE_PROXY_HEADER]: "1" } });
		expect(proxied.status).toBe(403);
		expect(proxied.headers.get("x-plannotator-error")).toBe(LIVE_PROXIED_REFUSED_CODE);
	});

	test("the probe refuses by registry port before any request, and by the header", async () => {
		const inbox = await scratchInbox();
		const byPort = `http://localhost:${inbox.port}/`;
		let requests = 0;
		const counting = (async () => {
			requests += 1;
			return new Response("<html></html>", { headers: { "Content-Type": "text/html" } });
		}) as unknown as typeof fetch;
		const portProbe = await probeLiveAppTarget(byPort, new URL(byPort), counting, {
			plannotatorPorts: listPlannotatorServerPorts(dataDir),
		});
		expect(portProbe).toMatchObject({ liveEligible: false, plannotator: true });
		expect(requests).toBe(0);

		// A Pi server is in no registry: its header decides.
		const pi = await piAnnotate();
		const headerProbe = await probeLiveAppTarget(`${pi.url}/`, new URL(`${pi.url}/`));
		expect(headerProbe).toMatchObject({ liveEligible: false, plannotator: true, probeError: null });
		expect(buildForceAppFailureMessage(`${pi.url}/`, headerProbe)).toContain("is a Plannotator server");
	});

	test("the node proxy refuses the editor's own port at start", async () => {
		await expect(
			startLiveAppProxyNode({
				targetUrl: "http://127.0.0.1:4100/",
				editorOrigins: ["http://localhost:4100", "http://127.0.0.1:4100"],
				bridgeJs: "",
			}),
		).rejects.toThrow(/never proxies a Plannotator server/);
	});

	test("a proxied same-origin write never reaches a scratch Inbox", async () => {
		const inbox = await scratchInbox();
		const before = readConfig();
		const proxy = await proxyTo(`http://127.0.0.1:${inbox.port}/`);
		const write = await proxiedPost(proxy, "/api/inbox/settings", { serverSession: inbox.serverSession, text_size: 12 });
		expect(write.status).toBe(502);
		expect(await write.text()).toBe(LIVE_PROXY_PLANNOTATOR_UPSTREAM_MESSAGE);
		expect(readConfig()).toBe(before);
	});

	test("a proxied same-origin write never reaches a Pi annotate server", async () => {
		const server = await piAnnotate();
		const proxy = await proxyTo(`${server.url}/`);
		const write = await proxiedPost(proxy, "/api/config", { agentTool: true });
		expect(write.status).toBe(502);
		expect(readConfig() ?? "").not.toContain("agentTool");
	});
});
