/**
 * No test reaches the live feedback Worker. Its table is append-only, so one
 * stray row from a test stays until the owner drops a trigger by hand.
 *
 * Two guards: the preload every bunfig loads (tests/setup/feedback-archive-off.ts)
 * points PLANNOTATOR_FEEDBACK_URL at a closed loopback port, so the Inbox and
 * `plannotator feedback` refuse at once unless a test serves a fake; and no
 * test or e2e file names the live host, so none can send there on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { PRODUCT_FEEDBACK_URL, productFeedbackUrl } from "../packages/core/product-feedback";

const repoRoot = resolve(import.meta.dir, "..");
const liveHost = new URL(PRODUCT_FEEDBACK_URL).host;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".wrangler", ".claude", ".turbo"]);

/** Test files: *.test.*, *.spec.*, and everything under a tests/ or test/ folder. */
function testFiles(dir: string, inTests = false): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (SKIP_DIRS.has(name)) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return testFiles(full, inTests || name === "tests" || name === "test");
    if (!/\.(?:[cm]?[jt]sx?)$/.test(name)) return [];
    return inTests || /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ? [full] : [];
  });
}

describe("the live feedback Worker is out of reach of tests", () => {
  test("the preload sends feedback to a closed loopback port", () => {
    expect(process.env.PLANNOTATOR_FEEDBACK_URL).toBe("http://127.0.0.1:9/feedback");
    expect(productFeedbackUrl(process.env)).toBe("http://127.0.0.1:9/feedback");
  });

  test("no test file names the live host", () => {
    const files = [...testFiles(join(repoRoot, "apps")), ...testFiles(join(repoRoot, "packages")), ...testFiles(join(repoRoot, "tests"), true), ...testFiles(join(repoRoot, "scripts"))];
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter((file) => readFileSync(file, "utf-8").includes(liveHost)).map((file) => relative(repoRoot, file));
    expect(naming).toEqual([]);
  });
});
