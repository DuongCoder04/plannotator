import type { DiffType } from "./review-core";
import type {
  ProviderReviewOpenStateInput,
  ReviewOpenState,
} from "./review-open-state";

export interface LegacyReviewDefaultAdapter {
  resolve(value: unknown): DiffType | undefined;
}

export interface VcsReviewPolicy {
  readonly defaultDiffType: DiffType;
  ownsDiffType(diffType: string): diffType is DiffType;
  readonly legacyDefault?: LegacyReviewDefaultAdapter;
  resolveDefault(value: unknown): DiffType | undefined;
  resolveOpenState(input: ProviderReviewOpenStateInput): ReviewOpenState;
  resolveInitialBase(
    defaultBase: string,
    diffType: DiffType,
    requestedBase: string | undefined,
    ownsRequestedDiffType: boolean,
  ): string;
}

export function resolveProviderReviewDefault(
  policy: VcsReviewPolicy,
  configuredValue: unknown,
  legacyValue: unknown,
): DiffType {
  // A provider with a legacy key (Git: `diffOptions.defaultDiffType`) keeps
  // that key as its saved value: every Plannotator version reads and writes
  // it, so it cannot go stale behind a newer per-provider copy.
  return policy.legacyDefault?.resolve(legacyValue)
    ?? policy.resolveDefault(configuredValue)
    ?? policy.defaultDiffType;
}
