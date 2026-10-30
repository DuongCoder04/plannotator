# @plannotator/references

The read side of the external references layer: turn a provider URL into a
typed reference, and resolve that reference into live title and state facts.
It carries one URL grammar per provider, a read-side registry, and read
adapters for GitHub, GitLab and Linear. Every provider call goes through one
small credential port that the host app supplies.

The code was cut from the Workspaces references layer. Types and names match
the Workspaces originals so Workspaces can adopt the package by re-import.

## What is in it

| Module | What it does |
| --- | --- |
| `contract.ts` | `ExternalRef`, `ExternalRefFacts`, `ExternalRefState`, `ResolveResult`, `SearchResult`, `ScopesResult`, the code-link types, and `RefReadAdapter` (the read half of the adapter interface). |
| `port.ts` | `ReferencePort`, `ReferenceCredential` and `credentialFor`. |
| `fetch.ts` | The outbound fetch policy: ten-second deadline, same-origin redirects only (at most 20), one log line with host, status and duration. |
| `grammars/` | `github.ts`, `gitlab.ts`, `linear.ts`: URL recognition and canonical URLs. `git-branch.ts`: the branch-tail rules for code links. Pure functions, no fetch. |
| `adapters/` | `github.ts` (resolve), `github-pulls.ts` (search, scopes), `github-pull-diff.ts` (pull summary, pinned diff, file list), `gitlab.ts` (resolve), `linear.ts` (resolve). |
| `registry.ts` | `createReferenceRegistry(adapters)` and a default registry over the three adapters: `adapterFor`, `matchExternalRef`, `matchExternalRefCandidates`, `matchCodeLinkUrl`, `matchExternalRefUrl`. |
| `picker-modes.ts` | The picker presentation rows for GitHub and Linear. GitLab falls to the paste default. |

Hosts are fixed: `github.com`, `gitlab.com`, `linear.app` (each with its
`www.` form). Self-managed GitLab and GitHub Enterprise URLs stay plain links.

## Quick use

```ts
import { matchExternalRef, type ReferencePort } from "@plannotator/references";

const port: ReferencePort = {
  fetch,
  async credential(provider, host) {
    // Return a token for this provider and host, or null.
    return null;
  },
};

const found = matchExternalRef(new URL("https://github.com/acme/api/issues/482"));
if (found) {
  const result = await found.adapter.resolve(found.ref, port);
  // result.ok ? result.facts : result.reason ("not_linked" | "not_resolvable")
}
```

Adapters answer and never throw. A failure is `{ ok: false, reason }`, with
`credentialDead: true` when the provider proved the credential dead, and
`rateLimited: true` when GitHub rate-limited the read (403 or 429).

## The port

```ts
interface ReferencePort {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  credential(provider: ProviderId, host: string): Promise<ReferenceCredentialAnswer>;
  /** user-agent on GitHub and GitLab calls; default "plannotator-workspaces". */
  userAgent?: string;
  /** the one line per provider call; default console.info. */
  log?: (event: "external_ref_provider_call", fields: { host: string; status: number | undefined; duration_ms: number }) => void;
}

type ReferenceCredentialAnswer =
  | { kind: "installation" | "bearer" | "private-token" | "linear-api-key"; token: string; host: string; account?: string }
  | { kind: "unavailable"; credentialDead: boolean }
  | null;
```

An adapter asks for a credential with the provider id and the host of the
canonical URL it is resolving (`"github.com"`, `"gitlab.com"`, `"linear.app"`).

| Provider | Kinds it sends | Header | No credential (`null`) |
| --- | --- | --- | --- |
| GitHub | `installation`, `bearer` | `Authorization: Bearer` | resolve reads `api.github.com` anonymously; search, scopes and pull reads answer `not_linked` |
| GitLab | `private-token`, `bearer` | `PRIVATE-TOKEN`, or `Authorization: Bearer` | resolve reads `gitlab.com` anonymously |
| Linear | `bearer` or `linear-api-key` (each with `account`) | `Authorization: Bearer`, or the bare `Authorization: <key>` | `not_linked`, with no fetch |

Rules the adapters apply to every answer (`credentialFor` in `port.ts`):

