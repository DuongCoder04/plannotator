import { describe, expect, test } from "bun:test";
import type { GitContext } from "@plannotator/shared/review-core";
import { resolveConfiguredVcsReviewDefault, resolveInitialDiffType } from "./vcs";
import { resolveConfiguredVcsReviewDefault as resolvePiConfiguredVcsReviewDefault } from "../../apps/pi-extension/server/vcs";

function context(overrides: Partial<GitContext>): GitContext {
  return {
    currentBranch: "feature",
    defaultBranch: "main",
    diffOptions: [
      { id: "uncommitted", label: "Uncommitted changes" },
      { id: "merge-base", label: "Committed changes" },
    ],
    worktrees: [],
    availableBranches: { local: [], remote: [] },
    vcsType: "git",
    ...overrides,
  };
}

describe("resolveInitialDiffType", () => {
  test("preserves configured Git diff modes when available", () => {
    expect(resolveInitialDiffType(context({}), "merge-base")).toBe("merge-base");
  });

  test("uses the P4 provider default instead of a legacy Git setting", () => {
    expect(resolveConfiguredVcsReviewDefault({
      diffOptions: { defaultDiffType: "merge-base" },
    }, "p4")).toBe("p4-default");
  });

  test("uses JJ defaults and ignores saved Git defaults for jj contexts", () => {
    const jjContext = context({
      defaultBranch: "trunk()",
      diffOptions: [
        { id: "jj-current", label: "Current change" },
        { id: "jj-line", label: "Line of work" },
        { id: "jj-all", label: "All files" },
      ],
      vcsType: "jj",
    });

    expect(resolveInitialDiffType(jjContext, "jj-line")).toBe("jj-line");
    expect(resolveInitialDiffType(jjContext, "all")).toBe("jj-current");
    expect(resolveInitialDiffType(jjContext, "merge-base")).toBe("jj-current");
    expect(resolveInitialDiffType(jjContext, "unstaged")).toBe("jj-current");
  });

  test("falls back to the first available option for unknown non-jj modes", () => {
    expect(resolveInitialDiffType(context({}), "jj-current")).toBe("uncommitted");
  });
});

// Both runtimes resolve the saved default a local review opens on; a drift
// here means Pi and the Bun hook open the same repo on different diffs.
describe.each([
  ["bun", resolveConfiguredVcsReviewDefault],
  ["pi", resolvePiConfiguredVcsReviewDefault],
] as const)("resolveConfiguredVcsReviewDefault (%s)", (_runtime, resolve) => {
  test("Git and Jujutsu each read their own saved default", () => {
    const config = {
      diffOptions: { defaultDiffType: "merge-base" },
      reviewDefaults: { jj: { defaultDiffType: "jj-line" } },
    };
    expect(resolve(config, "git")).toBe("merge-base");
    expect(resolve(config, "jj")).toBe("jj-line");
    // Auto selection without a detected provider is the Git default.
    expect(resolve(config)).toBe("merge-base");
  });

  test("a config saved before Jujutsu defaults: Git keeps its value, jj opens on jj-current", () => {
    const legacy = { diffOptions: { defaultDiffType: "branch" } };
    expect(resolve(legacy, "git")).toBe("merge-base");
    expect(resolve(legacy, "jj")).toBe("jj-current");
    expect(resolve(undefined, "jj")).toBe("jj-current");
  });

  test("an invalid or Git-shaped jj value falls back to jj-current", () => {
    for (const bad of ["since-base", "merge-base", "jj-nope"]) {
      expect(resolve({ reviewDefaults: { jj: { defaultDiffType: bad } } }, "jj")).toBe("jj-current");
    }
  });

  test("Git's original key wins over a stale per-provider copy", () => {
    expect(resolve({
      diffOptions: { defaultDiffType: "unstaged" },
      reviewDefaults: { git: { defaultDiffType: "staged" } },
    }, "git")).toBe("unstaged");
  });
});
