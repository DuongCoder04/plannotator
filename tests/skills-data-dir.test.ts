/**
 * No shipped skill, command or CLI help names ~/.plannotator as a path to
 * read or write (#2305).
 *
 * The failure this catches: the compound skill told agents to create
 * `~/.plannotator/hooks/compound/...`. On an install that keeps its data
 * under $XDG_DATA_HOME, that made a new ~/.plannotator, and every Plannotator
 * process then used it, so the person's plans and history went out of
 * reach. Agent-facing text must send the agent to `plannotator data-dir`
 * instead. The allowlist holds only text that describes the default (or warns
 * against writing it); every entry must still match, so a stale one fails.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { formatTopLevelHelp, SUBCOMMAND_HELP } from "../apps/hook/server/cli";

const REPO = resolve(import.meta.dir, "..");

/** A home-relative data-dir path: `~/.plannotator`, `$HOME/.plannotator`, `${HOME}/...`, `%USERPROFILE%\.plannotator`. */
const HARDCODED = /(?:~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE)[/\\]\.plannotator/;

/** Where agent instructions ship from: skills, slash commands and agent definitions of every host. */
function shippedRoots(): string[] {
  const roots = [join(REPO, "apps", "skills"), join(REPO, ".agents")];
  for (const app of readdirSync(join(REPO, "apps"))) {
    for (const folder of ["skills", "commands", "agents"]) {
      const path = join(REPO, "apps", app, folder);
      try {
        if (statSync(path).isDirectory()) roots.push(path);
      } catch {
        // No such folder for this host.
      }
    }
  }
  return roots;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (!/\.test\.[cm]?[jt]sx?$/.test(entry.name)) yield path;
  }
}

/** Text that describes the default data dir, or warns against writing it. `source` is a repo path or `cli:<subcommand>`. */
const ALLOWED: Array<{ source: string; contains: string; why: string }> = [
  {
    source: "apps/skills/core/plannotator/SKILL.md",
    contains: "Never write a path such as `~/.plannotator/...` from memory",
    why: "warns against the hardcoded path",
  },
  {
    source: "apps/skills/core/plannotator/SKILL.md",
    contains: "Unset, the default is `~/.plannotator` or `$XDG_DATA_HOME/plannotator`",
    why: "describes the default and points at plannotator data-dir",
  },
  {
    source: "cli:data-dir",
    contains: "else ~/.plannotator when it exists,",
    why: "the data-dir command's own description of the rule",
  },
  {
    source: "cli:data-dir",
    contains: "~/.plannotator.",
    why: "the data-dir command's own description of the rule",
  },
  {
    source: "cli:data-dir",
    contains: "Agents: use this path instead of writing ~/.plannotator.",
    why: "warns against the hardcoded path",
  },
];

type Hit = { source: string; line: string };

function hitsIn(source: string, text: string): Hit[] {
  return text
    .split("\n")
    .filter((line) => HARDCODED.test(line))
    .map((line) => ({ source, line }));
}

function allHits(): Hit[] {
  const hits: Hit[] = [];
  for (const root of shippedRoots()) {
    for (const file of walk(root)) {
      hits.push(...hitsIn(relative(REPO, file).split("\\").join("/"), readFileSync(file, "utf8")));
    }
  }
  hits.push(...hitsIn("cli:--help", formatTopLevelHelp({ board: true })));
  for (const [sub, text] of Object.entries(SUBCOMMAND_HELP)) hits.push(...hitsIn(`cli:${sub}`, text));
  return hits;
}

describe("shipped agent instructions never hardcode the data directory", () => {
  const hits = allHits();

  test("the scan reaches the skills it guards", () => {
    // The compound skill is the one that broke installs; if the walk stops
    // reaching it, every other assertion here passes vacuously.
    const files = shippedRoots().flatMap((root) => [...walk(root)]).map((file) => relative(REPO, file));
    expect(files.some((file) => file.endsWith(join("plannotator-compound", "SKILL.md")))).toBe(true);
    expect(files.some((file) => file.endsWith(join("core", "plannotator", "SKILL.md")))).toBe(true);
  });

  test("every mention is an allowlisted description of the default", () => {
    const unexpected = hits.filter(
      (hit) => !ALLOWED.some((entry) => entry.source === hit.source && hit.line.includes(entry.contains)),
    );
    expect(
      unexpected,
      "Agent-facing text names ~/.plannotator. Send the agent to `plannotator data-dir` (or say `<data-dir>`) instead; on an XDG install a new ~/.plannotator hides the person's data (#2305).",
    ).toEqual([]);
  });

  test("every allowlist entry still matches a line", () => {
    const stale = ALLOWED.filter(
      (entry) => !hits.some((hit) => hit.source === entry.source && hit.line.includes(entry.contains)),
    );
    expect(stale).toEqual([]);
  });
});