- A credential whose `host` differs from the host asked for is never used.
- A credential of a kind the provider cannot send, or with an empty token, is never used.
- `{ kind: "unavailable", credentialDead }` becomes `not_resolvable` with that `credentialDead`, and no provider fetch runs.
- A port that throws reads as `unavailable` with `credentialDead: false`.
- GitHub `scopes` lists `GET /installation/repositories`, so it needs an `installation` token. A `bearer` token answers `not_linked`.
- Linear needs `account`: the workspace urlKey the token belongs to. A Linear URL on any other workspace answers `not_linked` with no fetch. Linear answers `issue(id: "ENG-1")` inside the token's own workspace, so without this check a foreign workspace's URL would show your workspace's issue.

The port's `fetch` is wrapped by `fetch.ts` on every call. Redirects to
another origin are returned, not followed, so a credential header never
leaves the origin it was sent to. Each call writes one line to the port's
`log` (host, status and duration only); a `log` that throws is ignored.
Each product names itself with `userAgent`; the adapters hold no product
names.

## How each product backs the port

**Workspaces** backs it with its connection store and its own provider apps:

- GitHub: the org's connection mints a one-hour installation token from the
  deployment's GitHub App and answers `installation`. With no connection it
  mints from the App's home installation, if the deployment has one. A home
  installation that fails to mint answers `null`, so public repos still
  resolve anonymously. An org installation that answers 404 on mint answers
  `{ kind: "unavailable", credentialDead: true }`.
- GitLab: the org's sealed `{ baseUrl, token }`, opened per call, answered
  as `private-token` with `host` set to the base URL's hostname. A secret that
  will not open or parse answers `unavailable` with `credentialDead: true`.
- Linear: the org's OAuth credential. The port refreshes a lapsed access
  token (single-flight, the rotated pair persisted before use) and answers
  `bearer` with `account` set to the installed workspace urlKey. A refresh
  refused with 400 or 401 answers `credentialDead: true`; a network failure,
  429 or 5xx answers `credentialDead: false`.
- Workspaces keeps its insider rule (only organization members get the
  connection credential; guests get `null`), its resolve cache, and the
  `broken_at` stamp it writes when an answer carries `credentialDead: true`.

**The local Inbox** backs it with borrowed credentials:

- GitHub: `gh auth token --hostname H` for a host gh is signed in to,
  answered as `bearer`.
- GitLab: glab's stored token for a host glab is signed in to, answered as
  `private-token` or `bearer` according to how glab stored it.
- Linear: none in v1. A later typed personal key is answered as `linear-api-key`, with `account` set to its workspace urlKey (see below).
- The host gate is the port's job: hand out a credential only for a host
  the CLI is signed in to, and bind the port's `fetch` to that host. A
  planted `origin` must not be able to send a token anywhere else. The
  adapters check the host they asked for, but they cannot know which hosts
  the CLI is signed in to.

Linear personal API keys are sent without the `Bearer` prefix (Linear's
OAuth tokens take it), so they have their own kind: `linear-api-key` sends
the bare `Authorization: <key>`, and `bearer` always adds the prefix. Both
need `account`. GitHub and GitLab never send a `linear-api-key`.

## What is deliberately not in it

- The connect side of every adapter: OAuth redirect steps, PKCE, region
  tables, the GitHub App JWT and token mint, Linear's refresh and rotation,
  form probes, and anything that reads deployment env or an app origin.
- Credential storage and sealing, the resolve cache, the insider rule, HTTP
  routes, the MCP tool, and the live API contract. They stay in Workspaces.
- The other 30 Workspaces adapters (Bitbucket, Atlassian, Slack and the
  rest).
- The web client's text scanners (`findExternalRefUrls` and the
  sentence-punctuation rules) and its string form of the code-link matcher.
- A `hosts` option for self-managed instances, and a filtered `list` query
  with labels, assignees and milestone facts. These are the next additions;
  `PROVENANCE.md` names where each one plugs in.

## Development

The package lives in the Plannotator monorepo at `packages/references`.

```sh
bun install          # at the repo root
bun run typecheck    # in this folder: tsc over src (strict) and over src + test
bun test             # in this folder; the root `bun test` runs the same files
```

Tests fake providers at the port's `fetch` only, with low-entropy fixture
values. One test is a tripwire: no source file may read env, mint a JWT, or
import anything but relative modules and `@plannotator/core/diff-paths`.

The only runtime dependency is `@plannotator/core`, for the git path quoting
in `diff-paths` that the pull request diff uses.
