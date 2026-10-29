/**
 * The window's project names (owner's pick, 2026-10-29): the folder's name,
 * with the parent only when two projects on screen share it. The server's
 * name weighs every stored project, so a clash with a project no longer listed
 * (an old worktree) must not lengthen the name here.
 */
import { expect, test } from 'bun:test';
import { listProjectNames, shortProjectNames } from './projectLabels';

const REPO = { id: 'prj_repo', root: '/Users/me/plannotator/plannotator', name: 'plannotator · plannotator' };
const WORKTREE = { id: 'prj_wt', root: '/Users/me/worktrees/plannotator', name: 'plannotator · worktrees' };
const API_WORK = { id: 'prj_w', root: '/work/api', name: 'api · work' };
const API_HOME = { id: 'prj_h', root: '/personal/api', name: 'api · personal' };

test('a project whose folder name no other listed project shares reads just the folder name', () => {
  const names = shortProjectNames([REPO, API_WORK]);
  expect(names.get(REPO.id)).toBe('plannotator');
  expect(names.get(API_WORK.id)).toBe('api');
});

test('two listed projects with the same folder name each add their parent, as many parents as tell them apart', () => {
  const names = shortProjectNames([REPO, WORKTREE, API_WORK, API_HOME]);
  expect(names.get(REPO.id)).toBe('plannotator · plannotator');
  expect(names.get(WORKTREE.id)).toBe('plannotator · worktrees');
  expect(names.get(API_WORK.id)).toBe('api · work');
  expect(names.get(API_HOME.id)).toBe('api · personal');
  // Same parent too: one more level, compared as a person reads names (case, Unicode form).
  const deep = shortProjectNames([
    { id: 'a', root: '/a/src/web', name: 'web' },
    { id: 'b', root: '/b/SRC/Web', name: 'web' },
  ]);
  expect(deep.get('a')).toBe('web · a/src');
  expect(deep.get('b')).toBe('Web · b/SRC');
});

test('a clash only with a project that has no row in the list leaves the folder name alone', () => {
  const sections = [{ threads: [{ project: { id: REPO.id } }, { project: { id: API_WORK.id } }] }];
  // WORKTREE is stored (the list model knows it) but has no row here.
  const names = listProjectNames(sections, [REPO, WORKTREE, API_WORK]);
  expect(names.get(REPO.id)).toBe('plannotator');
  expect(names.has(WORKTREE.id)).toBe(false);
  // Its row lands: both now name their parent.
  const both = listProjectNames([...sections, { threads: [{ project: { id: WORKTREE.id } }] }], [REPO, WORKTREE, API_WORK]);
  expect(both.get(REPO.id)).toBe('plannotator · plannotator');
  expect(both.get(WORKTREE.id)).toBe('plannotator · worktrees');
});

test('a project at a filesystem root keeps the name it came with', () => {
  expect(shortProjectNames([{ id: 'r', root: '/', name: 'root' }]).get('r')).toBe('root');
});
