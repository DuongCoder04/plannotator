/**
 * The Qwen Code integration files the installers copy, checked for the
 * things that break Qwen users without failing anywhere else:
 * - the extension's plan-review hook must reach `plannotator` on
 *   exit_plan_mode with a timeout Qwen reads as milliseconds (a value under
 *   1000 is seconds, so a review would be cut off) and name the origin;
 * - the extension must carry no skills: Qwen prefixes extension skills with
 *   the extension name, which would add `/plannotator:plannotator-review`
 *   next to the `/plannotator-review` the installers put in $QWEN_HOME/skills;
 * - each Qwen skill must keep its blocking command out of the shell tool's
 *   foreground limit, and must not use a POSIX env prefix (Qwen on Windows
 *   runs the shell tool under cmd or PowerShell; detection reads Qwen's own
 *   variables instead).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_CONFIG } from "../../packages/core/agents";

const root = import.meta.dir;
const extensionDir = join(root, "extension");

interface HookEntry { type: string; command: string; timeout?: number; env?: Record<string, string> }
interface HookGroup { matcher: string; hooks: HookEntry[] }

function hooks(): Record<string, HookGroup[]> {
  return JSON.parse(readFileSync(join(extensionDir, "hooks", "hooks.json"), "utf8")).hooks;
}

describe("Qwen Code extension", () => {
  test("its manifest names the extension the installers and uninstall manage", () => {
    const manifest = JSON.parse(readFileSync(join(extensionDir, "qwen-extension.json"), "utf8"));
    expect(manifest.name).toBe("plannotator");
    expect(typeof manifest.version).toBe("string");
  });

  test("exit_plan_mode opens the review and waits long enough", () => {
    const groups = hooks().PermissionRequest;
    const group = groups.find((g) => g.matcher === "exit_plan_mode");
    expect(group).toBeDefined();
    const hook = group!.hooks[0];
    expect(hook.type).toBe("command");
    expect(hook.command).toBe("plannotator");
    // >= 1000 is milliseconds in Qwen; ask for at least a day.
    expect(hook.timeout).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    expect(hook.env?.PLANNOTATOR_ORIGIN).toBe("qwen-code");
  });

  test("every hook names an origin Plannotator knows", () => {
    for (const groups of Object.values(hooks())) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          expect(hook.env?.PLANNOTATOR_ORIGIN && hook.env.PLANNOTATOR_ORIGIN in AGENT_CONFIG).toBe(true);
        }
      }
    }
  });

  test("carries no skills or commands", () => {
    expect(existsSync(join(extensionDir, "skills"))).toBe(false);
    expect(existsSync(join(extensionDir, "commands"))).toBe(false);
  });
});

describe("Qwen Code skills", () => {
  const names = readdirSync(join(root, "skills"));

  test("cover review, annotate and last", () => {
    expect(names.sort()).toEqual(["plannotator-annotate", "plannotator-last", "plannotator-review"]);
  });

  for (const name of names) {
    test(`${name}: user-invoked, run in the background, no env prefix`, () => {
      const text = readFileSync(join(root, "skills", name, "SKILL.md"), "utf8");
      const frontmatter = text.split("---")[1] ?? "";
      expect(frontmatter).toContain(`name: ${name}`);
      expect(frontmatter).toContain("disable-model-invocation: true");
      expect(text).toContain("is_background: true");
      expect(text).not.toMatch(/PLANNOTATOR_ORIGIN=/);
    });
  }
});
