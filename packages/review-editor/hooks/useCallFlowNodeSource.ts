import { useMemo } from 'react';
import type { CallFlowNode } from '@plannotator/shared/call-flow-types';
import type { DiffFile } from '../types';
import type { ReviewState } from '../dock/ReviewStateContext';

/** The source a Call Flow location's hover preview shows: the side of the file the node lives on. */
export interface CallFlowNodeSource {
  contents: string;
  filepath: string;
}

export type CallFlowNodeSourceLoader = (node: CallFlowNode) => Promise<CallFlowNodeSource | null>;

interface CallFlowSourceOptions {
  readonly files: readonly Pick<DiffFile, 'path' | 'oldPath'>[];
  readonly reviewBase?: string;
  readonly snapshotId?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Build the loader behind Call Flow's hover previews. It reads the file the
 * review shows through `/api/file-content` (both sides, bound to the review's
 * base and snapshot, so a PR or since-base review previews the reviewed
 * source, not the working tree) and picks the old side for a removed node.
 * One request per file, shared by every row in it; a failed request (a
 * stale snapshot, a file the server cannot read) resolves null and is
 * forgotten, so a later hover asks again.
 */
export function createCallFlowNodeSourceLoader({
  files,
  reviewBase,
  snapshotId,
  fetchImpl = fetch,
}: CallFlowSourceOptions): CallFlowNodeSourceLoader {
  const cache = new Map<string, Promise<{ oldContent: string | null; newContent: string | null } | null>>();
  return async (node) => {
    if (!node.file || !node.line) return null;
    const diffFile = files.find((file) => file.path === node.file || file.oldPath === node.file);
    const path = diffFile?.path ?? node.file;
    const oldPath = diffFile?.oldPath;
    const key = `${path}\0${oldPath ?? ''}`;
    let request = cache.get(key);
    if (!request) {
      const params = new URLSearchParams({ path });
      if (oldPath) params.set('oldPath', oldPath);
      if (reviewBase) params.set('base', reviewBase);
      if (snapshotId) params.set('snapshot', snapshotId);
      request = fetchImpl(`/api/file-content?${params}`)
        .then((res) => (res.ok ? res.json() : null))
        .catch(() => null);
      cache.set(key, request);
      void request.then((data) => { if (!data) cache.delete(key); });
    }
    const data = await request;
    const contents = node.status === 'removed' ? data?.oldContent : data?.newContent;
    return contents != null ? { contents, filepath: node.file } : null;
  };
}

/**
 * The Call Flow hover loader for the current review, or undefined when the
 * review has no full file contents (a static patch: `/api/file-content`
 * answers 400) so no row offers a preview.
 */
export function useCallFlowNodeSource(state: ReviewState | null): CallFlowNodeSourceLoader | undefined {
  const files = state?.files;
  const reviewBase = state?.reviewBase;
  const snapshotId = state?.feedbackDiffContext?.snapshotId;
  const available = Boolean(state) && state?.contextExpansionAvailable !== false;
  return useMemo(
    () => (available && files ? createCallFlowNodeSourceLoader({ files, reviewBase, snapshotId }) : undefined),
    [available, files, reviewBase, snapshotId],
  );
}
