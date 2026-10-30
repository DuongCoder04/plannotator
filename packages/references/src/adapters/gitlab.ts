// Source: apps/rooms/src/external-refs/gitlab.ts (resolve, headers, state mapping, the adapter object) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Cut: the form connect (baseUrl normalization, the /api/v4/user probe) and the sealed-secret parsing; the port supplies the token and its host.
//
// The GitLab adapter, read side: gitlab.com issues and merge requests,
// resolved over plain REST. createGitlabAdapter({ hosts }) also serves
// self-managed instances; each item reads its own host's API.
//
// PUBLIC RUNG ON: public gitlab.com projects answer with no credential at
// all ("return only public data when authentication isn't provided"), and
// an unauthenticated private project answers 404: existence hidden, mapped
// straight to not_linked.
//
// Verified against GitLab docs (2026-07-22):
//   REST + %2F path encoding: https://docs.gitlab.com/api/rest/
//   auth (PRIVATE-TOKEN):     https://docs.gitlab.com/api/rest/authentication/
//   issues (opened|closed):   https://docs.gitlab.com/api/issues/
//   MRs (opened|closed|merged|locked): https://docs.gitlab.com/api/merge_requests/

import type {
	ExternalRef,
	ExternalRefFacts,
	ExternalRefState,
	RefReadAdapter,
	ResolveResult,
} from "../contract.ts";
import { providerFetch, providerUserAgent } from "../fetch.ts";
import {
	type GitlabGrammar,
	gitlabGrammar,
	type GitlabHostsOptions,
	parseGitlabCanonical,
} from "../grammars/gitlab.ts";
import { servedHost, type ServedHosts } from "../hosts.ts";
import { credentialFor, type ReferenceCredential, type ReferencePort } from "../port.ts";

/** The origin a GitLab item host serves its API from: the host itself
 * (`/api/v4` and `/api/graphql` live under it). A port that binds its
 * fetch to the API origin reads the origin from here. */
export function gitlabApiBase(host: string): string {
	return `https://${host}`;
}

/** PRIVATE-TOKEN is the documented header for personal, group and project
 * access tokens (any `read_api` token). A `bearer` credential (an OAuth
 * token, such as glab's) rides `Authorization: Bearer`. */
function gitlabHeaders(userAgent: string, credential?: ReferenceCredential): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"user-agent": userAgent,
	};
	if (credential?.kind === "private-token") headers["PRIVATE-TOKEN"] = credential.token;
	if (credential?.kind === "bearer") headers.authorization = `Bearer ${credential.token}`;
	return headers;
}

// ── state mapping (GitLab's own words, three tones) ─────────────────────────

function gitlabState(state: string): ExternalRefState | null {
	if (state === "opened") return { label: "Open", tone: "open" };
	if (state === "closed") return { label: "Closed", tone: "closed" };
	if (state === "merged") return { label: "Merged", tone: "done" };
	// Rare and transitional: the MR is neither resolved nor rejected.
	if (state === "locked") return { label: "Locked", tone: "open" };
	return null;
}

interface GitlabItemPayload {
	title?: unknown;
	state?: unknown;
	author?: { username?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── resolve ─────────────────────────────────────────────────────────────────

async function resolveGitlab(
	served: ServedHosts,
	ref: ExternalRef,
	port: ReferencePort,
): Promise<ResolveResult> {
	const parsed = parseGitlabCanonical(ref);
	if (parsed === null) return { ok: false, reason: "not_resolvable" };
	// The canonical URL's host picks the API and the credential; a ref on a
	// host this adapter does not serve is never read.
	const host = servedHost(served, parsed.host);
	if (host === null) return { ok: false, reason: "not_resolvable" };

	// The ladder: a credential whose host IS this URL's host reads with its
	// token; everything else (no credential, or a credential for another
	// instance, which credentialFor drops) rides the public rung
	// unauthenticated: the credential never leaves its own instance.
	const credential = await credentialFor(port, "gitlab", host, ["private-token", "bearer"]);
	if (credential !== null && credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const token = credential ?? undefined;
	// The item host's own API, with or without a token (credentialFor only
	// returns a credential whose host is this host).
	const base = gitlabApiBase(host);

	// The namespaced-path rule: the whole project path, URL-encoded, is the id.
	const endpoint =
		`${base}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/` +
		`${parsed.form}/${parsed.iid}`;

	let response: Response;
	try {
		response = await providerFetch(port)(endpoint, {
			headers: gitlabHeaders(providerUserAgent(port), token),
		});
	} catch {
		return { ok: false, reason: "not_resolvable" };
	}
	// 401 with a token = the token is dead (revoked/expired): the reconnect
	// signal. 404 = private/uncovered/gone (GitLab hides existence, so do we).
	if (response.status === 401 && token !== undefined) {
		return { ok: false, reason: "not_resolvable", credentialDead: true };
	}
	if (response.status === 404 || response.status === 401 || response.status === 403) {
		return { ok: false, reason: "not_linked" };
	}
	if (response.status !== 200) {
		return { ok: false, reason: "not_resolvable" };
	}
	const payload = (await response.json().catch(() => null)) as GitlabItemPayload | null;
	const title = str(payload?.title);
	const stateWord = str(payload?.state);
	const state = stateWord === undefined ? null : gitlabState(stateWord);
	if (payload === null || title === undefined || state === null) {
		return { ok: false, reason: "not_resolvable" };
	}

	const leaf = parsed.projectPath.split("/").pop() ?? parsed.projectPath;
	const isIssue = parsed.form === "issues";
	const facts: ExternalRefFacts = {
		ref,
		kind: isIssue ? "issue" : "change",
		shortId: `${leaf}${isIssue ? "#" : "!"}${parsed.iid}`,
		title,
		state,
		author: str(payload.author?.username),
		createdAt: str(payload.created_at),
		updatedAt: str(payload.updated_at),
	};
	return { ok: true, facts };
}

function buildGitlabAdapter(grammar: GitlabGrammar): RefReadAdapter {
	return {
		kindOf: (ref) => (new URL(ref.url).pathname.includes("/merge_requests/") ? "change" : "issue"),
		provider: "gitlab",
		match: grammar.match,
		matchCodeLink: grammar.matchCodeLink,
		resolve: (ref, port) => resolveGitlab(grammar.served, ref, port),
	} satisfies RefReadAdapter;
}

/** A GitLab adapter serving gitlab.com plus `options.hosts` (self-managed
 * instances). Each host reads its own API with a credential asked for that
 * host. Throws a TypeError for a host that is not a bare hostname. */
export function createGitlabAdapter(options: GitlabHostsOptions = {}): RefReadAdapter {
	return buildGitlabAdapter(gitlabGrammar(options));
}

/** The gitlab.com adapter. */
export const gitlabAdapter: RefReadAdapter = buildGitlabAdapter(gitlabGrammar());
