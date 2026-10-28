/**
 * Which forge a git remote lives on, and where bare `#123` / `@user`
 * references in a document should link to (#1596).
 *
 * Browser-safe and dependency-free: the UI resolves ref links with it, and the
 * server-side commit-avatar lookup classifies remotes with the same rule.
 */

export type ForgePlatform = "github" | "gitlab";

/**
 * Canonicalize a remote host before classifying it: lowercase, drop a port,
 * and fold the well-known aliases of the public forges (`www.github.com`,
 * `ssh.github.com`, SSH-config aliases like `github.com-work`,
 * `altssh.gitlab.com`) onto their canonical host. Returns null for anything
 * that is not a plausible DNS name (no dot, brackets, `@`, ...): such a host
 * is a local SSH alias or a parse artifact that says nothing reliable about
 * the forge, so callers treat it as absent.
 */
export function normalizeForgeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (h === "www.github.com" || h === "ssh.github.com" || h.startsWith("github.com-")) {
    h = "github.com";
  } else if (h === "altssh.gitlab.com") {
    h = "gitlab.com";
  }
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return null;
  return h;
}

/**
 * Classify a remote host by name: exact/prefix github is GitHub (github.com
 * and GitHub Enterprise hosts like `github.acme.com`); gitlab.com, `gitlab.*`
 * and `*.gitlab.*` are GitLab. A structured match, not a bare substring:
 * `mygitlabproxy.example.com` does not qualify. Opaque self-hosted names
 * return null.
 */
export function classifyForgeHost(host: string): ForgePlatform | null {
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.") || host.includes(".gitlab.")) {
    return "gitlab";
  }
  return null;
}

export interface ForgeRefLinks {
  issue(num: string | number): string;
  user(handle: string): string;
}

/**
 * Link builders for inline issue and mention refs, or null when refs should
 * render unlinked.
 *
 * - `display` without a `/` (a directory-name fallback, not a remote path) → null.
 * - `host` absent, or not a plausible DNS name after `normalizeForgeHost`
 *   → github.com, the behavior before hosts were known (older servers, host
 *   apps that pass no host, and SSH aliases like `git@work-gh:o/r`).
 * - GitHub-like host → `https://<host>/<path>/issues/N`.
 * - GitLab-like host → `https://<host>/<path>/-/issues/N`.
 * - Any other host → null: a wrong-forge link is worse than no link.
 */
export function forgeRefLinks(repo: { display?: string; host?: string }): ForgeRefLinks | null {
  const path = repo.display;
  if (!path || !path.includes("/")) return null;
  const host = normalizeForgeHost(repo.host) ?? "github.com";
  const platform = classifyForgeHost(host);
  if (!platform) return null;
  const base = `https://${host}`;
  const issues = platform === "gitlab" ? `${base}/${path}/-/issues` : `${base}/${path}/issues`;
  return {
    issue: (num) => `${issues}/${num}`,
    user: (handle) => `${base}/${handle}`,
  };
}

/**
 * A cross-repo `owner/repo#123` ref: GitHub's standard form, and GitLab's
 * `group/project#123`. The lookbehind keeps a match out of the middle of a
 * longer path or URL (`a/owner/repo#1`, `x.owner/repo#1`).
 */
export const CROSS_REPO_REF_PATTERN = /(?<![\w./-])([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})(?!\w)/;
const CROSS_REPO_REF_AT_START = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})(?!\w)/;

/**
 * A repo part that reads as a file, so `docs/guide.md#2` or `src/app.ts#12`
 * is a path with a fragment, not a ref. `.js` is left out on purpose: repos
 * such as `vercel/next.js` and `mrdoob/three.js` are named that way.
 */
const FILE_LIKE_REPO =
  /\.(?:mdx?|markdown|txt|html?|rst|adoc|[cm]?ts|tsx|jsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|dart|ex|exs|vue|svelte|astro|zig|proto|lock|log|csv|pdf|png|jpe?g|gif|svg)$/i;

export interface CrossRepoRef {
  /** The ref as written: `owner/repo#123`. */
  label: string;
  /** Where it links, or null when no link can be built (an unknown self-hosted forge). */
  href: string | null;
}

/**
 * Read an `owner/repo#123` ref at the start of `text`, or null. `previousChar`
 * is the character before `text` (empty at the start): a ref never continues
 * a word, path or URL.
 *
 * The link follows `forgeRefLinks`' host rule for the document's project: its
 * host when that is GitHub or GitLab, github.com when there is no remote, and
 * no link for an unknown self-hosted host. GitHub redirects `/issues/N` to
 * `/pull/N`, so one URL serves both.
 */
export function matchCrossRepoRef(
  text: string,
  previousChar: string,
  project: { host?: string },
): CrossRepoRef | null {
  if (previousChar && /[\w./-]/.test(previousChar)) return null;
  const m = text.match(CROSS_REPO_REF_AT_START);
  if (!m) return null;
  const [label, owner, repo, number] = m;
  if (/^\.+$/.test(owner) || /^\.+$/.test(repo) || FILE_LIKE_REPO.test(repo)) return null;
  const href = forgeRefLinks({ display: `${owner}/${repo}`, host: project.host })?.issue(number) ?? null;
  return { label, href };
}

/**
 * Index of the first `owner/repo#123` ref in `text` after index 0 and before
 * `end`, or -1. A plain-text scanner splits its chunk there, so the ref is
 * read whole before path detection can take `owner/repo` for a file.
 */
export function findCrossRepoRef(text: string, end: number, project: { host?: string }): number {
  // A ref is at most 212 characters, so one that starts before `end` lies in
  // this window (plus one for the lookahead): the scan stays linear.
  const window = text.slice(0, end + 213);
  const re = new RegExp(CROSS_REPO_REF_PATTERN.source, "g");
  re.lastIndex = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null && m.index < end) {
    if (matchCrossRepoRef(text.slice(m.index), text[m.index - 1] ?? "", project)) return m.index;
    re.lastIndex = m.index + 1;
  }
  return -1;
}
