import React from 'react';
import { Tooltip } from '@plannotator/ui/components/Tooltip';

/**
 * Shared chrome for the left review panels (FileTree, SectionsPanel).
 *
 * The header's top row belongs to the PanelViewToggle alone (full width), so
 * the controls that used to share it — staged count, search, collapse-all,
 * hide-viewed, viewed counter — render as their own row directly above the
 * file list, below the "All files" entry. One source so both views keep the
 * same cluster in the same order.
 */
export function PanelControlsRow({
  stagedCount = 0,
  isSearchVisible = false,
  onOpenSearch,
  onToggleAllFolders,
  areAllFoldersExpanded = false,
  collapseDisabled = false,
  onToggleHideViewed,
  hideViewedFiles = false,
  viewedCount,
  totalCount,
}: {
  stagedCount?: number;
  isSearchVisible?: boolean;
  onOpenSearch?: () => void;
  /** Tree view only — the sections view has no folders to collapse. */
  onToggleAllFolders?: () => void;
  areAllFoldersExpanded?: boolean;
  collapseDisabled?: boolean;
  onToggleHideViewed?: () => void;
  hideViewedFiles?: boolean;
  viewedCount: number;
  totalCount: number;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5 px-2 py-1">
      {stagedCount > 0 && (
        <span className="text-xs text-primary font-medium">
          {stagedCount} added
        </span>
      )}
      {onOpenSearch && (
        <button
          onClick={onOpenSearch}
          className={`p-1 rounded transition-colors ${isSearchVisible ? 'bg-primary/15 text-primary' : 'hover:bg-muted text-muted-foreground'}`}
          title="Search diff (Cmd/Ctrl+F)"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m21 21-4.35-4.35m1.85-5.15a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z" />
          </svg>
        </button>
      )}
      {onToggleAllFolders && (
        <button
          onClick={onToggleAllFolders}
          disabled={collapseDisabled}
          className="p-1 rounded transition-colors hover:bg-muted text-muted-foreground disabled:opacity-50 disabled:cursor-not-allowed"
          title={areAllFoldersExpanded ? 'Collapse all folders' : 'Expand all folders'}
        >
          {areAllFoldersExpanded ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 2l7 6 7-6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 22l7-6 7 6" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 8l7-6 7 6" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 16l7 6 7-6" />
            </svg>
          )}
        </button>
      )}
      {onToggleHideViewed && (
        <button
          onClick={onToggleHideViewed}
          className={`p-1 rounded transition-colors ${hideViewedFiles ? 'bg-primary/15 text-primary' : 'hover:bg-muted text-muted-foreground'}`}
          title={hideViewedFiles ? 'Show viewed files' : 'Hide viewed files'}
        >
          {hideViewedFiles ? (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
            </svg>
          ) : (
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          )}
        </button>
      )}
      <span className="text-xs text-muted-foreground tabular-nums">
        {viewedCount}/{totalCount}
      </span>
    </div>
  );
}

/**
 * Footer with the diff totals as the copy trigger — there is no separate Copy
 * button; clicking the count copies the entire diff set. The left slot carries
 * the transient copy status so feedback survives the button's removal.
 */
export function CopyDiffFooter({
  additions,
  deletions,
  onCopyRawDiff,
  canCopyRawDiff = false,
  copyRawDiffStatus = 'idle',
  className = '',
}: {
  additions: number;
  deletions: number;
  onCopyRawDiff?: () => void;
  canCopyRawDiff?: boolean;
  copyRawDiffStatus?: 'idle' | 'success' | 'error';
  className?: string;
}) {
  const stats = (
    <span className="file-stats inline-flex items-center gap-1.5">
      <span className="additions">+{additions}</span>
      <span className="deletions">-{deletions}</span>
    </span>
  );
  return (
    <div className={`px-2 py-1.5 border-t border-border/50 text-xs text-muted-foreground ${className}`}>
      <div className="flex items-center justify-between">
        {copyRawDiffStatus === 'success' ? (
          <span className="text-success">Copied</span>
        ) : copyRawDiffStatus === 'error' ? (
          <span className="text-destructive">Failed</span>
        ) : (
          <span />
        )}
        {onCopyRawDiff ? (() => {
          const copyButton = (
            <button
              onClick={onCopyRawDiff}
              disabled={!canCopyRawDiff}
              aria-label={`Copy the entire diff set (+${additions}/-${deletions})`}
              className="cursor-pointer rounded px-1 -mx-1 hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary/60"
            >
              {stats}
            </button>
          );
          // No tooltip while disabled: several browsers swallow hover events
          // on a disabled native button, so the trigger would never fire.
          return canCopyRawDiff ? (
            // Pinned copy: tooltip text specified verbatim by the maintainer.
            <Tooltip content="click to copy the entire diff set" side="top" delayDuration={300}>
              {copyButton}
            </Tooltip>
          ) : copyButton;
        })() : (
          stats
        )}
      </div>
    </div>
  );
}
