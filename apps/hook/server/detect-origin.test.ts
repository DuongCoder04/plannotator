/**
 * Origin detection tests.
 *
 * Run: bun test apps/hook/server/detect-origin.test.ts
 *
 * detectOrigin reads only the env object it is given, so nothing here touches
 * process.env.
 */

import { describe, expect, test } from "bun:test";
import { detectOrigin } from "./detect-origin";

describe("detectOrigin", () => {
  // Catches: DSH shells (DSH_SHELL=1, set by DSH for every shell child) falling
  // back to claude-code, which labels the review wrong and makes `last` read a
  // Claude transcript.
  test("a DeepSeek Harness shell is dsh", () => {
    expect(detectOrigin({ DSH_SHELL: "1", DSH_SESSION_ID: "s1" })).toBe("dsh");
  });

  // Catches: DSH_SHELL overriding the explicit override.
  test("PLANNOTATOR_ORIGIN still wins over DSH_SHELL", () => {
    expect(detectOrigin({ DSH_SHELL: "1", PLANNOTATOR_ORIGIN: "codex" })).toBe("codex");
  });

  // Catches: a runtime started from a DSH shell or terminal being mislabeled
  // dsh because DSH_SHELL is inherited by everything below it.
  test("a runtime launched from a DSH shell is detected as itself", () => {
    expect(detectOrigin({ DSH_SHELL: "1", CODEX_THREAD_ID: "t" })).toBe("codex");
    expect(detectOrigin({ DSH_SHELL: "1", GEMINI_CLI: "1" })).toBe("gemini-cli");
  });

  // Catches: an invalid override swallowing detection instead of falling through.
  test("an unknown PLANNOTATOR_ORIGIN falls through to DSH_SHELL", () => {
    expect(detectOrigin({ DSH_SHELL: "1", PLANNOTATOR_ORIGIN: "nope" })).toBe("dsh");
  });

  test("no fingerprint is claude-code", () => {
    expect(detectOrigin({})).toBe("claude-code");
  });
});
