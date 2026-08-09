import { useState, useEffect, useCallback, useRef, type RefObject } from "react";
import { AnnotationType, type Annotation, type EditorMode, type HtmlElementAnchor, type ImageAttachment } from "../../types";
import type { QuickLabel } from "../../utils/quickLabels";
import { getIdentity } from "../../utils/identity";
import type {
  ToolbarState,
  CommentPopoverState,
  QuickLabelPickerState,
  UseAnnotationHighlighterReturn,
} from "../../hooks/useAnnotationHighlighter";

const PREFIX = "plannotator-bridge-";

// Collision-proof annotation ids. `Date.now()` alone repeats within a millisecond,
// so two quick annotations could share a data-bind-id and clobber each other.
let htmlAnnSeq = 0;
function nextHtmlAnnId(): string {
  return `html-ann-${Date.now().toString(36)}-${(htmlAnnSeq++).toString(36)}`;
}

interface BridgeSelectionMessage {
  type: `${typeof PREFIX}selection`;
  text: string;
  rect: BridgeRect;
  modeOverride?: EditorMode;
  /** Serialized element anchor (pinpoint clicks) — validated, size-capped. */
  anchor?: HtmlElementAnchor;
  /** True when the selection came from a pinpoint click on an element. */
  pinpoint?: boolean;
}

interface BridgeRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

type BridgeMessage =
  | BridgeSelectionMessage
  | { type: `${typeof PREFIX}selection-clear` }
  | { type: `${typeof PREFIX}selection-rect`; rect: BridgeRect }
  | { type: `${typeof PREFIX}keytype`; key: string }
  | { type: `${typeof PREFIX}mark-click`; id: string }
  | { type: `${typeof PREFIX}resize`; height: number };

/** Dependencies and callbacks for the sandboxed HTML annotation bridge. */
export interface UseHtmlAnnotationOptions {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  /** Whether selection bridge messages may open composers or create annotations. */
  enabled?: boolean;
  annotations: Annotation[];
  onAddAnnotation?: (ann: Annotation) => void;
  onSelectAnnotation?: (id: string | null) => void;
  selectedAnnotationId: string | null;
  mode: EditorMode;
  onResize?: (height: number) => void;
}

function postToIframe(iframe: HTMLIFrameElement | null, msg: Record<string, unknown>) {
  iframe?.contentWindow?.postMessage(msg, "*");
}

function parseEditorMode(value: unknown): EditorMode | undefined {
  return value === "selection"
    || value === "comment"
    || value === "redline"
    || value === "quickLabel"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Size caps for the anchor DTO — the bridge script runs inside a sandboxed
// iframe rendering arbitrary HTML, so everything it posts is validated and
// bounded before it can reach React state or the annotation model.
const MAX_ANCHOR_SELECTOR_LENGTH = 1024;
const MAX_ANCHOR_TAG_LENGTH = 64;
const MAX_ANCHOR_TEXT_LENGTH = 400;
// Selection text is page-controlled too (a pinpoint click posts the element's
// entire textContent), so it gets the same treatment: truncated here — not
// rejected, a legitimate huge selection still annotates — before it can reach
// React state, drafts, exported feedback, or a share URL. Mirrors
// MAX_SELECTION_TEXT in bridge-script.ts; this side is the authoritative one.
export const MAX_SELECTION_TEXT_LENGTH = 10000;

/** Validate a bridge-posted element anchor. Exported for protocol tests. */
export function parseHtmlElementAnchor(value: unknown): HtmlElementAnchor | null {
  if (!isRecord(value)) return null;
  const { selector, tagName, text } = value;
  if (
    typeof selector !== "string"
    || selector.length === 0
    || selector.length > MAX_ANCHOR_SELECTOR_LENGTH
    || typeof tagName !== "string"
    || tagName.length === 0
    || tagName.length > MAX_ANCHOR_TAG_LENGTH
  ) {
    return null;
  }
  if (text === undefined) return { selector, tagName };
  if (typeof text !== "string" || text.length > MAX_ANCHOR_TEXT_LENGTH) return null;
  return { selector, tagName, text };
}

function parseBridgeRect(value: unknown): BridgeRect | null {
  if (!isRecord(value)) return null;
  const { top, left, width, height } = value;
  return typeof top === "number" && Number.isFinite(top)
    && typeof left === "number" && Number.isFinite(left)
    && typeof width === "number" && Number.isFinite(width)
    && typeof height === "number" && Number.isFinite(height)
    ? { top, left, width, height }
    : null;
}

/** Validate any bridge message. Exported for protocol tests. */
export function parseBridgeMessage(value: unknown): BridgeMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case `${PREFIX}selection`: {
      const rect = parseBridgeRect(value.rect);
      if (typeof value.text !== "string" || !rect) return null;
      return {
        type: value.type,
        text: value.text.length > MAX_SELECTION_TEXT_LENGTH
          ? value.text.slice(0, MAX_SELECTION_TEXT_LENGTH)
          : value.text,
        rect,
        modeOverride: parseEditorMode(value.modeOverride),
        anchor: parseHtmlElementAnchor(value.anchor) ?? undefined,
        pinpoint: value.pinpoint === true,
      };
    }
    case `${PREFIX}selection-clear`:
      return { type: value.type };
    case `${PREFIX}selection-rect`: {
      const rect = parseBridgeRect(value.rect);
      return rect ? { type: value.type, rect } : null;
    }
    case `${PREFIX}keytype`:
      return typeof value.key === "string"
        ? { type: value.type, key: value.key }
        : null;
    case `${PREFIX}mark-click`:
      return typeof value.id === "string"
        ? { type: value.type, id: value.id }
        : null;
    case `${PREFIX}resize`:
      return typeof value.height === "number" && Number.isFinite(value.height)
        ? { type: value.type, height: value.height }
        : null;
    default:
      return null;
  }
}

