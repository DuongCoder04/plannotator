/**
 * The window's project names (`shortProjectNames`, packages/inbox/projectLabels.ts)
 * apply the server's clash rule (`inboxProjectLabels`, packages/shared/inbox/project-name.ts)
 * to the projects on screen. packages/inbox cannot import shared, so the rule is
 * in both places; given the same projects, the two must name them the same, or
 * the window and the agents would disagree on a name for no reason the person
 * chose. A change to one copy that misses the other fails here.
 */
import { expect, test } from 'bun:test';
import { inboxProjectLabels } from '../packages/shared/inbox/project-name';
import { shortProjectNames } from '../packages/inbox/projectLabels';

type Project = { id: string; root: string; name: string };
const p = (id: string, root: string, name = 'slug'): Project => ({ id, root, name });

const CASES: { what: string; projects: Project[] }[] = [
  { what: 'no clash', projects: [p('a', '/work/api'), p('b', '/work/web')] },
  { what: 'a clash one parent tells apart', projects: [p('a', '/work/api'), p('b', '/home/api')] },
  { what: 'case differs', projects: [p('a', '/x/Web'), p('b', '/y/web')] },
  { what: 'Unicode form differs (NFD vs NFC)', projects: [p('a', '/x/cafe\u0301'), p('b', '/y/caf\u00e9')] },
  { what: 'Windows drive letters', projects: [p('a', 'C:\\work\\api'), p('b', 'D:\\work\\api')] },
  { what: 'backslashes and slashes mixed', projects: [p('a', 'C:\\Users\\me\\api'), p('b', '/Users/me/api')] },
  { what: 'network paths', projects: [p('a', '\\\\server\\share\\api'), p('b', '\\\\other\\share\\api')] },
  { what: 'nested clash (same parent too)', projects: [p('a', '/x/work/api'), p('b', '/y/work/api'), p('c', '/home/api')] },
  { what: 'one project at the shallower depth', projects: [p('a', '/api'), p('b', '/work/api')] },
  { what: 'missing root (a filesystem root)', projects: [p('a', '/', 'root-slug'), p('b', '/work/api')] },
  { what: 'a drive root', projects: [p('a', 'C:\\', 'drive-slug'), p('b', '/x/C:')] },
  { what: 'trailing slashes', projects: [p('a', '/work/api/'), p('b', '/home/api//')] },
  { what: 'the same root twice', projects: [p('a', '/w/api'), p('b', '/w/api')] },
  { what: 'empty root', projects: [p('a', '', 'empty-slug')] },
];

test('the window and the server name the same projects the same way', () => {
  for (const { what, projects } of CASES) {
    const server = Object.fromEntries(inboxProjectLabels(projects));
    const window = Object.fromEntries(shortProjectNames(projects));
    expect({ what, names: window }).toEqual({ what, names: server });
  }
});
