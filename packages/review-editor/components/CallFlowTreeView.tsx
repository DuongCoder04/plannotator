import React, { useState } from 'react';
import type { CallFlowNode, CallFlowTree } from '@plannotator/shared/call-flow-types';
import type { SelectedLineRange } from '@plannotator/ui/types';
import { MessageSquarePlus } from 'lucide-react';

/** Map a located CallDiff node to the old/new source range used by code review. */
export function selectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  if (!node.line) return null;
  return {
    start: node.line,
    end: node.endLine && node.endLine >= node.line ? node.endLine : node.line,
    side: node.status === 'removed' ? 'deletions' : 'additions',
  };
}

/**
 * Return a native annotation target only for changed call sites. Unchanged
 * context can be opened for orientation but is not a valid inline diff target.
 */
export function annotationSelectionForCallFlowNode(node: CallFlowNode): SelectedLineRange | null {
  return node.status === 'same' ? null : selectionForCallFlowNode(node);
}

function statusGlyph(status: CallFlowNode['status']): string {
  if (status === 'added') return '+';
  if (status === 'removed') return '−';
  return '·';
}

function CallFlowNodeRow({
  node,
  depth,
  path,
  onOpen,
  onComment,
  focusFiles,
  canInteractWithNode,
}: {
  node: CallFlowNode;
  depth: number;
  path: string;
  onOpen: (node: CallFlowNode) => void;
  onComment?: (node: CallFlowNode) => void;
  focusFiles?: ReadonlySet<string>;
  canInteractWithNode?: (node: CallFlowNode) => boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;
  const inPatch = canInteractWithNode?.(node) ?? true;
  const navigable = Boolean(node.file && node.line && inPatch);
  const location = node.file ? `${node.file}${node.line ? `:${node.line}` : ''}` : '';
  const focused = node.status !== 'same' && Boolean(node.file && focusFiles?.has(node.file));
  const annotatable = Boolean(inPatch && onComment && annotationSelectionForCallFlowNode(node));

  return (
    <li className="call-flow-node">
      <div
        className={`call-flow-row call-flow-row-${node.status}${focused ? ' call-flow-row-focused' : ''}`}
        style={{ '--call-flow-depth': depth } as React.CSSProperties}
      >
        {hasChildren ? (
          <button
            type="button"
            className="call-flow-expand"
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.label}`}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            <span aria-hidden="true">{expanded ? '⌄' : '›'}</span>
          </button>
        ) : (
          <span className="call-flow-expand" aria-hidden="true" />
        )}
        <span className={`call-flow-status call-flow-status-${node.status}`} aria-label={node.status}>
          {statusGlyph(node.status)}
        </span>
        <button
          type="button"
          className="call-flow-node-target"
          disabled={!navigable}
          onClick={() => onOpen(node)}
          title={navigable ? `Open ${location}` : node.file && node.line ? 'Outside the reviewed patch' : node.label}
        >
          <span className="call-flow-node-label">{node.label}</span>
          {node.kind === 'branch' && <span className="call-flow-node-kind">branch</span>}
          {location && <span className="call-flow-node-location">{location}</span>}
        </button>
        {annotatable ? (
          <button
            type="button"
            className="call-flow-comment"
            onClick={() => onComment?.(node)}
            title={`Comment on ${node.label}`}
            aria-label={`Comment on ${node.label} at ${location}`}
          >
            <MessageSquarePlus aria-hidden="true" size={14} strokeWidth={1.75} />
          </button>
        ) : (
          <span className="call-flow-comment-placeholder" aria-hidden="true" />
        )}
      </div>
      {hasChildren && expanded && (
        <ol className="call-flow-children">
          {node.children.map((child, index) => (
            <CallFlowNodeRow
              key={`${path}/${child.key}:${child.status}:${index}`}
              node={child}
              depth={depth + 1}
              path={`${path}/${child.key}:${index}`}
              onOpen={onOpen}
              onComment={onComment}
              focusFiles={focusFiles}
              canInteractWithNode={canInteractWithNode}
            />
          ))}
        </ol>
      )}
    </li>
  );
}

interface CallFlowTreeViewProps {
  readonly trees: readonly CallFlowTree[];
  readonly onOpenNode: (node: CallFlowNode) => void;
  /** Open the native code-review annotation composer for a changed call site. */
  readonly onCommentNode?: (node: CallFlowNode) => void;
  /** Changed rows in these files receive the Lens focus treatment. */
  readonly focusFiles?: readonly string[];
  /** Gate navigation and comments to ranges represented by the active patch. */
  readonly canInteractWithNode?: (node: CallFlowNode) => boolean;
  readonly compact?: boolean;
}

/** Shared complete-tree renderer used by both the Dock and the per-file Lens. */
export function CallFlowTreeView({ trees, onOpenNode, onCommentNode, focusFiles, canInteractWithNode, compact = false }: CallFlowTreeViewProps) {
  const focused = focusFiles ? new Set(focusFiles) : undefined;
  return (
    <div className={`call-flow-trees${compact ? ' call-flow-trees-compact' : ''}`}>
      {trees.map((entry, index) => (
        <section className="call-flow-entry" key={`${entry.entry}:${index}`}>
          <div className="call-flow-entry-header">
            <span className="call-flow-entry-mark" aria-hidden="true">↳</span>
            <span className="call-flow-entry-label">{entry.entry}</span>
            <span className="call-flow-entry-meta">entry path</span>
          </div>
          <ol className="call-flow-tree">
            <CallFlowNodeRow
              node={entry.tree}
              depth={0}
              path={`${entry.entry}:${index}`}
              onOpen={onOpenNode}
              onComment={onCommentNode}
              focusFiles={focused}
              canInteractWithNode={canInteractWithNode}
            />
          </ol>
        </section>
      ))}
    </div>
  );
}