/**
 * Adapt source-validated iframe messages to the existing annotation UI.
 *
 * Malformed bridge payloads are ignored; annotations are posted back through
 * the iframe protocol and reported through the supplied callbacks.
 */
export function useHtmlAnnotation({
  iframeRef,
  enabled = true,
  onAddAnnotation,
  onSelectAnnotation,
  selectedAnnotationId,
  mode,
  onResize,
}: UseHtmlAnnotationOptions): Omit<
  UseAnnotationHighlighterReturn,
  "highlighterRef" | "highlightRange" | "highlightMathElement"
> {
  const [toolbarState, setToolbarState] = useState<ToolbarState | null>(null);
  const [commentPopover, setCommentPopover] = useState<CommentPopoverState | null>(null);
  const [quickLabelPicker, setQuickLabelPicker] = useState<QuickLabelPickerState | null>(null);

  const pendingTextRef = useRef<string>("");
  // Element anchor for the pending pinpoint selection — committed onto the
  // annotation so restoration can resolve the exact element again.
  const pendingAnchorRef = useRef<HtmlElementAnchor | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Mirror toolbar visibility into a ref so the (stable) message handler can gate
  // type-to-comment on "the markup toolbar is showing", like AnnotationToolbar does.
  const toolbarStateRef = useRef(toolbarState);
  toolbarStateRef.current = toolbarState;
  // Mirror the open comment/quick-label state so the selection-clear handler can
  // tell whether the user is mid-compose and must keep the captured text alive.
  const commentPopoverRef = useRef(commentPopover);
  commentPopoverRef.current = commentPopover;
  const quickLabelPickerRef = useRef(quickLabelPicker);
  quickLabelPickerRef.current = quickLabelPicker;

  const onAddRef = useRef(onAddAnnotation);
  onAddRef.current = onAddAnnotation;
  const onSelectRef = useRef(onSelectAnnotation);
  onSelectRef.current = onSelectAnnotation;

  const anchorRef = useRef<HTMLDivElement | null>(null);

  const getOrCreateAnchor = useCallback(() => {
    if (!anchorRef.current) {
      const div = document.createElement("div");
      div.style.position = "fixed";
      div.style.pointerEvents = "none";
      div.style.width = "1px";
      div.style.height = "1px";
      document.body.appendChild(div);
      anchorRef.current = div;
    }
    return anchorRef.current;
  }, []);

  const positionAnchor = useCallback(
    (bridgeRect: { top: number; left: number; width: number; height: number }) => {
      const iframe = iframeRef.current;
      if (!iframe) return null;
      const iframeRect = iframe.getBoundingClientRect();
      // Fresh anchor per selection. The toolbar/popover recompute position only
      // when their `element` node identity changes, so reusing one anchor div
      // leaves them pinned to the previous selection. Drop the old one first.
      if (anchorRef.current) anchorRef.current.remove();
      anchorRef.current = null;
      const anchor = getOrCreateAnchor();
      anchor.style.top = `${iframeRect.top + bridgeRect.top}px`;
      anchor.style.left = `${iframeRect.left + bridgeRect.left + bridgeRect.width / 2}px`;
      return anchor;
    },
    [iframeRef, getOrCreateAnchor],
  );

  useEffect(() => {
    function handler(e: MessageEvent<unknown>) {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const message = parseBridgeMessage(e.data);
      if (!message) return;

      const type = message.type;

      if (!enabledRef.current && type !== `${PREFIX}mark-click` && type !== `${PREFIX}resize`) {
        return;
      }

      if (type === `${PREFIX}selection`) {
        pendingTextRef.current = message.text;
        pendingAnchorRef.current = message.anchor ?? null;
        const anchor = positionAnchor(message.rect);
        if (!anchor) return;

        const currentMode = message.modeOverride ?? modeRef.current;

        if (currentMode === "redline") {
          const id = nextHtmlAnnId();
          postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "deletion" });
          onAddRef.current?.({
            id,
            blockId: "",
            startOffset: 0,
            endOffset: 0,
            type: AnnotationType.DELETION,
            originalText: message.text,
            author: getIdentity(),
            createdA: Date.now(),
            htmlAnchor: message.anchor,
          });
          pendingTextRef.current = "";
          pendingAnchorRef.current = null;
        } else if (
          currentMode === "comment"
          // Pinpoint click-to-pin: the click already chose the target, so skip
          // the intermediate toolbar and go straight to the comment composer.
          || (message.pinpoint && currentMode === "selection")
        ) {
          // Release iframe focus so the popover's textarea autofocus lands in the
          // parent (otherwise the iframe keeps focus and swallows further keys).
          iframeRef.current?.blur();
          setCommentPopover({
            anchorEl: anchor,
            contextText: message.text,
            selectedText: message.text,
          });
        } else if (currentMode === "quickLabel") {
          setQuickLabelPicker({
            anchorEl: anchor,
            cursorHint: { x: parseFloat(anchor.style.left), y: parseFloat(anchor.style.top) },
          });
        } else {
          setToolbarState({
            element: anchor,
            source: null,
            selectionText: message.text,
          });
        }
      }

      if (type === `${PREFIX}selection-clear`) {
        setToolbarState(null);
        // Keep the captured text alive while a comment/quick-label is open: the user
        // is composing, and the selection collapsing or scrolling out of view must
        // not drop the annotation on submit. It's overwritten on the next selection.
        if (!commentPopoverRef.current && !quickLabelPickerRef.current) {
          pendingTextRef.current = "";
          pendingAnchorRef.current = null;
        }
      }

      if (type === `${PREFIX}selection-rect`) {
        // The iframe content scrolled — move the anchor to the selection's new
        // position and nudge the toolbar/popover (which listen to window scroll) to
        // recompute, so they stay attached to the selection.
        const iframe = iframeRef.current;
        const anchor = anchorRef.current;
        if (!iframe || !anchor) return;
        const r = message.rect;
        const iframeRect = iframe.getBoundingClientRect();
        anchor.style.top = `${iframeRect.top + r.top}px`;
        anchor.style.left = `${iframeRect.left + r.left + r.width / 2}px`;
        window.dispatchEvent(new Event("scroll"));
      }

      if (type === `${PREFIX}keytype`) {
        // Type-to-comment: only when the markup toolbar is showing (matches the
        // markdown path, where AnnotationToolbar owns this keydown). Open a comment
        // pre-filled with the typed char.
        if (!toolbarStateRef.current) return;
        const key = message.key;
        const text = pendingTextRef.current;
        if (!key || !text) return;
        const anchor = anchorRef.current ?? getOrCreateAnchor();
        // Release iframe focus so the popover textarea can take it (and the rest of
        // the typing) — otherwise the iframe keeps focus and the bridge eats keys.
        iframeRef.current?.blur();
        setToolbarState(null);
        setCommentPopover({ anchorEl: anchor, contextText: text, selectedText: text, initialText: key });
      }

      if (type === `${PREFIX}mark-click`) {
        onSelectRef.current?.(message.id);
      }

      if (type === `${PREFIX}resize`) {
        onResize?.(message.height);
      }
    }

    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      if (anchorRef.current) {
        anchorRef.current.remove();
        anchorRef.current = null;
      }
    };
  }, [iframeRef, positionAnchor, onResize, getOrCreateAnchor]);

  useEffect(() => {
    if (enabled) return;
    setToolbarState(null);
    setCommentPopover(null);
    setQuickLabelPicker(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
    anchorRef.current?.remove();
    anchorRef.current = null;
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
  }, [enabled, iframeRef]);

  useEffect(() => {
    if (selectedAnnotationId) {
      postToIframe(iframeRef.current, {
        type: `${PREFIX}scroll-to`,
        id: selectedAnnotationId,
      });
    } else {
      postToIframe(iframeRef.current, {
        type: `${PREFIX}focus-mark`,
        id: null,
      });
    }
  }, [selectedAnnotationId, iframeRef]);

  const handleAnnotate = useCallback(
    (type: AnnotationType) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text || type !== AnnotationType.DELETION) return;

      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "deletion" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.DELETION,
        originalText: text,
        author: getIdentity(),
        createdA: Date.now(),
        htmlAnchor: pendingAnchorRef.current ?? undefined,
      });

      setToolbarState(null);
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleRequestComment = useCallback(
    (initialChar?: string) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text) return;
      const anchor = anchorRef.current ?? getOrCreateAnchor();
      setToolbarState(null);
      setCommentPopover({ anchorEl: anchor, contextText: text, selectedText: text, initialText: initialChar });
    },
    [getOrCreateAnchor],
  );

  const handleCommentSubmit = useCallback(
    (comment: string, images?: ImageAttachment[]) => {
      if (!enabledRef.current) return;
      // Prefer the text captured when the popover opened — it can't be clobbered by
      // a later selection change or clear while the user is composing the comment.
      const text = commentPopoverRef.current?.selectedText || pendingTextRef.current;
      if (!text) return;

      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "comment" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: comment,
        originalText: text,
        author: getIdentity(),
        createdA: Date.now(),
        images,
        htmlAnchor: pendingAnchorRef.current ?? undefined,
      });

      setCommentPopover(null);
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleCommentClose = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setCommentPopover(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const handleToolbarClose = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setToolbarState(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const applyQuickLabel = useCallback(
    (label: QuickLabel, clearState: () => void) => {
      if (!enabledRef.current) return;
      const text = pendingTextRef.current;
      if (!text) return;
      const id = nextHtmlAnnId();
      postToIframe(iframeRef.current, { type: `${PREFIX}create-mark`, id, annotationType: "comment" });
      onAddRef.current?.({
        id,
        blockId: "",
        startOffset: 0,
        endOffset: 0,
        type: AnnotationType.COMMENT,
        text: label.text,
        originalText: text,
        isQuickLabel: true,
        quickLabelTip: label.tip,
        author: getIdentity(),
        createdA: Date.now(),
        htmlAnchor: pendingAnchorRef.current ?? undefined,
      });
      clearState();
      pendingTextRef.current = "";
      pendingAnchorRef.current = null;
    },
    [iframeRef],
  );

  const handleQuickLabel = useCallback(
    (label: QuickLabel) => applyQuickLabel(label, () => setToolbarState(null)),
    [applyQuickLabel],
  );

  const handleFloatingQuickLabel = useCallback(
    (label: QuickLabel) => applyQuickLabel(label, () => setQuickLabelPicker(null)),
    [applyQuickLabel],
  );

  const handleQuickLabelPickerDismiss = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}cancel-selection` });
    setQuickLabelPicker(null);
    pendingTextRef.current = "";
    pendingAnchorRef.current = null;
  }, [iframeRef]);

  const removeHighlight = useCallback(
    (id: string) => {
      postToIframe(iframeRef.current, { type: `${PREFIX}remove-mark`, id });
    },
    [iframeRef],
  );

  const clearAllHighlights = useCallback(() => {
    postToIframe(iframeRef.current, { type: `${PREFIX}clear-marks` });
  }, [iframeRef]);

  const applyAnnotations = useCallback(
    (anns: Annotation[]) => {
      for (const ann of anns) {
        if (ann.type === AnnotationType.GLOBAL_COMMENT) continue;
        const annType = ann.type === AnnotationType.DELETION ? "deletion" : "comment";
        postToIframe(iframeRef.current, {
          type: `${PREFIX}find-and-mark`,
          id: ann.id,
          originalText: ann.originalText,
          annotationType: annType,
          // Anchor-first restore: the bridge resolves the serialized element
          // and scopes the text search to it, falling back to document-wide.
          anchor: ann.htmlAnchor,
        });
      }
    },
    [iframeRef],
  );

  return {
    toolbarState,
    commentPopover,
    quickLabelPicker,
    handleAnnotate,
    handleQuickLabel,
    handleToolbarClose,
    handleRequestComment,
    handleCommentSubmit,
    handleCommentClose,
    handleFloatingQuickLabel,
    handleQuickLabelPickerDismiss,
    removeHighlight,
    clearAllHighlights,
    applyAnnotations,
  };
}
