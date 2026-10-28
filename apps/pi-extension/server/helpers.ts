/**
 * Core HTTP helpers for Pi extension servers.
 * parseBody, parseJsonBody, json, handleApiNotFound, html, send, toWebRequest
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { prepareAppHtml } from "../generated/app-html.ts";
import { openPackedApp } from "../generated/packed-app.ts";

/** The raw request body as text (for endpoints where an empty body is meaningful, e.g. all-optional JSON). */
export function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk: string) => (data += chunk));
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

export async function parseBody(
	req: IncomingMessage,
): Promise<Record<string, unknown>> {
	try {
		return JSON.parse(await readBody(req));
	} catch {
		return {};
	}
}

/**
 * Decode a request body as JSON and reject malformed input.
 *
 * Use this for endpoints where an empty object is a valid command and parse
 * failure must remain distinguishable from that command. Legacy endpoints
 * continue to use {@link parseBody}, which deliberately falls back to `{}`.
 */
export async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
	return JSON.parse(await readBody(req));
}

export function json(
	res: import("node:http").ServerResponse,
	data: unknown,
	status = 200,
): void {
	res.writeHead(status, { "Content-Type": "application/json" });
	res.end(JSON.stringify(data));
}

/** Return the shared JSON response for an unmatched API route. */
export function handleApiNotFound(
	res: import("node:http").ServerResponse,
	path: string,
): void {
	json(res, { error: "Not found", path }, 404);
}

/**
 * Serve the single-file app HTML, compressed when the session is remote and the
 * client accepts br/gzip (#1617); local sessions get the page unchanged. Negotiation and the per-process compression cache are shared with
 * the Bun servers via generated/app-html.ts; identity sends the string as-is.
 */
export async function html(
	req: IncomingMessage,
	res: import("node:http").ServerResponse,
	content: string,
	compress: boolean,
): Promise<void> {
	const prepared = await prepareAppHtml(content, req.headers["accept-encoding"], compress);
	res.writeHead(200, prepared.headers);
	res.end(prepared.body);
}

/**
 * Serve the built app to every route no handler claimed: one of the chunks and
 * assets packed into it, or else the page itself (SPA). Mirrors
 * createAppHandler in packages/server/shared-handlers.ts.
 */
export function createAppHandler(
	htmlContent: string,
): (req: IncomingMessage, res: ServerResponse, url: URL, compress: boolean) => Promise<void> {
	const app = openPackedApp(htmlContent);
	return async (req, res, url, compress) => {
		const asset = app.asset(url.pathname, req.headers["accept-encoding"]);
		if (asset) send(res, asset.body, 200, asset.headers);
		else await html(req, res, app.html, compress);
	};
}

export function send(
	res: import("node:http").ServerResponse,
	body: string | Buffer,
	status = 200,
	headers: Record<string, string> = {},
): void {
	res.writeHead(status, headers);
	res.end(body);
}

export function requestUrl(req: IncomingMessage): URL {
	return new URL(req.url ?? "/", "http://localhost");
}

export function toWebRequest(req: IncomingMessage): Request {
	const headers = new Headers();
	for (const [key, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		if (Array.isArray(value)) {
			for (const item of value) headers.append(key, item);
		} else {
			headers.set(key, value);
		}
	}

	const init: RequestInit & { duplex?: "half" } = {
		method: req.method,
		headers,
	};

	if (req.method !== "GET" && req.method !== "HEAD") {
		init.body = Readable.toWeb(req) as unknown as BodyInit;
		init.duplex = "half";
	}

	return new Request(`http://localhost${req.url ?? "/"}`, init);
}
