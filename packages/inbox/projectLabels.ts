/**
 * A project's name as the window shows it (owner's pick, 2026-10-29): just
 * its folder's name, adding the parent folder only when two of the projects
 * on screen share that name, and as many parents as it takes to tell them
 * apart ("api · work", "api · personal").
 *
 * The server's name (`inboxProjectLabels` in packages/shared) weighs every
 * project ever stored, so an old worktree named like the repository made the
 * rows read "plannotator · plannotator". Agents keep reading that name; only
 * the window shortens it. Pure.
 */

/** The parts of a path, either separator, without empty ones. */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter((part) => part.length > 0);
}

/** How two folder names compare for "the same name": as a person reads them. */
function sameKey(name: string): string {
  return name.normalize('NFC').toLocaleLowerCase();
}

/**
 * Each project's name by id, for the projects given (the ones on screen). A
 * project whose root has no last segment (a filesystem root) keeps `name`.
 */
export function shortProjectNames(projects: readonly { id: string; root: string; name: string }[]): Map<string, string> {
  const base = new Map<string, { parts: string[]; name: string }>();
  for (const project of projects) {
    const parts = segments(project.root);
    const last = parts[parts.length - 1];
    base.set(project.id, { parts, name: last ? last.normalize('NFC') : project.name });
  }
  const groups = new Map<string, string[]>();
  for (const [id, { name }] of base) groups.set(sameKey(name), [...(groups.get(sameKey(name)) ?? []), id]);
  const out = new Map<string, string>();
  for (const ids of groups.values()) {
    if (ids.length === 1) {
      out.set(ids[0]!, base.get(ids[0]!)!.name);
      continue;
    }
    // The fewest parent folders that tell every project of the group apart.
    const parentsOf = (id: string, depth: number) => {
      const { parts } = base.get(id)!;
      return parts.slice(Math.max(0, parts.length - 1 - depth), parts.length - 1).join('/');
    };
    const deepest = Math.max(...ids.map((id) => base.get(id)!.parts.length - 1));
    let depth = 1;
    while (depth < deepest && new Set(ids.map((id) => sameKey(parentsOf(id, depth)))).size < ids.length) depth += 1;
    for (const id of ids) {
      const parents = parentsOf(id, depth);
      const { name } = base.get(id)!;
      out.set(id, parents ? `${name} · ${parents}` : name);
    }
  }
  return out;
}

/** The projects with a row in `sections` (the list on screen, a folded Quiet included), named by `shortProjectNames`. */
export function listProjectNames(
  sections: readonly { threads: readonly { project: { id: string } }[] }[],
  projects: readonly { id: string; root: string; name: string }[],
): Map<string, string> {
  const listed = new Set<string>();
  for (const section of sections) for (const row of section.threads) listed.add(row.project.id);
  return shortProjectNames(projects.filter((project) => listed.has(project.id)));
}
