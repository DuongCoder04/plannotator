// Source: new in Plannotator after placement, not cut from Workspaces: the `list(query)` read PROVENANCE.md planned against the extract of Workspaces main 7379b0195de140adc00b4496eefe553a3eec803e.
// What the three adapters' `list` share: the query checks, the label rule, and one GraphQL POST.
//
// A list query is checked before any credential is asked: a bad cursor or
// an empty or oversized filter is a `field` answer with no provider call.
// Labels mean "every label" on all three providers. Where a provider's own
// filter is looser (GitHub's filterBy.labels), the adapter narrows the page
// with `hasEveryLabel` after the read; the cursor stays the provider's.

import type { ExternalRefFailure, ReferenceListOrder, ReferenceListQuery } from "./contract.ts";
import type { FetchLike } from "./port.ts";

/** One page of a list: the most a single provider call answers. */
export const LIST_PAGE_SIZE = 100;

const MAX_LABELS = 20;
const MAX_FILTER = 255;
/** Opaque provider cursors (base64, Relay ids): bounded and plain. */
const CURSOR = /^[A-Za-z0-9+/=_:.-]{1,512}$/;

/** A checked list query: trimmed values, defaults applied. */
export interface CheckedListQuery {
	readonly scope: string | undefined;
	readonly host: string | undefined;
	readonly state: "open" | "closed" | "all";
	readonly labels: readonly string[];
	readonly assignee: string | undefined;
	readonly milestone: string | undefined;
	readonly text: string | undefined;
	readonly cursor: string | undefined;
	readonly order: ReferenceListOrder;
}

function filterValue(value: string | undefined): string | undefined | null {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 || trimmed.length > MAX_FILTER ? null : trimmed;
}

/** The query with defaults, or the `field` answer for an input to fix. */
export function checkListQuery(
	query: ReferenceListQuery,
): { ok: true; query: CheckedListQuery } | ExternalRefFailure {
	if (query.cursor !== undefined && !CURSOR.test(query.cursor)) {
		return { ok: false, reason: "not_resolvable", field: "cursor" };
	}
	const labels: string[] = [];
	for (const raw of query.labels ?? []) {
		const label = filterValue(raw);
		if (label === null || label === undefined) {
			return { ok: false, reason: "not_resolvable", field: "filter" };
		}
		labels.push(label);
	}
	const assignee = filterValue(query.assignee);
	const milestone = filterValue(query.milestone);
	const text = query.text === undefined || query.text.trim() === "" ? undefined : filterValue(query.text);
	if (labels.length > MAX_LABELS || assignee === null || milestone === null || text === null) {
		return { ok: false, reason: "not_resolvable", field: "filter" };
	}
	return {
		ok: true,
		query: {
			scope: query.scope?.trim(),
			host: query.host,
			state: query.state ?? "open",
			labels,
			assignee,
			milestone,
			text,
			cursor: query.cursor,
			order: query.order ?? "updated_desc",
		},
	};
}

/** True when `have` carries every label in `want` (case-insensitive). */
export function hasEveryLabel(have: readonly string[], want: readonly string[]): boolean {
	const lower = new Set(have.map((label) => label.toLowerCase()));
	return want.every((label) => lower.has(label.toLowerCase()));
}

/** A GraphQL answer, before the provider-specific reading. */
export type GraphqlPost =
	| { readonly ok: true; readonly data: Record<string, unknown> | null; readonly errors: readonly unknown[] }
	| { readonly ok: false; readonly status: number | null };

/** POST one GraphQL query. A throw is `status: null`; a non-200 is its
 * status; a 200 answers its `data` and `errors`. Never throws. */
export async function postGraphql(
	fetcher: FetchLike,
	url: string,
	headers: Record<string, string>,
	query: string,
	variables: Record<string, unknown>,
): Promise<GraphqlPost> {
	let response: Response;
	try {
		response = await fetcher(url, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify({ query, variables }),
		});
	} catch {
		return { ok: false, status: null };
	}
	if (response.status !== 200) return { ok: false, status: response.status };
	const body = (await response.json().catch(() => null)) as {
		data?: unknown;
		errors?: unknown;
	} | null;
	if (body === null || typeof body !== "object") return { ok: false, status: null };
	const data =
		body.data !== null && typeof body.data === "object" ? (body.data as Record<string, unknown>) : null;
	return { ok: true, data, errors: Array.isArray(body.errors) ? body.errors : [] };
}

/** A plain object, or null. */
export function asObject(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

/** A plain object field, or null. */
export function objectAt(value: unknown, key: string): Record<string, unknown> | null {
	return asObject(asObject(value)?.[key]);
}

/** The nodes of a `{ nodes: [...] }` connection that are objects. */
export function connectionNodes(connection: unknown): Record<string, unknown>[] {
	const nodes = asObject(connection)?.["nodes"];
	if (!Array.isArray(nodes)) return [];
	return nodes.map(asObject).filter((node): node is Record<string, unknown> => node !== null);
}

/** The non-empty strings at `key` of each node of a connection. */
export function connectionNames(connection: unknown, key: string): string[] {
	const names: string[] = [];
	for (const node of connectionNodes(connection)) {
		const name = node[key];
		if (typeof name === "string" && name.length > 0) names.push(name);
	}
	return names;
}

/** `pageInfo` of a connection: the next cursor, if another page exists.
 * `backward` reads a `last`/`before` page (the cursor is its start). */
export function nextCursor(pageInfo: unknown, direction: "forward" | "backward" = "forward"): string | undefined {
	const info = asObject(pageInfo);
	if (info === null) return undefined;
	const more = direction === "forward" ? info["hasNextPage"] : info["hasPreviousPage"];
	const cursor = direction === "forward" ? info["endCursor"] : info["startCursor"];
	return more === true && typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}
