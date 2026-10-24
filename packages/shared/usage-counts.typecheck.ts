/**
 * Type checks for the usage-counts recorder, checked by `bun run typecheck`
 * (packages/shared/tsconfig.json includes this file; it is never imported).
 * An `@ts-expect-error` that stops erroring fails the typecheck, so these
 * prove a caller can name only a registry event of its own feature, and never
 * one of the two local facts.
 */
import { recordUsageCount } from "./usage-counts";

export function usageCountsTypeChecks(): void {
  recordUsageCount("decisionMode", "opened");
  recordUsageCount("decisionMode", "active_day");
  // @ts-expect-error not an event of the feature
  recordUsageCount("decisionMode", "nope");
  // @ts-expect-error a local fact is never recorded by a caller
  recordUsageCount("decisionMode", "first_day");
  // @ts-expect-error a local fact is never recorded by a caller
  recordUsageCount("decisionMode", "days_last7");
  // @ts-expect-error not a counted feature
  recordUsageCount("editSuggestions", "opened");
  // @ts-expect-error no free text rides along
  recordUsageCount("decisionMode", "opened", "extra");
}
