/** DOM-gated coverage for compact file-row control preferences. */
import { afterEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTreeNodeItem, alignedTreeIndent, maxTreeIndent } from './FileTreeNode';
import type { FileTreeNode } from '../utils/buildFileTree';

const hasDom = typeof document !== 'undefined';
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const node: FileTreeNode = {
  type: 'file',
  name: 'example.ts',
  path: 'src/example.ts',
  depth: 0,
  fileIndex: 0,
  additions: 2,
  deletions: 1,
  file: {
    path: 'src/example.ts',
    patch: '',
    additions: 2,
    deletions: 1,
    status: 'modified',
  },
};

function Row({ compact }: { compact: boolean }) {
  return (
    <FileTreeNodeItem
      node={node}
      expandedFolders={new Set()}
      onToggleFolder={() => {}}
      activeFileIndex={0}
      onSelectFile={() => {}}
      viewedFiles={new Set()}
      onToggleViewed={() => {}}
      showViewedControls={!compact}
      hideViewedFiles={false}
      getAnnotationCount={() => 0}
      stagedFiles={new Set()}
      getSectionEntry={() => ({ group: 'changes', staged: false })}
      onStageFile={() => {}}
      showStageControls={!compact}
    />
  );
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe('FileTreeNodeItem compact controls', () => {
  test.skipIf(!hasDom)('removes viewed and Git add controls without removing the file row', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => root?.render(<Row compact={false} />));
    expect(host.querySelector('[role="checkbox"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Stage file"]')).not.toBeNull();

    await act(async () => root?.render(<Row compact />));
    expect(host.querySelector('[role="checkbox"]')).toBeNull();
    expect(host.querySelector('[aria-label="Stage file"]')).toBeNull();
    expect(host.textContent).toContain('example.ts');
  });

  test.skipIf(!hasDom)('a cut name keeps its full path on hover', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => root?.render(<Row compact={false} />));
    expect(host.querySelector('.file-tree-item')?.getAttribute('title')).toBe('src/example.ts');
  });
});

describe('the Changes tree indent', () => {
  test('12 px a level from the 8 px row edge, so a level lines its chevron up with the label above', () => {
    expect([0, 1, 2].map((depth) => alignedTreeIndent(depth))).toEqual([8, 20, 32]);
  });

  test('a deep tree stops indenting where the names would lose their room, by panel width', () => {
    expect(alignedTreeIndent(12, maxTreeIndent(256))).toBe(8 + 56);
    expect(alignedTreeIndent(12, maxTreeIndent(400))).toBe(8 + 144);
    // The minimum width still shows two levels.
    expect(alignedTreeIndent(12, maxTreeIndent(160))).toBe(8 + 24);
  });
});
