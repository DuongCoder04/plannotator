import { describe, expect, test } from "bun:test";
import { gitReviewPolicy } from "./git-review-policy";
import { jjReviewPolicy } from "./jj-review-policy";
import { resolveReviewOpenState } from "./review-open-state";
import { resolveProviderReviewDefault } from "./vcs-review-policy";

const asOpenStatePolicy = (policy: typeof gitReviewPolicy | typeof jjReviewPolicy) => ({
  resolve: policy.resolveOpenState,
});

describe("provider-owned review defaults", () => {
  test("Git alone interprets the legacy default and its retired branch alias", () => {
    expect(resolveProviderReviewDefault(gitReviewPolicy, undefined, "branch")).toBe("merge-base");
    expect(resolveProviderReviewDefault(jjReviewPolicy, undefined, "merge-base")).toBe("jj-current");
  });

  test("Git's original key wins over a per-provider copy, which only fills in when it is unset", () => {
    // An older Plannotator (or another host on an older version) only ever
    // writes diffOptions.defaultDiffType; a stale reviewDefaults.git must not
    // shadow it.
    expect(resolveProviderReviewDefault(gitReviewPolicy, "unstaged", "merge-base")).toBe("merge-base");
    expect(resolveProviderReviewDefault(gitReviewPolicy, "unstaged", undefined)).toBe("unstaged");
  });

  test("Jujutsu reads only its own saved value, and an invalid one falls back to jj-current", () => {
    expect(resolveProviderReviewDefault(jjReviewPolicy, "jj-line", "merge-base")).toBe("jj-line");
    expect(resolveProviderReviewDefault(jjReviewPolicy, "since-base", "since-base")).toBe("jj-current");
    expect(resolveProviderReviewDefault(jjReviewPolicy, "jj-nope", undefined)).toBe("jj-current");
  });
});

describe("provider-owned open-state validation", () => {
  test("argument parsing can pass an opaque mode to the selected provider", () => {
    const result = resolveReviewOpenState({
      parsed: { diffType: "provider-mode" },
      isPRMode: false,
      isWorkspace: false,
      provider: asOpenStatePolicy(gitReviewPolicy),
      resolvedDefaultDiffType: "since-base",
    });

    expect(result.error).toContain("Unknown diff type: provider-mode");
  });

  test("JJ owns its stable open modes and base-relative line mode", () => {
    const result = resolveReviewOpenState({
      parsed: { base: "main" },
      isPRMode: false,
      isWorkspace: false,
      provider: asOpenStatePolicy(jjReviewPolicy),
      resolvedDefaultDiffType: "jj-current",
    });

    expect(result).toEqual({
      requestedBase: "main",
      requestedDiffType: "jj-line",
      notices: [],
    });
  });
});
