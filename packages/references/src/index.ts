// Source: new barrel for @plannotator/references over the files cut from apps/rooms/src/external-refs and apps/web (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Everything public is exported here; see PROVENANCE.md for each file's source.

export type {
	CodeLinkKind,
	CodeLinkProviderId,
	CodeLinkRef,
	ExternalRef,
	ExternalRefFacts,
	ExternalRefFailure,
	ExternalRefKind,
	ExternalRefState,
	ProviderId,
	PullReads,
	PullRef,
	RefReadAdapter,
	ResolveResult,
	ScopesResult,
	SearchResult,
} from "./contract.ts";
export {
	credentialFor,
	type FetchLike,
	type ProviderCallFields,
	type ProviderCallLog,
	type ReferenceCredential,
	type ReferenceCredentialAnswer,
	type ReferenceCredentialKind,
	type ReferenceCredentialUnavailable,
	type ReferencePort,
} from "./port.ts";
export { DEFAULT_USER_AGENT, externalRefsFetch, providerFetch, providerUserAgent } from "./fetch.ts";
export { parseBranchTail } from "./grammars/git-branch.ts";
export { matchGithubCodeLink, matchGithubUrl, parseGithubCanonical } from "./grammars/github.ts";
export { matchGitlabCodeLink, matchGitlabUrl, parseGitlabCanonical } from "./grammars/gitlab.ts";
export { type LinearItem, matchLinearUrl, parseLinearCanonical } from "./grammars/linear.ts";
export { githubAdapter } from "./adapters/github.ts";
export { githubScopes, githubSearch } from "./adapters/github-pulls.ts";
export {
	fetchPullDiff,
	GITHUB_DIFF_FILE_CEILING,
	listPullFiles,
	type PullDiffResult,
	type PullFilesResult,
	type PullSummary,
	type PullSummaryResult,
	readPullSummary,
} from "./adapters/github-pull-diff.ts";
export { gitlabAdapter } from "./adapters/gitlab.ts";
export { linearAdapter } from "./adapters/linear.ts";
export {
	adapterFor,
	allAdapters,
	createReferenceRegistry,
	matchCodeLinkUrl,
	matchExternalRef,
	matchExternalRefCandidates,
	matchExternalRefUrl,
	REFERENCE_ADAPTERS,
	type ReferenceRegistry,
} from "./registry.ts";
export { integrationPickerPresentation, type ReferencePickerPresentation } from "./picker-modes.ts";
