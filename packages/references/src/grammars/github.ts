// Source: apps/rooms/src/external-refs/github.ts (match, matchCodeLink, parseCanonical) merged with apps/web/src/components/external-refs/match.ts (matchGithub, matchGithubCodeLink) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// The server grammar is kept byte for byte; the client copy accepted the same URLs with the same canonicals, so it is retired, not merged in.
//
// HOSTS: fixed to github.com and www.github.com, exactly as today. A `hosts`
// option (GitHub Enterprise) plugs in at the two host checks below
// (matchGithubUrl and codeLinkSegments) and in the three canonical URL
// templates, which then carry the matched host instead of "github.com".

import type { CodeLinkRef, ExternalRef } from "../contract.ts";
import { parseBranchTail } from "./git-branch.ts";

/** OWNER (user/org login), GitHub's own signup rule: alphanumerics and
 * hyphens only, no leading/trailing hyphen, at most 39 chars. Underscores
 * are repo-only on GitHub: `bad_owner` URLs stay plain links (INT-008). */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
/** REPO segments: GitHub's wider repo charset (letters, digits, `.`, `-`,
 * `_`, including a repo literally named `_`), no dots-only tricks. */
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
/** Item numbers: all digits, sane length. */
const NUMBER = /^[0-9]{1,9}$/;

/**
 * Recognize github.com issue and PR URLs:
 *   https://github.com/{owner}/{repo}/issues/{n}
 *   https://github.com/{owner}/{repo}/pull/{n}
 * Trailing segments (/files, /commits), query, and fragment are display
 * noise: accepted and dropped in the canonical URL. Anything else (repo
 * homes, blobs, commits, other hosts) stays a plain link.
 */
export function matchGithubUrl(url: URL): ExternalRef | null {
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	if (url.port !== "") return null;
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	if (segments.length < 4) return null;
	const [owner, repo, form, number] = segments;
	if (owner === undefined || repo === undefined || form === undefined || number === undefined) {
		return null;
	}
	if (!OWNER.test(owner)) return null;
	if (!SEGMENT.test(repo) || repo === "." || repo === "..") return null;
	if (form !== "issues" && form !== "pull") return null;
	if (!NUMBER.test(number)) return null;
	const n = String(Number(number));
	if (n !== number || n === "0") return null;
	return {
		provider: "github",
		key: `${owner}/${repo}#${n}`,
		url: `https://github.com/${owner}/${repo}/${form}/${n}`,
	};
}

/** Reserved first path segments that are github.com SITE pages, never an
 * owner: the two-segment repo form's denylist. Without it
 * `github.com/orgs/acme` or `github.com/topics/testing` would mint a dead
 * repo link. Maintained, not exhaustive: over-accepting a non-repo page
 * costs one dead association the user deletes, and the OWNER regex already
 * rejects much of the rest. */
const RESERVED_ROOTS = new Set([
	"about",
	"apps",
	"collections",
	"contact",
	"customer-stories",
	"enterprise",
	"explore",
	"features",
	"issues",
	"join",
	"login",
	"marketplace",
	"new",
	"notifications",
	"organizations",
	"orgs",
	"pricing",
	"pulls",
	"security",
	"settings",
	"site",
	"sponsors",
	"topics",
	"trending",
	"users",
	"dashboard",
	"codespaces",
]);

/** Shared host gate for the code-link forms. Answers the path segments or
 * null. `.git` is clone-URL noise stripped from the repo segment on the
 * two-segment repo form only (a `/tree/` or `/pull/` URL never carries it). */
function codeLinkSegments(url: URL): string[] | null {
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	const host = url.hostname.toLowerCase();
	if (host !== "github.com" && host !== "www.github.com") return null;
	if (url.port !== "") return null;
	return url.pathname.split("/").filter((s) => s.length > 0);
}

/**
 * CODE LINK recognition:
 *   repo    https://github.com/{owner}/{repo}          (.git, ?query, # dropped)
 *   branch  https://github.com/{owner}/{repo}/tree/{branch...}  (whole tail)
 *   pr      https://github.com/{owner}/{repo}/pull/{n} (the reference grammar;
 *           /files /commits ?diff=split noise dropped)
 *   issue   https://github.com/{owner}/{repo}/issues/{n} (the same grammar)
 * /blob/..., /commits/..., /releases, and every deeper form answer null: a
 * code link is narrower than a reference.
 */
export function matchGithubCodeLink(url: URL): CodeLinkRef | null {
	const segments = codeLinkSegments(url);
	if (segments === null) return null;

	// The pr and issue forms ride the reference grammar (matchGithubUrl), so
	// the canonical URL is byte-identical to the reference chip's: one
	// resolve-cache identity. An issues-form URL is stored as an issue even
	// when the number is really a pull request (GitHub shares one number
	// space); the resolve then answers `change` for it.
	const ref = matchGithubUrl(url);
	if (ref !== null) {
		const parsed = parseGithubCanonical(ref);
		if (parsed === null) return null;
		return {
			kind: parsed.form === "pull" ? "pr" : "issue",
			repoPath: `${parsed.owner}/${parsed.repo}`,
			number: Number(parsed.n),
			url: ref.url,
		};
	}

	const [owner, repoRaw] = segments;
	if (owner === undefined || repoRaw === undefined) return null;
	if (!OWNER.test(owner)) return null;

	if (segments.length === 2) {
		// Repo home. The denylist keeps site pages out (repo form only: no
		// site page has a /tree/ or /pull/ shape).
		if (RESERVED_ROOTS.has(owner.toLowerCase())) return null;
		const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
		if (!SEGMENT.test(repo) || repo === "." || repo === "..") return null;
		return {
			kind: "repo",
			repoPath: `${owner}/${repo}`,
			url: `https://github.com/${owner}/${repo}`,
		};
	}

	if (segments.length >= 4 && segments[2] === "tree") {
		if (!SEGMENT.test(repoRaw) || repoRaw === "." || repoRaw === "..") return null;
		const tail = parseBranchTail(segments.slice(3));
		if (tail === null) return null;
		return {
			kind: "branch",
			repoPath: `${owner}/${repoRaw}`,
			branch: tail.branch,
			url: `https://github.com/${owner}/${repoRaw}/tree/${tail.canonicalTail}`,
		};
	}

	return null;
}

/** Re-parse the grammar's OWN canonical URL (match built it) at resolve
 * time: the URL form picks the REST endpoint. */
export function parseGithubCanonical(
	ref: ExternalRef,
): { owner: string; repo: string; form: "issues" | "pull"; n: string } | null {
	let url: URL;
	try {
		url = new URL(ref.url);
	} catch {
		return null;
	}
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	const [owner, repo, form, n] = segments;
	if (owner === undefined || repo === undefined || n === undefined) return null;
	if (form !== "issues" && form !== "pull") return null;
	return { owner, repo, form, n };
}
