/**
 * Bridge script injected into the HTML viewer iframe.
 *
 * Handles text selection, annotation marks, theme updates, and resize
 * notifications. Communicates with the parent via postMessage using a
 * "plannotator-bridge-*" message protocol.
 *
 * This is a string constant — it gets prepended to the iframe's srcdoc.
 * No external dependencies.
 */

/**
 * Reads only viewer-namespaced \`--pn-*\` variables (with fallbacks): arbitrary
 * documents may define bare token names like \`--accent\` for themselves, and the
 * viewer must never depend on — or collide with — the author's namespace.
 */
export const ANNOTATION_HIGHLIGHT_CSS = `
.annotation-highlight {
  border-radius: 2px;
  padding: 0 2px;
  margin: 0 -2px;
  cursor: pointer;
}
.annotation-highlight.deletion {
  background: oklch(from var(--pn-destructive, #c0392b) l c h / 0.35);
  text-decoration: line-through;
  text-decoration-color: var(--pn-destructive, #c0392b);
  text-decoration-thickness: 2px;
}
.annotation-highlight.comment {
  background: oklch(0.70 0.18 60 / 0.3);
  border-bottom: 2px solid var(--pn-accent, #d97757);
}
.annotation-highlight.focused {
  background: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.45) !important;
  box-shadow: 0 0 8px oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.4);
  border-bottom: 2px solid var(--pn-focus-highlight, #4493f8);
  filter: none;
}
.annotation-highlight:hover {
  filter: brightness(1.2);
}
/* Vim pinpoint target tint. The MOUSE pinpoint path no longer mutates author
 * elements — it draws the dedicated overlay box below — but keyboard (vim)
 * navigation keeps this class-based visual. */
.plannotator-pinpoint-hover {
  background-color: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.12) !important;
  border-radius: 3px;
  cursor: pointer !important;
}
/* SVG groups can't render a CSS background, so use a soft glow instead. */
.plannotator-pinpoint-hover:is(g, svg) {
  filter: drop-shadow(0 0 4px oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.55));
}
/* Mouse pinpoint hover: a fixed-position outline box sized to the hovered
 * element's rect. Never a class/style write on the page's own elements. */
[data-plannotator-pinpoint-box] {
  position: fixed;
  z-index: 2147483643;
  pointer-events: none;
  display: none;
  box-sizing: border-box;
  border: 2px solid oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.85);
  border-radius: 5px;
  background: oklch(from var(--pn-focus-highlight, #4493f8) l c h / 0.06);
}
[data-plannotator-pinpoint-box].pn-pin-enter {
  animation: pn-pinpoint-in 0.12s ease-out;
}
[data-plannotator-pinpoint-box][data-pinned] {
  border-color: var(--pn-accent, #d97757);
  background: oklch(from var(--pn-accent, #d97757) l c h / 0.08);
}
@keyframes pn-pinpoint-in {
  from { opacity: 0; transform: scale(0.985); }
  to { opacity: 1; transform: scale(1); }
}
/* Numbered pin badges for committed element annotations. */
[data-plannotator-pin-badge] {
  position: fixed;
  z-index: 2147483644;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  transform: translate(-50%, -50%);
  background: var(--pn-accent, #d97757);
  color: #fff;
  font: 700 10px/1 system-ui, -apple-system, sans-serif;
  box-shadow: 0 2px 6px rgba(0,0,0,.25), inset 0 0 0 1px rgba(0,0,0,.06);
  pointer-events: auto;
  cursor: pointer !important;
  user-select: none;
  animation: pn-pin-badge-in 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes pn-pin-badge-in {
  from { opacity: 0; transform: translate(-50%, -50%) scale(0.3); }
  to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
}
/* Pinpoint mode affordance: crosshair everywhere (existing marks and badges
 * stay pointer via their own !important rules below). */
body[data-plannotator-pinpoint-cursor],
body[data-plannotator-pinpoint-cursor] * {
  cursor: crosshair !important;
}
body[data-plannotator-pinpoint-cursor] .annotation-highlight,
body[data-plannotator-pinpoint-cursor] [data-plannotator-pin-badge] {
  cursor: pointer !important;
}
@media (prefers-reduced-motion: reduce) {
  [data-plannotator-pinpoint-box].pn-pin-enter,
  [data-plannotator-pin-badge] {
    animation: none;
  }
}
@media print {
  /* Viewer overlays are review chrome, not page content: never bake pin
     badges, pinpoint boxes/labels, or vim UI into a printed page. The outer
     app chrome is print-hidden by print.css, but this CSS lives inside the
     iframe's own document and must carry its own rule. Inline annotation
     <mark>s stay visible in print on purpose, matching markdown documents. */
  [data-plannotator-pinpoint-box],
  [data-plannotator-pinpoint-label],
  [data-plannotator-pin-badge],
  [data-plannotator-vim-ui],
  [data-plannotator-vim-cursor] {
    display: none !important;
  }
}
body[data-plannotator-vim-focus-owner]:focus {
  outline: none !important;
}
[data-plannotator-vim-cursor] {
  position: fixed;
  z-index: 2147483646;
  width: 2px;
  min-height: 1em;
  border-radius: 2px;
  background: var(--pn-focus-highlight, #4493f8);
  pointer-events: none;
}
[data-plannotator-vim-reticle] {
  position: fixed;
  z-index: 2147483645;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
[data-plannotator-vim-reticle] [data-vim-reticle-fill],
[data-plannotator-vim-reticle] [data-vim-reticle-corner],
[data-plannotator-vim-reticle] [data-vim-reticle-label] {
  position: absolute;
  top: 0;
  left: 0;
  will-change: transform;
  transition: transform 90ms cubic-bezier(.22,1,.36,1);
}
[data-plannotator-vim-reticle] [data-vim-reticle-fill] {
  width: 100px;
  height: 100px;
  transform-origin: 0 0;
  border-radius: 8px;
  background: rgba(167,139,250,.045);
  box-shadow:
    inset 0 0 0 1px rgba(196,181,253,.16),
    0 0 42px rgba(139,92,246,.12);
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner] {
  width: 28px;
  height: 28px;
  border-color: #c4b5fd;
  filter:
    drop-shadow(0 0 6px rgba(167,139,250,.92))
    drop-shadow(0 0 18px rgba(124,58,237,.42));
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="top-left"] {
  border-top: 3px solid;
  border-left: 3px solid;
  border-top-left-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="top-right"] {
  border-top: 3px solid;
  border-right: 3px solid;
  border-top-right-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="bottom-left"] {
  border-bottom: 3px solid;
  border-left: 3px solid;
  border-bottom-left-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-corner="bottom-right"] {
  border-right: 3px solid;
  border-bottom: 3px solid;
  border-bottom-right-radius: 8px;
}
[data-plannotator-vim-reticle] [data-vim-reticle-label] {
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 118px;
  height: 30px;
  max-width: min(280px, calc(100vw - 24px));
  padding: 0 11px;
  overflow: hidden;
  border: 1px solid rgba(216,206,255,.42);
  border-radius: 9px;
  color: #f6f2ff;
  background: rgba(18,14,28,.84);
  box-shadow:
    0 10px 28px rgba(0,0,0,.42),
    0 0 20px rgba(139,92,246,.18);
  backdrop-filter: blur(10px);
  font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .13em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-plannotator-vim-reticle] [data-vim-reticle-label]::before {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 999px;
  background: #c4b5fd;
  box-shadow: 0 0 12px rgba(167,139,250,.94);
  content: "";
}
@media (prefers-reduced-motion: reduce) {
  [data-plannotator-vim-reticle] [data-vim-reticle-fill],
  [data-plannotator-vim-reticle] [data-vim-reticle-corner],
  [data-plannotator-vim-reticle] [data-vim-reticle-label] {
    transition: none;
  }
}
[data-plannotator-vim-badge] {
  position: fixed;
  z-index: 2147483647;
  left: 50%;
  bottom: 12px;
  transform: translateX(-50%);
  padding: 4px 9px;
  border: 1px solid color-mix(in srgb, var(--pn-focus-highlight, #4493f8) 35%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--pn-background, #111) 94%, transparent);
  color: var(--pn-focus-highlight, #4493f8);
  box-shadow: 0 4px 18px rgba(0,0,0,.25);
  font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: .04em;
  pointer-events: none;
}
`;

export const BRIDGE_SCRIPT = `(function() {
  var PREFIX = 'plannotator-bridge-';

  // --- Theme ---
  // The author owns this document. Unless it opted in to host theming
  // (hostTheme), only viewer-namespaced --pn-* properties may be written to its
  // root, and its class list is never touched.
  window.addEventListener('message', function(e) {
    if (e.source !== parent) return;
    if (!e.data) return;
    if (e.data.type === PREFIX + 'set-vim-help') {
      vimHelpOpen = !!e.data.open;
      parent.postMessage({
        type: PREFIX + 'vim-help',
        open: vimHelpOpen
      }, '*');
      return;
    }
    if (e.data.type !== PREFIX + 'theme') return;
    var root = document.documentElement;
    var tokens = e.data.tokens || {};
    var hostTheme = !!e.data.hostTheme;
    for (var key in tokens) {
      if (!tokens.hasOwnProperty(key)) continue;
      if (!hostTheme && key.indexOf('--pn-') !== 0) continue;
      root.style.setProperty(key, tokens[key]);
    }
    if (hostTheme) {
      root.classList.remove('light');
      if (e.data.isLight) root.classList.add('light');
    }
  });

  // --- Resize ---
  var lastHeight = 0;
  function postResize() {
    if (!document.body) return;
    var h = document.body.scrollHeight;
    if (h !== lastHeight) {
      lastHeight = h;
      parent.postMessage({ type: PREFIX + 'resize', height: h }, '*');
    }
  }
  window.addEventListener('load', postResize);

  // --- Selection ---
  var pendingSelection = null;
  var pendingRange = null; // live range for the pending selection (scroll tracking)
  var pendingPinEl = null; // element pinned by a pinpoint click (outline + scroll tracking)
  var pendingPinAnchor = null; // serialized anchor for the pending pin
  var currentInputMethod = 'drag'; // 'drag' = text selection, 'pinpoint' = click an element
  var pinpointHover = null;
  var vimEnabled = false;
  var vimHudEnabled = false;
  var vimPhase = 'inactive';
  var vimActiveMode = 'selection';
  var vimPinpointEl = null;
  var vimVisualBlockAnchorEl = null;
  var vimPendingG = false;
  var vimPendingGTimer = 0;
  var vimHelpOpen = false;
  var vimAddedBodyTabIndex = false;
  var vimActionReturn = null;
  var vimLastActionId = null;
  var vimLastActionContext = 'inactive';
  var vimLastPostedPhase = null;
  // A plain click on an element-annotation target opens the toolbar, but the same
  // click's mouseup schedules a handleSelection() that would see an empty selection
  // and immediately clear it. This flag suppresses that one trailing clear.
  var skipNextClear = false;

  document.addEventListener('mouseup', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint uses click, not drag-select
    if (e.target && e.target.closest && e.target.closest('.annotation-highlight')) return;
    setTimeout(handleSelection, 10);
  });

  // The page fully controls element text, so everything posted as a selection
  // is bounded here before it crosses the bridge (the parent enforces the same
  // cap on its side of the trust boundary). One pinpoint click on a huge
  // <pre>/<table> must not ship megabytes into drafts, feedback, or share URLs.
  var MAX_SELECTION_TEXT = 10000;

  function capSelectionText(text) {
    if (text.length <= MAX_SELECTION_TEXT) return text;
    var cut = MAX_SELECTION_TEXT;
    var last = text.charCodeAt(cut - 1);
    // Never split a surrogate pair: a lone high surrogate at the cut point
    // becomes U+FFFD the moment the string is UTF-8 encoded downstream.
    if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
    return text.slice(0, cut);
  }

  function handleSelection(modeOverride, extras) {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) {
      // Trailing clear from a plain-click element annotation — consume it once.
      if (skipNextClear) { skipNextClear = false; return; }
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
        pendingRange = null;
        clearPendingPin();
      }
      return false;
    }
    skipNextClear = false; // a real text selection happened
    var range = sel.getRangeAt(0);
    var text = capSelectionText(sel.toString().trim());
    if (!text) return false;

    var rect = range.getBoundingClientRect();
    pendingRange = range;
    pendingSelection = {
      text: text,
      startContainerPath: getNodePath(range.startContainer),
      startOffset: range.startOffset,
      endContainerPath: getNodePath(range.endContainer),
      endOffset: range.endOffset
    };

    parent.postMessage({
      type: PREFIX + 'selection',
      text: text,
      modeOverride: modeOverride || undefined,
      anchor: (extras && extras.anchor) || undefined,
      pinpoint: (extras && extras.pinpoint) || undefined,
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    }, '*');
    return true;
  }

  // Keep the toolbar/popover attached while the iframe content scrolls: re-post the
  // pending selection's live rect (parent has no way to see an in-iframe scroll).
  // Capture phase so inner scroll containers count too.
  var scrollRaf = 0;
  function postSelectionRect() {
    scrollRaf = 0;
    if (!pendingSelection) return;
    // Element pins carry no live range — track the pinned element's box instead.
    var tracked = pendingRange || (pendingPinEl && pendingPinEl.isConnected ? pendingPinEl : null);
    if (!tracked) return;
    var r = tracked.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) {
      // Selection scrolled out of view — close the toolbar (matches markdown).
      parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
      pendingSelection = null;
      pendingRange = null;
      clearPendingPin();
      return;
    }
    parent.postMessage({
      type: PREFIX + 'selection-rect',
      rect: { top: r.top, left: r.left, width: r.width, height: r.height }
    }, '*');
  }
  window.addEventListener('scroll', function() {
    if (!pendingSelection) return;
    if (!scrollRaf) scrollRaf = requestAnimationFrame(postSelectionRect);
  }, true);

  // --- Mark Creation ---
  window.addEventListener('message', function(e) {
    if (e.source !== parent) return;
    if (!e.data || !e.data.type) return;
    var type = e.data.type;

    if (type === PREFIX + 'create-mark') {
      var id = e.data.id;
      var annType = e.data.annotationType || 'comment';
      if (pendingSelection) {
        // Text selections wrap a <mark>; element pinpoints (e.g. SVG nodes) carry
        // no range, so there's no inline mark to apply — instead the pinned
        // element gets a numbered pin badge anchored to its box.
        if (pendingSelection.startContainerPath) {
          applyMark(id, annType, pendingSelection);
          if (
            vimActionReturn
            && (vimActionReturn.phase === 'visual' || vimActionReturn.phase === 'visual-block')
          ) {
            vimActionReturn.range = committedMarkRange(id) || vimActionReturn.range;
          }
        } else if (pendingPinEl) {
          registerPin(id, pendingPinEl, pendingPinAnchor);
        }
        pendingSelection = null;
        pendingRange = null;
        window.getSelection().removeAllRanges();
      }
      clearPendingPin();
      restoreVimSemanticTarget();
    }

    else if (type === PREFIX + 'find-and-mark') {
      // Anchor-first restoration: resolve the serialized element anchor and scope
      // the text search to it; a resolved element whose text drifted still gets a
      // pin badge. Document-wide text search remains the fallback (and the only
      // path for anchor-less annotations, e.g. from shared URLs).
      var restoreType = e.data.annotationType || 'comment';
      var anchorEl = resolveAnchorElement(e.data.anchor);
      var found = false;
      var isSvgAnchor = anchorEl && (anchorEl.ownerSVGElement || anchorEl.tagName.toLowerCase() === 'svg');
      if (isSvgAnchor) {
        // SVG content never takes an inline <mark> (it would un-render the
        // text) — a resolved SVG anchor is always a pin, and the HTML-oriented
        // text search below could only mis-mark unrelated HTML text.
        registerPin(e.data.id, anchorEl, e.data.anchor);
        found = true;
      }
      if (!found && anchorEl) {
        found = findTextAndMark(e.data.id, e.data.originalText, restoreType, anchorEl);
      }
      if (!found) {
        // Document-wide text search runs BEFORE the pin fallback: if the
        // annotated text moved elsewhere in a regenerated page, the annotation
        // follows the text rather than badging the stale container.
        found = findTextAndMark(e.data.id, e.data.originalText, restoreType);
      }
      if (!found && anchorEl) {
        // Element still resolves but its text is gone everywhere: badge the
        // element itself as the last resort.
        registerPin(e.data.id, anchorEl, e.data.anchor);
        found = true;
      }
      parent.postMessage({
        type: PREFIX + 'mark-applied',
        id: e.data.id,
        success: found
      }, '*');
    }

    else if (type === PREFIX + 'remove-mark') {
      removeMark(e.data.id);
      unregisterPin(e.data.id);
    }

    else if (type === PREFIX + 'clear-marks') {
      var marks = document.querySelectorAll('.annotation-highlight[data-bind-id]');
      for (var i = marks.length - 1; i >= 0; i--) unwrapMark(marks[i]);
      clearAllPins();
    }

    else if (type === PREFIX + 'cancel-selection') {
      pendingSelection = null;
      pendingRange = null;
      skipNextClear = false;
      clearPendingPin();
      window.getSelection().removeAllRanges();
      restoreVimSemanticTarget();
    }

    else if (type === PREFIX + 'scroll-to') {
      var mark = document.querySelector('[data-bind-id="' + e.data.id + '"]');
      if (mark) {
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        mark.classList.add('focused');
        setTimeout(function() { mark.classList.remove('focused'); }, 2000);
      } else {
        // Pin-only annotation (no inline mark): scroll its element into view and
        // flash the pinned outline over it.
        var pin = findPin(e.data.id);
        if (pin && pin.element && pin.element.isConnected) {
          pin.element.scrollIntoView({ behavior: 'smooth', block: 'center' });
          flashPinnedBox(pin.element);
        }
      }
    }

    else if (type === PREFIX + 'focus-mark') {
      var all = document.querySelectorAll('.annotation-highlight');
      for (var j = 0; j < all.length; j++) all[j].classList.remove('focused');
      if (e.data.id) {
        var target = document.querySelector('[data-bind-id="' + e.data.id + '"]');
        if (target) target.classList.add('focused');
      }
    }

    else if (type === PREFIX + 'set-input-method') {
      currentInputMethod = e.data.method === 'pinpoint' ? 'pinpoint' : 'drag';
      if (currentInputMethod === 'pinpoint') {
        if (document.body) document.body.setAttribute('data-plannotator-pinpoint-cursor', '');
      } else {
        if (document.body) document.body.removeAttribute('data-plannotator-pinpoint-cursor');
        clearPinpointHover();
      }
      if (vimEnabled) updateVimUi();
    }

    else if (type === PREFIX + 'set-vim-mode') {
      var wasVimEnabled = vimEnabled;
      var wasVimHudEnabled = vimHudEnabled;
      vimEnabled = e.data.enabled === true;
      vimHudEnabled = e.data.hudEnabled === true;
      if (wasVimHudEnabled !== vimHudEnabled) vimLastPostedPhase = null;
      vimActiveMode = e.data.mode === 'comment'
        || e.data.mode === 'redline'
        || e.data.mode === 'quickLabel'
        ? e.data.mode
        : 'selection';
      if (!vimEnabled) {
        clearVimUi();
        vimPinpointEl = null;
        vimPhase = 'inactive';
      } else if (!wasVimEnabled) {
        prepareVimFocusOwner();
        vimPhase = 'inactive';
        updateVimUi();
      } else {
        updateVimUi();
      }
    }

    else if (type === PREFIX + 'focus-vim') {
      if (vimEnabled) {
        ensureVimFocus();
        if (vimPhase === 'inactive') resetVimSemanticNavigation();
        updateVimUi();
      }
    }
  });

  // --- Pinpoint: hover to outline the element under the cursor, click to pin ---
  // Hover is pure per-event hit-testing: deep elementFromPoint (piercing open
  // shadow roots) picks the REAL element under the pointer — no tag whitelist,
  // no has-text requirement — so styled div/span prototypes (chips, icon
  // buttons, cards) are individually targetable. Scope control is mouse-only
  // and geometric, matching the markdown pinpoint feel: the deepest element
  // directly under the pointer wins, and pointing at a container's padding or
  // any area not covered by a child selects the container. Elements under
  // 16px on both axes promote to the nearest ancestor at least 16px on one
  // axis (agentation's MIN_CAPTURE_SIZE pattern). The click reuses the normal
  // selection pipeline — select the element's text and run handleSelection()
  // like a drag — the hover visual is a dedicated fixed-position outline box
  // (never a class write on the page's own elements), the click serializes a
  // CSS anchor for later restoration, and element-only pins (SVG, icon
  // buttons) get a numbered badge. The semantic target graph below survives
  // as the vim-navigation vocabulary only; the pointer path never builds it.
  var PINPOINT_SKIP_SELECTOR = 'script,style,noscript,[data-plannotator-vim-ui],[data-plannotator-pin-badge],.annotation-highlight';

  // Identity set of every overlay node the viewer creates inside the page
  // (pin badges, pinpoint box/label, vim UI). Hit-testing excludes overlay
  // nodes by IDENTITY, never by selector match, so page markup carrying our
  // attribute names cannot spoof its way out of (or into) targeting.
  var overlayNodes = new Set();

  // Floor for hover targets (not a whitelist): a decorative dot or hairline
  // under 16px on BOTH axes promotes to the nearest ancestor that is at least
  // 16px on one axis, so tiny leaves stay clickable without precision-mousing.
  var MIN_CAPTURE_SIZE = 16;

  // Headless DOM test environments lay nothing out (every rect is 0x0); size
  // rules only apply when the body actually has a laid-out box.
  function layoutActive() {
    return !!document.body && document.body.getBoundingClientRect().width > 0;
  }

  function deepElementFromPoint(x, y) {
    var el = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(x, y)
      : null;
    var guard = 0;
    while (
      el
      && el.shadowRoot
      && typeof el.shadowRoot.elementFromPoint === 'function'
      && guard++ < 24
    ) {
      var inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function isViewerOverlayNode(node) {
    var current = node;
    var guard = 0;
    while (current && guard++ < 200) {
      if (overlayNodes.has(current)) return true;
      current = current.parentElement
        || (current.getRootNode && current.getRootNode().host)
        || null;
    }
    return false;
  }

  function promoteTinyTarget(el) {
    if (!layoutActive()) return el;
    var r = el.getBoundingClientRect();
    if (r.width >= MIN_CAPTURE_SIZE || r.height >= MIN_CAPTURE_SIZE) return el;
    var current = el.parentElement;
    while (current && current !== document.body && current !== document.documentElement) {
      var cr = current.getBoundingClientRect();
      if (cr.width >= MIN_CAPTURE_SIZE || cr.height >= MIN_CAPTURE_SIZE) return current;
      current = current.parentElement;
    }
    return el;
  }

  // Resolve the pinpoint target at a viewport point. The deepest rendered
  // element under the pointer wins; containers are selected by pointing at
  // their uncovered area (padding, gaps), exactly like the markdown surface.
  // fallbackNode covers engines without a real elementFromPoint (headless DOM
  // tests) and the scroll reconcile, which re-resolves under a still cursor.
  function resolvePinpointTargetAt(x, y, fallbackNode) {
    var node = deepElementFromPoint(x, y);
    if (!node || node === document.documentElement || node === document.body) {
      node = fallbackNode || null;
    }
    while (node && node.nodeType === 3) node = node.parentNode;
    if (!node || node.nodeType !== 1) return null;
    if (node === document.documentElement || node === document.body) return null;
    if (isViewerOverlayNode(node)) return null;
    if (node.closest && node.closest('script,style,noscript')) return null;
    // Annotation marks are viewer chrome wrapped around author text: treat
    // them as transparent so hover names the author element beneath.
    var mark = node.closest && node.closest('.annotation-highlight');
    if (mark && mark.parentElement) node = mark.parentElement;
    // SVG shape primitives promote to their nearest group: a <g> is the
    // authored unit of an SVG diagram, and its <path> fragments are not
    // individually meaningful annotation targets.
    if (node.ownerSVGElement && node.closest) {
      var svgGroup = node.closest('g');
      if (svgGroup) node = svgGroup;
    }
    node = promoteTinyTarget(node);
    if (node === document.body || node === document.documentElement) return null;
    return node;
  }

  // Last-position reuse: a pointer that moved under 2px within 16ms resolves
  // to the cached element instead of re-hit-testing. The scroll reconcile
  // invalidates this cache — same point, different element after a scroll.
  var lastPointerHit = null;
  function pinpointLeafAt(x, y, fallbackNode) {
    var now = typeof performance !== 'undefined' && performance.now
      ? performance.now()
      : Date.now();
    if (
      lastPointerHit
      && Math.abs(x - lastPointerHit.x) <= 2
      && Math.abs(y - lastPointerHit.y) <= 2
      && now - lastPointerHit.t <= 16
      && (!lastPointerHit.el || lastPointerHit.el.isConnected)
    ) {
      return lastPointerHit.el;
    }
    var el = resolvePinpointTargetAt(x, y, fallbackNode);
    lastPointerHit = { x: x, y: y, t: now, el: el };
    return el;
  }
  function invalidatePointerHitCache() {
    lastPointerHit = null;
  }
  var SEMANTIC_BLOCK_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,figcaption,table,button,[data-annotate],svg g';
  var SEMANTIC_GROUP_SELECTOR = 'section,article,aside,nav,header,footer,ul,ol,figure,main';
  var SEMANTIC_INLINE_SELECTOR = 'a,em,strong,b,i,code,small,label,mark,sup,sub,u,abbr,time';
  var semanticTargetKeys = new WeakMap();
  var semanticTargetKeyCounter = 0;

  function semanticTargetKey(el) {
    var existing = semanticTargetKeys.get(el);
    if (existing) return existing;
    semanticTargetKeyCounter += 1;
    var key = 'html-target-' + semanticTargetKeyCounter;
    semanticTargetKeys.set(el, key);
    return key;
  }

  function semanticLabel(el) {
    return PINPOINT_LABELS[el.tagName] || el.tagName.toLowerCase();
  }

  function buildSemanticTargetGraph() {
    var targets = [];
    var blocks = [];
    var byElement = new Map();

    function add(el, kind, parent) {
      if (!el || byElement.has(el) || el.closest(PINPOINT_SKIP_SELECTOR)) return null;
      if (!el.textContent || !el.textContent.trim()) return null;
      var target = {
        key: semanticTargetKey(el),
        element: el,
        kind: kind,
        parentKey: parent ? parent.key : null,
        label: semanticLabel(el)
      };
      targets.push(target);
      byElement.set(el, target);
      return target;
    }

    function addInlineDescendants(root, parent) {
      var inlineElements = Array.prototype.slice.call(root.querySelectorAll(SEMANTIC_INLINE_SELECTOR));
      for (var inlineIndex = 0; inlineIndex < inlineElements.length; inlineIndex++) {
        var inlineEl = inlineElements[inlineIndex];
        var ancestorEl = inlineEl.parentElement && inlineEl.parentElement.closest(SEMANTIC_INLINE_SELECTOR);
        var inlineParent = ancestorEl && root.contains(ancestorEl)
          ? byElement.get(ancestorEl) || parent
          : parent;
        add(inlineEl, 'inline', inlineParent);
      }
    }

    var groupElements = Array.prototype.slice.call(document.querySelectorAll(SEMANTIC_GROUP_SELECTOR));
    for (var groupIndex = 0; groupIndex < groupElements.length; groupIndex++) {
      var groupEl = groupElements[groupIndex];
      var containingGroupEl = groupEl.parentElement && groupEl.parentElement.closest(SEMANTIC_GROUP_SELECTOR);
      add(groupEl, 'group', containingGroupEl ? byElement.get(containingGroupEl) || null : null);
    }

    var blockElements = Array.prototype.slice.call(document.querySelectorAll(SEMANTIC_BLOCK_SELECTOR));
    for (var blockIndex = 0; blockIndex < blockElements.length; blockIndex++) {
      var blockEl = blockElements[blockIndex];
      if (blockEl.closest(PINPOINT_SKIP_SELECTOR)) continue;
      var containingBlock = blockEl.parentElement && blockEl.parentElement.closest(SEMANTIC_BLOCK_SELECTOR);
      if (containingBlock) continue;
      var parentGroupEl = blockEl.parentElement && blockEl.parentElement.closest(SEMANTIC_GROUP_SELECTOR);
      var parentGroup = parentGroupEl ? byElement.get(parentGroupEl) : null;
      var kind = blockEl.tagName === 'TABLE'
        ? 'table'
        : blockEl.tagName === 'PRE'
          ? 'code'
          : 'block';
      var blockTarget = add(blockEl, kind, parentGroup || null);
      if (!blockTarget) continue;
      blocks.push(blockTarget);

      if (blockEl.tagName === 'TABLE') {
        var rows = Array.prototype.slice.call(blockEl.rows || []);
        for (var rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          var rowTarget = add(rows[rowIndex], 'row', blockTarget);
          if (!rowTarget) continue;
          var cells = Array.prototype.slice.call(rows[rowIndex].cells || []);
          for (var cellIndex = 0; cellIndex < cells.length; cellIndex++) {
            var cellTarget = add(cells[cellIndex], 'cell', rowTarget);
            if (cellTarget) {
              cellTarget.rowIndex = rowIndex;
              cellTarget.columnIndex = cellIndex;
              addInlineDescendants(cells[cellIndex], cellTarget);
            }
          }
        }
      } else {
        addInlineDescendants(blockEl, blockTarget);
      }
    }

    return {
      targets: targets,
      blocks: blocks,
      byElement: byElement
    };
  }

  function semanticChildren(graph, target) {
    return graph.targets.filter(function(candidate) {
      return candidate.parentKey === target.key;
    });
  }

  function semanticParent(graph, target) {
    if (!target || !target.parentKey) return null;
    for (var i = 0; i < graph.targets.length; i++) {
      if (graph.targets[i].key === target.parentKey) return graph.targets[i];
    }
    return null;
  }

  function semanticSibling(graph, target, delta) {
    var parent = semanticParent(graph, target);
    if (!parent) return target;
    var siblings = semanticChildren(graph, parent);
    var index = siblings.indexOf(target);
    if (index < 0) return target;
    var nextIndex = Math.max(0, Math.min(siblings.length - 1, index + delta));
    return siblings[nextIndex] || target;
  }

  function semanticOwningBlock(graph, target) {
    var current = target;
    while (current && graph.blocks.indexOf(current) < 0) {
      current = semanticParent(graph, current);
    }
    return current || target;
  }

  function resolveSemanticTarget(graph, node) {
    var el = node;
    while (el && el.nodeType === 3) el = el.parentNode;
    if (
      !el
      || el.nodeType !== 1
      || el === document.documentElement
      || el === document.body
      || el.closest(PINPOINT_SKIP_SELECTOR)
    ) return null;

    if (el.ownerSVGElement && el.closest) {
      var svgGroup = el.closest('g');
      if (svgGroup && graph.byElement.has(svgGroup)) return graph.byElement.get(svgGroup);
    }

    var inline = el.closest && el.closest(SEMANTIC_INLINE_SELECTOR);
    if (inline && graph.byElement.has(inline)) return graph.byElement.get(inline);
    var cell = el.closest && el.closest('td,th');
    if (cell && graph.byElement.has(cell)) return graph.byElement.get(cell);

    var current = el;
    while (current && current !== document.body) {
      if (graph.byElement.has(current)) return graph.byElement.get(current);
      current = current.parentElement;
    }
    return null;
  }

  // Floating label naming the element under the cursor (like the markdown overlay).
  var PINPOINT_LABELS = { H1:'Heading', H2:'Heading', H3:'Heading', H4:'Heading', H5:'Heading', H6:'Heading', P:'Paragraph', UL:'List', OL:'List', LI:'List item', A:'Link', BUTTON:'Button', IMG:'Image', TABLE:'Table', THEAD:'Table', TBODY:'Table', TR:'Row', TD:'Cell', TH:'Header cell', SECTION:'Section', NAV:'Navigation', HEADER:'Header', FOOTER:'Footer', ARTICLE:'Article', ASIDE:'Sidebar', BLOCKQUOTE:'Quote', PRE:'Code', CODE:'Code', FIGURE:'Figure', FIGCAPTION:'Caption', MAIN:'Main', FORM:'Form', INPUT:'Input', LABEL:'Label' };

  var MAX_HOVER_LABEL = 40;
  function truncateLabel(text) {
    return text.length > MAX_HOVER_LABEL ? text.slice(0, MAX_HOVER_LABEL) : text;
  }

  // First 1-2 meaningful class tokens: split on whitespace/underscore/hyphen,
  // drop tokens of 2 chars or fewer and CSS-module-hash-looking tokens, so a
  // div.rowchip labels "rowchip" and styles_Card_ab12f labels "Card".
  function meaningfulClassTokens(el) {
    var out = [];
    if (!el.classList || !el.classList.length) return out;
    for (var i = 0; i < el.classList.length && out.length < 2; i++) {
      var cls = el.classList[i];
      if (isLikelyGeneratedClass(cls)) continue;
      var parts = String(cls).split(/[\\s_-]+/);
      for (var j = 0; j < parts.length && out.length < 2; j++) {
        var token = parts[j];
        if (token.length <= 2) continue;
        if (/^[a-fA-F0-9]+$/.test(token) && token.length >= 5) continue;
        if (/[0-9]{4,}/.test(token)) continue;
        out.push(token);
      }
    }
    return out;
  }

  // Label cascade for generic containers (div/span/custom elements):
  // aria-label -> role -> meaningful class tokens -> own short text ->
  // "container". Known semantic tags keep their human names above.
  function pinpointHoverLabel(el) {
    var known = PINPOINT_LABELS[el.tagName];
    if (known) return known;
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return truncateLabel(aria.trim());
    var role = el.getAttribute && el.getAttribute('role');
    if (role && role.trim()) return truncateLabel(role.trim());
    var tokens = meaningfulClassTokens(el);
    if (tokens.length) return truncateLabel(tokens.join(' '));
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text && text.length <= MAX_HOVER_LABEL) return text;
    return 'container';
  }

  var pinpointLabelEl = null;
  function getPinpointLabelEl() {
    if (!pinpointLabelEl) {
      pinpointLabelEl = document.createElement('div');
      pinpointLabelEl.setAttribute('data-plannotator-pinpoint-label', '');
      pinpointLabelEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;display:none;font:600 11px/1.3 system-ui,-apple-system,sans-serif;padding:2px 7px;border-radius:5px;background:var(--pn-focus-highlight,#4493f8);color:#fff;white-space:nowrap;box-shadow:0 1px 5px rgba(0,0,0,.35);';
      overlayNodes.add(pinpointLabelEl);
    }
    if (!pinpointLabelEl.isConnected) document.body.appendChild(pinpointLabelEl);
    return pinpointLabelEl;
  }
  function hidePinpointLabel() { if (pinpointLabelEl) pinpointLabelEl.style.display = 'none'; }

  // Hover outline box: fixed-position, pointer-events none, sized to the
  // hovered element's live rect. The page DOM is never touched for hover.
  var pinpointBoxEl = null;
  function getPinpointBoxEl() {
    if (!pinpointBoxEl) {
      pinpointBoxEl = document.createElement('div');
      pinpointBoxEl.setAttribute('data-plannotator-pinpoint-box', '');
      pinpointBoxEl.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(pinpointBoxEl);
    }
    if (!pinpointBoxEl.isConnected) document.body.appendChild(pinpointBoxEl);
    return pinpointBoxEl;
  }
  function positionPinpointBox(el) {
    var r = el.getBoundingClientRect();
    var box = getPinpointBoxEl();
    box.style.display = 'block';
    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = r.width + 'px';
    box.style.height = r.height + 'px';
  }
  function hidePinpointBox() {
    if (pinpointBoxEl) {
      pinpointBoxEl.style.display = 'none';
      pinpointBoxEl.removeAttribute('data-pinned');
      pinpointBoxEl.classList.remove('pn-pin-enter');
    }
  }
  function clearPinpointHover() {
    pinpointHover = null;
    if (!pendingPinEl) hidePinpointBox();
    hidePinpointLabel();
  }
  function positionPinpointLabel(el, labelText) {
    var r = el.getBoundingClientRect();
    var lbl = getPinpointLabelEl();
    lbl.textContent = labelText;
    lbl.style.display = 'block';
    // Flip below the element when the pill would leave the viewport top.
    var top = r.top - 22;
    if (top < 2) top = Math.min(r.bottom + 4, window.innerHeight - 24);
    lbl.style.top = top + 'px';
    lbl.style.left = Math.max(2, Math.min(r.left, window.innerWidth - 120)) + 'px';
  }

  // Identity-gated hover update (only restyle when the resolved element
  // changes); shared by mousemove and the scroll/resize reconcile pass.
  // Per-event hit-testing only — never builds the semantic graph.
  function updatePinpointHover(x, y, fallbackNode) {
    var el = pinpointLeafAt(x, y, fallbackNode);
    if (el !== pinpointHover) {
      pinpointHover = el;
      if (el && !pendingPinEl) {
        var box = getPinpointBoxEl();
        box.classList.remove('pn-pin-enter');
        void box.offsetWidth; // restart the enter animation
        box.classList.add('pn-pin-enter');
        positionPinpointBox(el);
      } else if (!pendingPinEl) {
        hidePinpointBox();
      }
    } else if (el && !pendingPinEl) {
      positionPinpointBox(el); // same element — keep the box glued while scrolling
    }
    if (!el || pendingPinEl) { hidePinpointLabel(); return; }
    positionPinpointLabel(el, pinpointHoverLabel(el));
  }

  var lastPointer = null;
  document.addEventListener('mousemove', function(e) {
    lastPointer = { x: e.clientX, y: e.clientY };
    if (currentInputMethod !== 'pinpoint') return;
    if (vimEnabled && vimPhase !== 'inactive') return;
    // Hit-test at the pointer (e.target only backstops engines without
    // elementFromPoint) so the same code path serves the scroll re-hit-test.
    updatePinpointHover(e.clientX, e.clientY, e.target);
  });

  // rAF-coalesced reconcile: keeps the hover box under a stationary cursor
  // while the page scrolls, tracks the pinned element, and repositions pin
  // badges. Capture-phase scroll so inner scroll containers count too.
  var pinpointReconcileRaf = 0;
  function schedulePinpointReconcile() {
    if (pinpointReconcileRaf) return;
    pinpointReconcileRaf = requestAnimationFrame(function() {
      pinpointReconcileRaf = 0;
      // Same point, possibly a different element after a scroll, resize, or
      // layout-changing mutation (the body ResizeObserver also lands here) —
      // the last-position cache must never answer the next probe.
      invalidatePointerHitCache();
      renderPinBadges();
      if (pendingPinEl && pendingPinEl.isConnected) {
        positionPinpointBox(pendingPinEl);
        return;
      }
      if (currentInputMethod !== 'pinpoint') return;
      if (vimEnabled && vimPhase !== 'inactive') return;
      if (lastPointer) {
        updatePinpointHover(lastPointer.x, lastPointer.y, pinpointHover);
      }
    });
  }
  window.addEventListener('scroll', schedulePinpointReconcile, { passive: true, capture: true });
  window.addEventListener('resize', schedulePinpointReconcile, { passive: true });

  // --- Pin badges: numbered markers for element-only annotations ---
  var pinRegistry = []; // { id, element, anchor, badge }
  function findPin(id) {
    for (var i = 0; i < pinRegistry.length; i++) {
      if (pinRegistry[i].id === id) return pinRegistry[i];
    }
    return null;
  }
  function registerPin(id, element, anchor) {
    if (findPin(id)) return;
    var badge = document.createElement('div');
    badge.setAttribute('data-plannotator-pin-badge', '');
    badge.setAttribute('data-plannotator-vim-ui', '');
    badge.addEventListener('click', function(clickEvent) {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      parent.postMessage({ type: PREFIX + 'mark-click', id: id }, '*');
    });
    overlayNodes.add(badge);
    document.body.appendChild(badge);
    pinRegistry.push({ id: id, element: element, anchor: anchor || null, badge: badge });
    renderPinBadges();
  }
  function unregisterPin(id) {
    for (var i = pinRegistry.length - 1; i >= 0; i--) {
      if (pinRegistry[i].id === id) {
        var badge = pinRegistry[i].badge;
        if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
        overlayNodes.delete(badge);
        pinRegistry.splice(i, 1);
      }
    }
    renderPinBadges();
  }
  function clearAllPins() {
    for (var i = 0; i < pinRegistry.length; i++) {
      var badge = pinRegistry[i].badge;
      if (badge && badge.parentNode) badge.parentNode.removeChild(badge);
      overlayNodes.delete(badge);
    }
    pinRegistry = [];
  }
  function renderPinBadges() {
    for (var i = 0; i < pinRegistry.length; i++) {
      var pin = pinRegistry[i];
      if ((!pin.element || !pin.element.isConnected) && pin.anchor) {
        // The page re-rendered under the pin — re-acquire through the anchor.
        pin.element = resolveAnchorElement(pin.anchor);
      }
      // Number by registry (creation) order, independent of visibility.
      pin.badge.textContent = String(i + 1);
      if (!pin.element || !pin.element.isConnected) {
        pin.badge.style.display = 'none';
        continue;
      }
      var r = pin.element.getBoundingClientRect();
      // A 0x0 rect means the element isn't rendered (display:none) — but only
      // in engines that lay out at all (body has size), so headless DOM test
      // environments where every rect is 0x0 don't hide everything.
      var zeroSize = !r.width && !r.height
        && document.body.getBoundingClientRect().width > 0;
      if (zeroSize || r.bottom < 0 || r.top > window.innerHeight) {
        pin.badge.style.display = 'none';
        continue;
      }
      pin.badge.style.display = 'flex';
      pin.badge.style.left = Math.min(r.right, window.innerWidth - 4) + 'px';
      pin.badge.style.top = Math.max(4, r.top) + 'px';
    }
  }
  function flashPinnedBox(el) {
    var box = getPinpointBoxEl();
    box.setAttribute('data-pinned', '');
    positionPinpointBox(el);
    setTimeout(function() {
      if (!pendingPinEl) hidePinpointBox();
    }, 1200);
  }

  // --- Element anchors: verified-unique CSS selectors for restoration ---
  // Semantic ladder (id → identity attribute → meaningful classes), each rung
  // proved unique with a real query before acceptance; positional
  // tag > tag:nth-of-type() path as the last resort. Restoration fails closed:
  // a weak (positional/class) selector must also match the captured text
  // snapshot, so a shifted list never mis-anchors an annotation.
  var ANCHOR_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa', 'aria-label', 'name', 'role', 'href', 'alt'];

  function anchorTextSnapshot(el) {
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.length > 180 ? text.slice(0, 180) : text;
  }

  function uniquelySelects(selector, el) {
    try {
      var matches = document.querySelectorAll(selector);
      return matches.length === 1 && matches[0] === el;
    } catch (ex) {
      return false;
    }
  }

  function escapeAttrValue(value) {
    return '"' + value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"';
  }

  function isLikelyGeneratedClass(name) {
    if (name.length > 36) return true;
    if (/^[a-f0-9]{8,}$/i.test(name)) return true;
    if (/[A-Za-z]+[_-][A-Za-z]*[0-9]{4,}/.test(name)) return true;
    return false;
  }

  function semanticSelectorFor(el) {
    var tag = el.tagName.toLowerCase();
    var canEscape = typeof CSS !== 'undefined' && CSS.escape;
    if (el.id && canEscape) {
      var idSel = '#' + CSS.escape(el.id);
      if (uniquelySelects(idSel, el)) return idSel;
    }
    for (var i = 0; i < ANCHOR_IDENTITY_ATTRS.length; i++) {
      var name = ANCHOR_IDENTITY_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      value = value.trim();
      if (!value || value.length > 240 || value.indexOf('\\n') >= 0) continue;
      var attrSel = tag + '[' + name + '=' + escapeAttrValue(value) + ']';
      if (uniquelySelects(attrSel, el)) return attrSel;
    }
    if (canEscape && el.classList && el.classList.length) {
      var meaningful = [];
      for (var c = 0; c < el.classList.length && meaningful.length < 2; c++) {
        var cls = el.classList[c];
        if (isLikelyGeneratedClass(cls)) continue;
        meaningful.push('.' + CSS.escape(cls));
      }
      if (meaningful.length) {
        var classSel = tag + meaningful.join('');
        if (uniquelySelects(classSel, el)) return classSel;
      }
    }
    return null;
  }

  // Each ancestor step runs a document-wide uniqueness query against a
  // selector that grows with the path, so cost is quadratic in depth. Real
  // documents anchor within a few levels; a degenerate deeply-wrapped chain
  // (templated exports, generated markup) must not freeze the tab on a
  // single pinpoint click. Past the cap the anchor is abandoned (fail
  // closed): text-search restoration still works, and no anchor beats one
  // that costs seconds of synchronous main-thread time.
  var MAX_ANCHOR_PATH_DEPTH = 40;

  function buildAnchorSelector(el) {
    var path = [];
    var current = el;
    var depth = 0;
    while (current && current.nodeType === 1 && current !== document.body && current !== document.documentElement) {
      if (++depth > MAX_ANCHOR_PATH_DEPTH) return null;
      var semantic = semanticSelectorFor(current);
      if (semantic) {
        path.unshift(semantic);
        return path.join(' > ');
      }
      var segment = current.tagName.toLowerCase();
      var parentEl = current.parentElement;
      if (parentEl) {
        var sameTag = [];
        for (var i = 0; i < parentEl.children.length; i++) {
          if (parentEl.children[i].tagName === current.tagName) sameTag.push(parentEl.children[i]);
        }
        if (sameTag.length > 1) segment += ':nth-of-type(' + (sameTag.indexOf(current) + 1) + ')';
      }
      path.unshift(segment);
      var candidate = path.join(' > ');
      if (uniquelySelects(candidate, el)) return candidate;
      current = parentEl;
    }
    // Reaching here means every candidate — including the full body-rooted
    // path — failed the uniqueness query. A known-ambiguous selector must not
    // ship as an anchor: no anchor (text-search restoration) beats one that
    // can bind to the wrong element after a re-render.
    return null;
  }

  function buildElementAnchor(el) {
    if (!el || el.nodeType !== 1) return null;
    var selector = buildAnchorSelector(el);
    if (!selector) return null;
    var snapshot = anchorTextSnapshot(el);
    // Text-less elements anchor ONLY through a stable-identity rung (#id or
    // an author-controlled data-* identity attribute). A weak (positional /
    // class) selector has nothing to verify against — identical siblings
    // share every structural trait, so any derived signature would validate
    // the WRONG element after a sibling is inserted or removed. A
    // wrong-binding anchor is worse than no anchor: ship none and fail
    // closed (the pin simply doesn't restore).
    if (!snapshot && !anchorHasStableIdentity(selector, el)) return null;
    return {
      selector: selector,
      tagName: el.tagName.toLowerCase(),
      text: snapshot
    };
  }

  // Stable identity: the selector IS the resolved element's own #id or data-*
  // rung, re-derived from the element itself and compared whole — never parsed
  // out of the selector string (an attribute value containing ' > ' or '#'
  // would fool a string parse). Behavioral attributes (role, href, aria-label,
  // name, alt) identify what an element does, not what it says, so they never
  // exempt an anchor from the text check: a regenerated page keeps its
  // role="button" while the button's meaning changes completely.
  var STABLE_IDENTITY_ATTRS = ['data-annotate', 'data-testid', 'data-test', 'data-test-id', 'data-cy', 'data-qa'];

  function anchorHasStableIdentity(selector, el) {
    var canEscape = typeof CSS !== 'undefined' && CSS.escape;
    if (el.id && canEscape && selector === '#' + CSS.escape(el.id)) return true;
    var tag = el.tagName.toLowerCase();
    for (var i = 0; i < STABLE_IDENTITY_ATTRS.length; i++) {
      var name = STABLE_IDENTITY_ATTRS[i];
      var value = el.getAttribute && el.getAttribute(name);
      if (!value) continue;
      if (selector === tag + '[' + name + '=' + escapeAttrValue(value.trim()) + ']') return true;
    }
    return false;
  }

  function resolveAnchorElement(anchor) {
    if (!anchor || typeof anchor.selector !== 'string' || !anchor.selector || typeof anchor.tagName !== 'string') return null;
    var matches;
    try {
      matches = document.querySelectorAll(anchor.selector);
    } catch (ex) {
      return null;
    }
    if (matches.length !== 1) return null;
    var el = matches[0];
    if (el.tagName.toLowerCase() !== anchor.tagName.toLowerCase()) return null;
    if (!anchorHasStableIdentity(anchor.selector, el)) {
      // Weak (positional / class / behavioral-attribute) anchor: the captured
      // text snapshot must exist and still match, or the anchor is rejected and
      // restoration falls back to text search. A missing or empty snapshot is a
      // rejection, not an exemption.
      if (typeof anchor.text !== 'string' || !anchor.text) return null;
      if (anchorTextSnapshot(el) !== anchor.text) return null;
    }
    return el;
  }

  function clearPendingPin() {
    pendingPinEl = null;
    pendingPinAnchor = null;
    hidePinpointBox();
  }

  // Pin an element: select its text if possible (so a <mark> can wrap it), else
  // post its text + box directly so the toolbar still anchors (e.g. an SVG node,
  // whose <text> doesn't select like HTML text). Either way the element stays
  // outlined ("pinned") while the composer is open, and a serialized CSS anchor
  // rides along so the annotation can restore to this exact element later.
  function annotateElement(el, modeOverride, viaPinpoint) {
    if (!el) return false;
    pinpointHover = null;
    hidePinpointLabel();
    pendingPinEl = el;
    pendingPinAnchor = buildElementAnchor(el);
    var extras = { anchor: pendingPinAnchor, pinpoint: !!viaPinpoint };
    // Pinned outline: stronger accent box that tracks the element until the
    // composer resolves (create-mark or cancel-selection).
    var box = getPinpointBoxEl();
    box.setAttribute('data-pinned', '');
    box.classList.remove('pn-pin-enter');
    positionPinpointBox(el);
    // SVG content can't hold an HTML <mark> wrapper — wrapping an SVG <text> in a
    // <mark> un-renders it (the text disappears). So never text-wrap SVG: treat it
    // as a whole-element annotation (post its text + box, no mark). HTML elements
    // still try a real text selection first so a <mark> can highlight the words.
    var txt = '';
    if (!el.ownerSVGElement) {
      try {
        var sel = window.getSelection();
        sel.removeAllRanges();
        var range = document.createRange();
        range.selectNodeContents(el);
        sel.addRange(range);
        txt = (sel.toString() || '').trim();
      } catch (ex) {}
    }
    if (txt) {
      var posted = handleSelection(modeOverride, extras);
      if (!posted) clearPendingPin();
      return posted;
    }
    var elText = capSelectionText((el.textContent || '').trim());
    // Text-less elements (icon buttons, decorative chips, empty containers)
    // are still annotatable: describe the element instead of quoting it.
    if (!elText) elText = capSelectionText('[element: ' + pinpointHoverLabel(el) + ']');
    var r = el.getBoundingClientRect();
    pendingSelection = { element: true };
    pendingRange = null;
    skipNextClear = true; // don't let this click's mouseup clear the toolbar we just opened
    parent.postMessage({ type: PREFIX + 'selection', text: elText,
      modeOverride: modeOverride || undefined,
      anchor: pendingPinAnchor || undefined,
      pinpoint: !!viaPinpoint || undefined,
      rect: { top: r.top, left: r.left, width: r.width, height: r.height } }, '*');
    return true;
  }

  document.addEventListener('click', function(e) {
    if (currentInputMethod !== 'pinpoint') return;
    // Existing marks are handled by the mark-click listener.
    if (e.target && e.target.closest && e.target.closest('.annotation-highlight[data-bind-id]')) return;
    // Real pin badges (and any other viewer overlay) own their clicks —
    // checked by IDENTITY, not selector, so a page element spoofing
    // [data-plannotator-pin-badge] stays an ordinary annotatable target.
    if (isViewerOverlayNode(e.target)) return;
    // Click what the hover box shows: the currently hovered element is the
    // target the user aimed at. Fall back to a fresh hit-test at the click
    // point (e.g. a click with no preceding mousemove).
    var el = pinpointHover && pinpointHover.isConnected
      ? pinpointHover
      : resolvePinpointTargetAt(e.clientX, e.clientY, e.target);
    if (!el) return;
    // Suppress the page's own behavior (links, buttons) — we're annotating.
    e.preventDefault();
    e.stopPropagation();
    annotateElement(el, undefined, true);
  }, true);

  // Escape while pinpointing (outside vim, which has its own ladder): cancel a
  // pending pin, else just drop the hover outline.
  document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape' || vimEnabled) return;
    if (pendingSelection) {
      parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
      pendingSelection = null;
      pendingRange = null;
      skipNextClear = false;
      clearPendingPin();
      window.getSelection().removeAllRanges();
    } else if (currentInputMethod === 'pinpoint') {
      clearPinpointHover();
    }
  });

  // Author opt-in: a plain click on any element tagged [data-annotate] pops the
  // toolbar — no pinpoint mode. Lets an HTML doc (e.g. a flow graph) wire its own
  // nodes to Plannotator's toolbar. Bubble phase so the page's own click handlers
  // run first; an active text selection is respected, not clobbered.
  document.addEventListener('click', function(e) {
    if (currentInputMethod === 'pinpoint') return; // pinpoint handler covers this
    var t = e.target && e.target.closest && e.target.closest('[data-annotate]');
    if (!t) return;
    if (e.target.closest('.annotation-highlight[data-bind-id]')) return;
    var s = window.getSelection();
    if (s && !s.isCollapsed && (s.toString() || '').trim()) return; // respect a drag-selection
    annotateElement(t);
  });

  // --- Mark Click ---
  document.addEventListener('click', function(e) {
    var mark = e.target.closest ? e.target.closest('.annotation-highlight[data-bind-id]') : null;
    if (mark) {
      e.stopPropagation();
      parent.postMessage({
        type: PREFIX + 'mark-click',
        id: mark.getAttribute('data-bind-id')
      }, '*');
    }
  });

  // --- Optional Vim navigation ---
  // The bridge owns iframe-local ranges and focus. The parent only enables the
  // feature and receives the same selection messages used by pointer input.
  function isVimEditableTarget(node) {
    var el = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!el || !el.closest) return false;
    return !!el.closest('button,input,textarea,select,a[href],summary,[contenteditable]:not([contenteditable="false"]),[role="button"],[role="link"],[role="textbox"],[role="dialog"],[data-plannotator-vim-ui]');
  }

  function prepareVimFocusOwner() {
    if (!document.body) return;
    document.body.setAttribute('data-plannotator-vim-focus-owner', '');
    if (!document.body.hasAttribute('tabindex')) {
      document.body.setAttribute('tabindex', '-1');
      vimAddedBodyTabIndex = true;
    }
  }

  function ensureVimFocus() {
    prepareVimFocusOwner();
    if (!document.body) return;
    try { document.body.focus({ preventScroll: true }); } catch (ex) {
      try { document.body.focus(); } catch (ignore) {}
    }
  }

  function getVimTextNodes(root) {
    var scope = root || document.body;
    if (!scope) return [];
    var nodes = [];
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        var parentEl = node.parentElement;
        if (!parentEl || !node.data || !node.data.length) return NodeFilter.FILTER_REJECT;
        if (parentEl.closest('script,style,noscript,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[data-plannotator-vim-ui]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    return nodes;
  }

  function nearestVisibleTextNode() {
    var nodes = getVimTextNodes();
    if (!nodes.length) return null;
    var centerY = window.innerHeight / 2;
    var best = nodes[0];
    var bestDistance = Infinity;
    for (var i = 0; i < nodes.length; i++) {
      var range = document.createRange();
      range.selectNodeContents(nodes[i]);
      var rect = range.getBoundingClientRect();
      if (!rect.height && !rect.width) continue;
      var distance = Math.abs((rect.top + rect.bottom) / 2 - centerY);
      if (distance < bestDistance) {
        best = nodes[i];
        bestDistance = distance;
      }
    }
    return best;
  }

  function setCollapsedSelection(node, offset) {
    if (!node) return false;
    var selection = window.getSelection();
    if (!selection) return false;
    var range = document.createRange();
    range.setStart(node, Math.max(0, Math.min(offset || 0, node.length || 0)));
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function ensureVimTextCursor() {
    var selection = window.getSelection();
    if (selection && selection.rangeCount && selection.focusNode && document.body.contains(selection.focusNode)) {
      return true;
    }
    return setCollapsedSelection(nearestVisibleTextNode(), 0);
  }

  function currentVimPreciseTarget() {
    var graph = buildSemanticTargetGraph();
    var target = currentVimSemanticTarget(graph);
    return target && (target.kind === 'inline' || target.kind === 'row' || target.kind === 'cell')
      ? target.element
      : null;
  }

  function setVimSelectionFocus(selection, node, offset) {
    if (vimPhase === 'visual' && selection.anchorNode) {
      selection.setBaseAndExtent(
        selection.anchorNode,
        selection.anchorOffset,
        node,
        offset
      );
      return true;
    }
    return setCollapsedSelection(node, offset);
  }

  function clampVimSelectionToTarget(selection, target, direction) {
    if (!target || !selection) return false;
    if (selection.focusNode && target.contains(selection.focusNode)) return true;
    var nodes = getVimTextNodes(target);
    if (!nodes.length) return false;
    var boundaryNode = direction === 'backward' ? nodes[0] : nodes[nodes.length - 1];
    var boundaryOffset = direction === 'backward' ? 0 : boundaryNode.length;
    return setVimSelectionFocus(selection, boundaryNode, boundaryOffset);
  }

  function syncVimTargetToSelection(selection) {
    if (!selection || !selection.focusNode) return;
    var graph = buildSemanticTargetGraph();
    var resolved = resolveSemanticTarget(graph, selection.focusNode);
    if (resolved) vimPinpointEl = semanticOwningBlock(graph, resolved).element;
  }

  function modifyVimSelection(direction, granularity) {
    if (!ensureVimTextCursor()) return false;
    var selection = window.getSelection();
    if (!selection || typeof selection.modify !== 'function') return false;
    var preciseTarget = currentVimPreciseTarget();
    selection.modify(vimPhase === 'visual' ? 'extend' : 'move', direction, granularity);
    if (preciseTarget) clampVimSelectionToTarget(selection, preciseTarget, direction);
    else syncVimTargetToSelection(selection);
    updateVimUi();
    return true;
  }

  function vimTextPointForOffset(nodes, offset) {
    var remaining = Math.max(0, offset);
    for (var i = 0; i < nodes.length; i++) {
      if (remaining <= nodes[i].length) return { node: nodes[i], offset: remaining };
      remaining -= nodes[i].length;
    }
    var last = nodes[nodes.length - 1];
    return last ? { node: last, offset: last.length } : null;
  }

  function vimTextOffsetForPoint(nodes, node, offset) {
    var total = 0;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i] === node) return total + Math.max(0, Math.min(offset, nodes[i].length));
      total += nodes[i].length;
    }
    return null;
  }

  function moveVimWord(motion) {
    if (!ensureVimTextCursor()) return false;
    var selection = window.getSelection();
    var preciseTarget = currentVimPreciseTarget();
    var textTarget = preciseTarget || currentVimBlock();
    if (!selection || !selection.focusNode || !textTarget || !Intl.Segmenter) {
      return modifyVimSelection(motion === 'backward' ? 'backward' : 'forward', 'word');
    }
    var nodes = getVimTextNodes(textTarget);
    var focusOffset = vimTextOffsetForPoint(nodes, selection.focusNode, selection.focusOffset);
    if (focusOffset === null) return false;
    var text = nodes.map(function(node) { return node.data; }).join('');
    var words = Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment(text))
      .filter(function(segment) { return segment.isWordLike; });
    var targetOffset = null;
    if (motion === 'backward') {
      for (var i = words.length - 1; i >= 0; i--) {
        if (words[i].index < focusOffset) { targetOffset = words[i].index; break; }
      }
    } else if (motion === 'end') {
      for (var j = 0; j < words.length; j++) {
        var end = words[j].index + words[j].segment.length;
        if (end > focusOffset) { targetOffset = end; break; }
      }
    } else {
      for (var k = 0; k < words.length; k++) {
        if (words[k].index > focusOffset) { targetOffset = words[k].index; break; }
      }
    }
    if (targetOffset === null) {
      if (preciseTarget) {
        var boundaryNode = motion === 'backward' ? nodes[0] : nodes[nodes.length - 1];
        var boundaryOffset = motion === 'backward' ? 0 : boundaryNode.length;
        var movedToBoundary = setVimSelectionFocus(
          selection,
          boundaryNode,
          boundaryOffset
        );
        updateVimUi();
        return movedToBoundary;
      }
      return modifyVimSelection(motion === 'backward' ? 'backward' : 'forward', 'word');
    }
    var point = vimTextPointForOffset(nodes, targetOffset);
    if (!point) return false;
    setVimSelectionFocus(selection, point.node, point.offset);
    updateVimUi();
    return true;
  }

  function currentVimBlock() {
    var graph = buildSemanticTargetGraph();
    var selection = window.getSelection();
    var node = selection && selection.focusNode;
    var resolved = resolveSemanticTarget(graph, node);
    if (resolved && (vimPhase === 'text' || vimPhase === 'visual')) {
      return semanticOwningBlock(graph, resolved).element;
    }
    var semantic = currentVimSemanticTarget(graph);
    return semantic ? semanticOwningBlock(graph, semantic).element : null;
  }

  function selectVimBlock(block, resetAnchor) {
    if (!block) return false;
    if (resetAnchor !== false) vimVisualBlockAnchorEl = block;
    var range = document.createRange();
    range.selectNodeContents(block);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return true;
  }

  function vimBlocks() {
    return buildSemanticTargetGraph().blocks.map(function(target) {
      return target.element;
    });
  }

  function moveVimVisualBlock(delta) {
    var blocks = vimBlocks();
    if (!blocks.length) return false;
    var current = currentVimBlock();
    var index = blocks.indexOf(current);
    if (index < 0) index = 0;
    var nextIndex = Math.max(0, Math.min(blocks.length - 1, index + delta));
    var next = blocks[nextIndex];
    var anchor = vimVisualBlockAnchorEl || current || next;
    var anchorIndex = blocks.indexOf(anchor);
    if (anchorIndex < 0) {
      anchor = next;
      anchorIndex = nextIndex;
      vimVisualBlockAnchorEl = anchor;
    }
    var selection = window.getSelection();
    if (!selection) return false;
    var anchorTexts = getVimTextNodes(anchor);
    var nextTexts = getVimTextNodes(next);
    if (!anchorTexts.length || !nextTexts.length) return false;
    if (nextIndex >= anchorIndex) {
      selection.setBaseAndExtent(
        anchorTexts[0],
        0,
        nextTexts[nextTexts.length - 1],
        nextTexts[nextTexts.length - 1].length
      );
    } else {
      selection.setBaseAndExtent(
        anchorTexts[anchorTexts.length - 1],
        anchorTexts[anchorTexts.length - 1].length,
        nextTexts[0],
        0
      );
    }
    vimPinpointEl = next;
    next.scrollIntoView({ block: 'nearest' });
    updateVimUi();
    return true;
  }

  function moveVimDocumentBoundary(end) {
    var nodes = getVimTextNodes();
    if (!nodes.length) return false;
    var node = end ? nodes[nodes.length - 1] : nodes[0];
    var offset = end ? node.length : 0;
    var selection = window.getSelection();
    if (!selection) return false;
    if (vimPhase !== 'visual' || !selection.anchorNode) {
      setCollapsedSelection(node, offset);
    } else {
      selection.setBaseAndExtent(selection.anchorNode, selection.anchorOffset, node, offset);
    }
    node.parentElement && node.parentElement.scrollIntoView({ block: 'nearest' });
    updateVimUi();
    return true;
  }

  function currentVimSemanticTarget(graph) {
    return vimPinpointEl ? graph.byElement.get(vimPinpointEl) || null : null;
  }

  function semanticVimPhase(target) {
    return target && (target.kind === 'inline' || target.kind === 'row' || target.kind === 'cell')
      ? 'inline'
      : 'block';
  }

  function setVimPinpointTarget(target) {
    clearPinpointHover();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimVisualBlockAnchorEl = null;
    vimPinpointEl = target ? target.element : null;
    if (vimPinpointEl) {
      vimPhase = semanticVimPhase(target);
      window.getSelection().removeAllRanges();
      vimPinpointEl.scrollIntoView({ block: 'nearest' });
      if (vimHudEnabled) {
        hidePinpointLabel();
      } else {
        vimPinpointEl.classList.add('plannotator-pinpoint-hover');
        var r = vimPinpointEl.getBoundingClientRect();
        var lbl = getPinpointLabelEl();
        lbl.textContent = target.label;
        lbl.style.display = 'block';
        lbl.style.top = Math.max(2, r.top - 22) + 'px';
        lbl.style.left = Math.max(2, r.left) + 'px';
      }
    } else {
      hidePinpointLabel();
    }
    updateVimUi();
  }

  function initialVimPinpointTarget() {
    var graph = buildSemanticTargetGraph();
    if (!graph.blocks.length) return null;
    var centerY = window.innerHeight / 2;
    var blocks = graph.blocks.slice();
    blocks.sort(function(a, b) {
      var ar = a.element.getBoundingClientRect();
      var br = b.element.getBoundingClientRect();
      return Math.abs((ar.top + ar.bottom) / 2 - centerY) - Math.abs((br.top + br.bottom) / 2 - centerY);
    });
    return blocks[0];
  }

  function moveVimPinpoint(delta, blocksOnly) {
    var graph = buildSemanticTargetGraph();
    if (!graph.blocks.length) return false;
    var current = currentVimSemanticTarget(graph) || initialVimPinpointTarget();
    if (!current) return false;

    if (vimPhase === 'inline' && !blocksOnly) {
      setVimPinpointTarget(semanticSibling(graph, current, delta));
      return true;
    }

    var block = semanticOwningBlock(graph, current);
    var index = graph.blocks.indexOf(block);
    if (index < 0) index = 0;
    var nextIndex = Math.max(0, Math.min(graph.blocks.length - 1, index + delta));
    setVimPinpointTarget(graph.blocks[nextIndex]);
    return true;
  }

  function refineVimPinpoint(inward) {
    var graph = buildSemanticTargetGraph();
    var current = currentVimSemanticTarget(graph);
    if (!current) {
      current = initialVimPinpointTarget();
      if (current) setVimPinpointTarget(current);
    }
    if (!current) return false;

    if (!inward) {
      var parent = semanticParent(graph, current);
      if (parent) {
        setVimPinpointTarget(parent);
        return true;
      }
      return true;
    }

    var child = semanticChildren(graph, current)[0];
    if (child) {
      setVimPinpointTarget(child);
      return true;
    }
    enterVimTextTarget(current);
    return true;
  }

  function enterVimTextTarget(target) {
    if (!target || !target.element) return false;
    var nodes = getVimTextNodes(target.element);
    if (!nodes.length) return false;
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    hidePinpointLabel();
    vimVisualBlockAnchorEl = null;
    vimPinpointEl = target.element;
    vimPhase = 'text';
    setCollapsedSelection(nodes[0], 0);
    updateVimUi();
    return true;
  }

  function resetVimSemanticNavigation() {
    if (!vimEnabled) return;
    window.getSelection().removeAllRanges();
    setVimPinpointTarget(initialVimPinpointTarget());
  }

  function restoreVimSemanticTarget() {
    if (!vimEnabled) return;
    if (vimPhase === 'action' && restoreVimActionState()) return;
    var graph = buildSemanticTargetGraph();
    var target = currentVimSemanticTarget(graph) || initialVimPinpointTarget();
    if (target) setVimPinpointTarget(target);
    else {
      vimPinpointEl = null;
      vimPhase = 'inactive';
      hidePinpointLabel();
      updateVimUi();
    }
  }

  function rememberVimActionState() {
    var selection = window.getSelection();
    var range = selection && selection.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null;
    vimActionReturn = {
      phase: vimPhase,
      pinpointEl: vimPinpointEl,
      visualBlockAnchorEl: vimVisualBlockAnchorEl,
      range: range
    };
  }

  function committedMarkRange(id) {
    var marks = document.querySelectorAll('[data-bind-id="' + id + '"]');
    if (!marks.length) return null;
    var first = marks[0];
    var last = marks[marks.length - 1];
    var range = document.createRange();
    try {
      range.setStart(first, 0);
      range.setEnd(last, last.childNodes.length);
      return range;
    } catch (ex) {
      return null;
    }
  }

  function beginVimAction(mode) {
    if (mode === 'redline' && vimActionReturn) {
      if (vimActionReturn.phase === 'visual') {
        vimActionReturn.phase = 'text';
        if (vimActionReturn.range) vimActionReturn.range.collapse(false);
      } else if (vimActionReturn.phase === 'visual-block') {
        var graph = buildSemanticTargetGraph();
        var target = vimActionReturn.pinpointEl && graph.byElement.get(vimActionReturn.pinpointEl);
        vimActionReturn.phase = semanticVimPhase(target);
        vimActionReturn.visualBlockAnchorEl = null;
        vimActionReturn.range = null;
      }
    }
    vimPhase = 'action';
    updateVimUi();
  }

  function restoreVimActionState() {
    if (!vimActionReturn) return false;
    var saved = vimActionReturn;
    vimActionReturn = null;
    vimPinpointEl = saved.pinpointEl;
    vimVisualBlockAnchorEl = saved.visualBlockAnchorEl;

    if (saved.phase === 'block' || saved.phase === 'inline') {
      var graph = buildSemanticTargetGraph();
      var target = vimPinpointEl && graph.byElement.get(vimPinpointEl);
      if (target) {
        setVimPinpointTarget(target);
        return true;
      }
    }

    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    hidePinpointLabel();
    vimPhase = saved.phase;
    var selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      if (saved.range) {
        try { selection.addRange(saved.range); } catch (ex) {}
      }
    }
    updateVimUi();
    return true;
  }

  function getVimCursorEl() {
    var cursor = document.querySelector('[data-plannotator-vim-cursor]');
    if (!cursor) {
      cursor = document.createElement('div');
      cursor.setAttribute('data-plannotator-vim-cursor', '');
      cursor.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(cursor);
      document.body.appendChild(cursor);
    }
    return cursor;
  }

  function getVimBadgeEl() {
    var badge = document.querySelector('[data-plannotator-vim-badge]');
    if (!badge) {
      badge = document.createElement('div');
      badge.setAttribute('data-plannotator-vim-badge', '');
      badge.setAttribute('data-plannotator-vim-ui', '');
      overlayNodes.add(badge);
      document.body.appendChild(badge);
    }
    return badge;
  }

  function getVimReticleEl() {
    var reticle = document.querySelector('[data-plannotator-vim-reticle]');
    if (reticle) return reticle;
    reticle = document.createElement('div');
    reticle.setAttribute('data-plannotator-vim-reticle', '');
    reticle.setAttribute('data-plannotator-vim-ui', '');
    reticle.innerHTML = [
      '<div data-vim-reticle-fill></div>',
      '<div data-vim-reticle-corner="top-left"></div>',
      '<div data-vim-reticle-corner="top-right"></div>',
      '<div data-vim-reticle-corner="bottom-left"></div>',
      '<div data-vim-reticle-corner="bottom-right"></div>',
      '<div data-vim-reticle-label></div>'
    ].join('');
    overlayNodes.add(reticle);
    document.body.appendChild(reticle);
    return reticle;
  }

  function hideVimReticle() {
    var reticle = document.querySelector('[data-plannotator-vim-reticle]');
    if (reticle) reticle.style.display = 'none';
  }

  function vimRangeRect(range) {
    if (!range) return null;
    var rects = [];
    if (typeof range.getClientRects === 'function') {
      try {
        var rangeRects = range.getClientRects();
        for (var rangeRectIndex = 0; rangeRectIndex < rangeRects.length; rangeRectIndex++) {
          rects.push(rangeRects[rangeRectIndex]);
        }
      } catch (ex) {}
    }
    var visible = rects.filter(function(rect) {
      return rect.width > 0 || rect.height > 0;
    });
    if (!visible.length) {
      if (typeof range.getBoundingClientRect !== 'function') return null;
      try {
        return range.getBoundingClientRect();
      } catch (ex) {
        return null;
      }
    }
    var left = Math.min.apply(null, visible.map(function(rect) { return rect.left; }));
    var top = Math.min.apply(null, visible.map(function(rect) { return rect.top; }));
    var right = Math.max.apply(null, visible.map(function(rect) { return rect.right; }));
    var bottom = Math.max.apply(null, visible.map(function(rect) { return rect.bottom; }));
    return { left: left, top: top, width: right - left, height: bottom - top };
  }

  function vimReticleSemanticDescriptor(target) {
    if (!target) return 'TARGET';
    if (target.kind === 'code') return 'CODE';
    if (target.kind === 'math') return 'FORMULA';
    if (target.kind === 'table') return 'TABLE';
    if (target.kind === 'row') return 'ROW';
    if (target.kind === 'cell') return 'CELL';
    return String(target.label || target.kind).split(':')[0].toUpperCase();
  }

  function vimReticleCursorDescriptor() {
    if (vimLastActionId === 'moveDown') return 'NEXT LINE';
    if (vimLastActionId === 'moveUp') return 'PREVIOUS LINE';
    if (vimLastActionId === 'previousTextBlock') return 'PREVIOUS BLOCK';
    if (vimLastActionId === 'nextTextBlock') return 'NEXT BLOCK';
    if (vimLastActionId === 'swapSelectionEnds') return 'SWAPPED ENDS';
    if (vimLastActionId === 'lineStart') return 'LINE START';
    if (vimLastActionId === 'lineEnd') return 'LINE END';
    if (vimLastActionId === 'wordForward') return 'NEXT WORD';
    if (vimLastActionId === 'wordBackward') return 'PREVIOUS WORD';
    if (vimLastActionId === 'wordEnd') return 'WORD END';
    if (vimLastActionId === 'previousTextBlock') return 'PREVIOUS TEXT';
    if (vimLastActionId === 'nextTextBlock') return 'NEXT TEXT';
    if (vimLastActionId === 'documentStart') return 'DOCUMENT START';
    if (vimLastActionId === 'documentEnd') return 'DOCUMENT END';
    if (vimLastActionId === 'moveOut') {
      return vimLastActionContext === 'text' || vimLastActionContext === 'visual'
        ? 'PREVIOUS CHARACTER'
        : 'TEXT';
    }
    if (vimLastActionId === 'refine') {
      return vimLastActionContext === 'text' || vimLastActionContext === 'visual'
        ? 'NEXT CHARACTER'
        : 'INLINE TEXT';
    }
    return 'TEXT';
  }

  function vimReticleVisualDescriptor(blockSelection) {
    if (blockSelection) return 'BLOCK RANGE';
    if (vimLastActionId === 'visual') return 'RANGE START';
    if (vimLastActionId === 'wordForward') return 'NEXT WORD';
    if (vimLastActionId === 'wordBackward') return 'PREVIOUS WORD';
    if (vimLastActionId === 'wordEnd') return 'EXACT TOKEN';
    if (vimLastActionId === 'lineStart') return 'TO LINE START';
    if (vimLastActionId === 'lineEnd') return 'TO LINE END';
    if (vimLastActionId === 'moveDown') return 'NEXT LINE';
    if (vimLastActionId === 'moveUp') return 'PREVIOUS LINE';
    return 'RANGE';
  }

  function vimReticleTarget() {
    var phase = vimPhase;
    var pinpointEl = vimPinpointEl;
    var savedRange = null;
    if (phase === 'action' && vimActionReturn) {
      phase = vimActionReturn.phase;
      pinpointEl = vimActionReturn.pinpointEl;
      savedRange = vimActionReturn.range;
    }

    if (phase === 'block' || phase === 'inline') {
      if (!pinpointEl) return null;
      var graph = buildSemanticTargetGraph();
      var target = graph.byElement.get(pinpointEl) || null;
      return {
        phase: phase,
        compact: false,
        rect: pinpointEl.getBoundingClientRect(),
        label: (phase === 'inline' ? 'INLINE' : 'BLOCK')
          + ' · ' + vimReticleSemanticDescriptor(target)
      };
    }

    var selection = window.getSelection();
    var range = savedRange;
    if (!range && selection && selection.rangeCount) {
      range = selection.getRangeAt(0);
    }
    if (!range) return null;

    if (phase === 'text') {
      var caretRange = range.cloneRange();
      caretRange.collapse(false);
      var caretRect = vimRangeRect(caretRange);
      if (!caretRect) return null;
      if (!caretRect.height) caretRect.height = 16;
      if (!caretRect.width) caretRect.width = 1;
      return {
        phase: phase,
        compact: true,
        rect: caretRect,
        label: 'CURSOR · ' + vimReticleCursorDescriptor()
      };
    }

    if (phase === 'visual' || phase === 'visual-block') {
      return {
        phase: phase,
        compact: false,
        rect: vimRangeRect(range),
        label: 'VISUAL · ' + vimReticleVisualDescriptor(phase === 'visual-block')
      };
    }
    return null;
  }

  function updateVimReticle() {
    if (!vimHudEnabled || vimPhase === 'inactive') {
      hideVimReticle();
      return;
    }
    var target = vimReticleTarget();
    if (!target || !target.rect) {
      hideVimReticle();
      return;
    }

    var rect = target.rect;
    var paddingX = target.compact ? 10 : 5;
    var paddingY = target.compact ? 6 : 4;
    var width = Math.max(44, rect.width + paddingX * 2);
    var height = Math.max(32, rect.height + paddingY * 2);
    var left = Math.max(0, rect.left + rect.width / 2 - width / 2);
    var top = Math.max(0, rect.top + rect.height / 2 - height / 2);
    var cornerSize = 28;
    var cornerRight = Math.max(0, width - cornerSize);
    var cornerBottom = Math.max(0, height - cornerSize);
    var labelTop = top - 36 >= 4 ? top - 36 : top + height + 6;
    var reticle = getVimReticleEl();
    var fill = reticle.querySelector('[data-vim-reticle-fill]');
    var label = reticle.querySelector('[data-vim-reticle-label]');
    var topLeft = reticle.querySelector('[data-vim-reticle-corner="top-left"]');
    var topRight = reticle.querySelector('[data-vim-reticle-corner="top-right"]');
    var bottomLeft = reticle.querySelector('[data-vim-reticle-corner="bottom-left"]');
    var bottomRight = reticle.querySelector('[data-vim-reticle-corner="bottom-right"]');

    reticle.style.display = 'block';
    reticle.setAttribute('data-vim-target-phase', target.phase);
    reticle.setAttribute('data-vim-target-label', target.label);
    fill.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0) scale('
      + (width / 100) + ',' + (height / 100) + ')';
    topLeft.style.transform = 'translate3d(' + left + 'px,' + top + 'px,0)';
    topRight.style.transform = 'translate3d(' + (left + cornerRight) + 'px,' + top + 'px,0)';
    bottomLeft.style.transform = 'translate3d(' + left + 'px,' + (top + cornerBottom) + 'px,0)';
    bottomRight.style.transform = 'translate3d(' + (left + cornerRight) + 'px,'
      + (top + cornerBottom) + 'px,0)';
    label.textContent = target.label;
    label.style.transform = 'translate3d(' + left + 'px,' + labelTop + 'px,0)';
  }

  function updateVimUi() {
    if (!vimEnabled) return;
    if (vimHudEnabled && vimLastPostedPhase !== vimPhase) {
      vimLastPostedPhase = vimPhase;
      parent.postMessage({
        type: PREFIX + 'vim-state',
        phase: vimPhase
      }, '*');
    }
    var badge = document.querySelector('[data-plannotator-vim-badge]');
    if (!vimHudEnabled && !badge) badge = getVimBadgeEl();
    var cursor = getVimCursorEl();
    if (vimPhase === 'inactive') {
      if (badge) badge.style.display = 'none';
      cursor.style.display = 'none';
      hideVimReticle();
      return;
    }
    if (vimHudEnabled) {
      if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
      hidePinpointLabel();
      updateVimReticle();
    } else {
      hideVimReticle();
      if (vimPinpointEl && (vimPhase === 'block' || vimPhase === 'inline')) {
        vimPinpointEl.classList.add('plannotator-pinpoint-hover');
      }
    }
    if (badge) badge.style.display = vimHudEnabled ? 'none' : 'block';
    var phaseLabel = vimPhase === 'text' ? 'NORMAL' : vimPhase.toUpperCase().replace('-', ' ');
    if (badge) {
      badge.textContent = phaseLabel + ' · ' + (currentInputMethod === 'pinpoint' ? 'PINPOINT' : 'SELECT');
    }
    if (vimPhase !== 'text') {
      cursor.style.display = 'none';
      return;
    }
    var selection = window.getSelection();
    if (!selection || !selection.focusNode) {
      cursor.style.display = 'none';
      return;
    }
    var range = document.createRange();
    try {
      range.setStart(selection.focusNode, selection.focusOffset);
      range.collapse(true);
      var rect = range.getClientRects()[0] || range.getBoundingClientRect();
      cursor.style.display = 'block';
      cursor.style.left = rect.left + 'px';
      cursor.style.top = rect.top + 'px';
      cursor.style.height = (rect.height || 16) + 'px';
    } catch (ex) {
      cursor.style.display = 'none';
    }
  }

  var vimUiRaf = 0;
  function scheduleVimUiUpdate() {
    if (!vimEnabled || vimPhase === 'inactive' || vimUiRaf) return;
    vimUiRaf = requestAnimationFrame(function() {
      vimUiRaf = 0;
      updateVimUi();
    });
  }
  window.addEventListener('resize', scheduleVimUiUpdate, { passive: true });
  window.addEventListener('scroll', scheduleVimUiUpdate, { passive: true, capture: true });

  function toggleVimHelp() {
    vimHelpOpen = !vimHelpOpen;
    parent.postMessage({
      type: PREFIX + 'vim-help',
      open: vimHelpOpen
    }, '*');
  }

  function clearVimUi() {
    var nodes = document.querySelectorAll('[data-plannotator-vim-cursor],[data-plannotator-vim-badge],[data-plannotator-vim-reticle]');
    for (var i = 0; i < nodes.length; i++) nodes[i].remove();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimVisualBlockAnchorEl = null;
    vimActionReturn = null;
    hidePinpointLabel();
    vimHelpOpen = false;
    if (vimAddedBodyTabIndex && document.body) {
      document.body.removeAttribute('tabindex');
      vimAddedBodyTabIndex = false;
    }
    if (document.body) document.body.removeAttribute('data-plannotator-vim-focus-owner');
  }

  function copyVimText(text) {
    if (!text) return;
    parent.postMessage({
      type: PREFIX + 'vim-copy',
      text: text
    }, '*');
  }

  function vimActionMode(key) {
    // The iframe is an intentionally dependency-free sandbox. Keep these
    // command keys aligned with plan-review/vimSelection.shortcuts.ts, whose
    // scope owns the user-facing registry and parent-document dispatch.
    if (key === 'c') return 'comment';
    if (key === 'd') return 'redline';
    if (key === 't') return 'quickLabel';
    if (key === 'm' || key === ' ' || key === 'Space' || key === 'Spacebar') return 'selection';
    return null;
  }

  function vimActionIdForKey(key) {
    if (key === 'j') return 'moveDown';
    if (key === 'k') return 'moveUp';
    if (key === 'G') return 'documentEnd';
    if (key === 'h' || key === 'H') return 'moveOut';
    if (key === 'l') return 'refine';
    if (key === 'v') return 'visual';
    if (key === 'V') return 'visualBlock';
    if (key === 'w') return 'wordForward';
    if (key === 'b') return 'wordBackward';
    if (key === 'e') return 'wordEnd';
    if (key === '0') return 'lineStart';
    if (key === '$') return 'lineEnd';
    if (key === '{') return 'previousTextBlock';
    if (key === '}') return 'nextTextBlock';
    if (key === 'o') return 'swapSelectionEnds';
    if (key === 'Enter') return 'activeAnnotation';
    if (key === ' ' || key === 'Space' || key === 'Spacebar') return 'annotationMenu';
    if (key === 'c') return 'comment';
    if (key === 'd') return 'redline';
    if (key === 'm') return 'markup';
    if (key === 't') return 'label';
    if (key === 'y') return 'copy';
    if (key === 'Escape') return 'cancel';
    if (key === '?') return 'help';
    return null;
  }

  function handleVimKeydown(e) {
    if (!vimEnabled || isVimEditableTarget(e.target) || e.isComposing) return false;
    if (e.metaKey || e.ctrlKey || e.altKey) return false;

    var key = e.key;
    var handled = false;
    var hudKey = key;
    var vimCommandContext = vimPhase;
    var vimActionId = key === 'g' ? null : vimActionIdForKey(key);

    if (vimHelpOpen) {
      if (key === '?' || key === 'Escape') {
        toggleVimHelp();
        handled = true;
      }
    } else if (key === '?') {
      toggleVimHelp();
      handled = true;
    } else if (key === 'Escape') {
      if (pendingSelection) {
        parent.postMessage({ type: PREFIX + 'selection-clear' }, '*');
        pendingSelection = null;
        pendingRange = null;
        restoreVimSemanticTarget();
        handled = true;
      } else if (vimPhase === 'visual') {
        var visualSelection = window.getSelection();
        if (visualSelection && visualSelection.focusNode) {
          setCollapsedSelection(visualSelection.focusNode, visualSelection.focusOffset);
        }
        vimPhase = 'text';
        updateVimUi();
        handled = true;
      } else if (vimPhase === 'text' || vimPhase === 'visual-block' || vimPhase === 'action') {
        restoreVimSemanticTarget();
        handled = true;
      } else if (vimPhase === 'inline') {
        var escapeGraph = buildSemanticTargetGraph();
        var escapeTarget = currentVimSemanticTarget(escapeGraph);
        var escapeParent = escapeTarget && semanticParent(escapeGraph, escapeTarget);
        if (escapeParent) setVimPinpointTarget(escapeParent);
        else {
          if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
          vimPinpointEl = null;
          vimPhase = 'inactive';
          hidePinpointLabel();
          updateVimUi();
        }
        handled = true;
      } else if (vimPhase === 'block') {
        if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
        vimPinpointEl = null;
        vimPhase = 'inactive';
        hidePinpointLabel();
        window.getSelection().removeAllRanges();
        updateVimUi();
        handled = true;
      }
    } else if (pendingSelection) {
      // The parent toolbar/comment/label UI owns keys until it resolves.
      return false;
    } else if (key === 'g') {
      if (vimPendingG) {
        clearTimeout(vimPendingGTimer);
        vimPendingG = false;
        vimActionId = 'documentStart';
        hudKey = 'gg';
        if (vimPhase === 'text' || vimPhase === 'visual') moveVimDocumentBoundary(false);
        else {
          var firstGraph = buildSemanticTargetGraph();
          if (firstGraph.blocks.length) setVimPinpointTarget(firstGraph.blocks[0]);
        }
      } else {
        vimPendingG = true;
        vimPendingGTimer = setTimeout(function() { vimPendingG = false; }, 500);
      }
      handled = true;
    } else {
      if (vimPendingG) {
        clearTimeout(vimPendingGTimer);
        vimPendingG = false;
      }

      if (vimPhase === 'inactive') {
        setVimPinpointTarget(initialVimPinpointTarget());
      } else if (vimPhase === 'block' || vimPhase === 'inline') {
        var currentGraph = buildSemanticTargetGraph();
        if (!currentVimSemanticTarget(currentGraph)) {
          setVimPinpointTarget(initialVimPinpointTarget());
        }
      }

      if (vimPhase === 'block' || vimPhase === 'inline') {
        if (key === 'j') handled = moveVimPinpoint(1, false);
        else if (key === 'k') handled = moveVimPinpoint(-1, false);
        else if (key === '{') handled = moveVimPinpoint(-1, true);
        else if (key === '}') handled = moveVimPinpoint(1, true);
        else if (key === 'h' || key === 'H') handled = refineVimPinpoint(false);
        else if (key === 'l') handled = refineVimPinpoint(true);
        else if (key === 'G') {
          var lastGraph = buildSemanticTargetGraph();
          if (lastGraph.blocks.length) {
            setVimPinpointTarget(lastGraph.blocks[lastGraph.blocks.length - 1]);
            handled = true;
          }
        } else if (key === 'v') {
          var visualGraph = buildSemanticTargetGraph();
          var visualTarget = currentVimSemanticTarget(visualGraph);
          if (visualTarget && enterVimTextTarget(visualTarget)) {
            vimPhase = 'visual';
            updateVimUi();
            handled = true;
          }
        } else if (key === 'V') {
          var blockGraph = buildSemanticTargetGraph();
          var blockTarget = currentVimSemanticTarget(blockGraph);
          if (blockTarget) {
            var owningBlock = semanticOwningBlock(blockGraph, blockTarget);
            if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
            hidePinpointLabel();
            vimPinpointEl = owningBlock.element;
            vimPhase = 'visual-block';
            handled = selectVimBlock(owningBlock.element, true);
            updateVimUi();
          }
        } else if (key === 'y') {
          copyVimText(vimPinpointEl && vimPinpointEl.textContent || '');
          handled = !!vimPinpointEl;
        } else if (key === 'Enter' || vimActionMode(key)) {
          var semanticActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var semanticActionStarted = vimPinpointEl
            ? annotateElement(vimPinpointEl, key === 'Enter' ? undefined : semanticActionMode)
            : false;
          if (semanticActionStarted) {
            beginVimAction(semanticActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = semanticActionStarted;
        }
      } else if (vimPhase === 'text' || vimPhase === 'visual') {
        ensureVimTextCursor();
        var selection = window.getSelection();
        if (key === 'v') {
          vimPhase = vimPhase === 'visual' ? 'text' : 'visual';
          if (vimPhase === 'text' && selection && selection.focusNode) {
            setCollapsedSelection(selection.focusNode, selection.focusOffset);
          }
          updateVimUi();
          handled = true;
        } else if (key === 'V') {
          var currentBlock = currentVimBlock();
          if (currentBlock) {
            if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
            vimPinpointEl = currentBlock;
            vimPhase = 'visual-block';
            selectVimBlock(currentBlock, true);
            handled = true;
          }
          updateVimUi();
        } else if (key === 'o' && selection && !selection.isCollapsed) {
          selection.setBaseAndExtent(selection.focusNode, selection.focusOffset, selection.anchorNode, selection.anchorOffset);
          updateVimUi();
          handled = true;
        } else if (key === 'G') {
          handled = moveVimDocumentBoundary(true);
        } else if (key === 'h') handled = modifyVimSelection('backward', 'character');
        else if (key === 'l') handled = modifyVimSelection('forward', 'character');
        else if (key === 'j') handled = modifyVimSelection('forward', 'line');
        else if (key === 'k') handled = modifyVimSelection('backward', 'line');
        else if (key === 'w') handled = moveVimWord('forward');
        else if (key === 'b') handled = moveVimWord('backward');
        else if (key === 'e') handled = moveVimWord('end');
        else if (key === '0') handled = modifyVimSelection('backward', 'lineboundary');
        else if (key === '$') handled = modifyVimSelection('forward', 'lineboundary');
        else if (key === '{') handled = modifyVimSelection('backward', 'paragraph');
        else if (key === '}') handled = modifyVimSelection('forward', 'paragraph');
        else if (key === 'y' && selection && !selection.isCollapsed) {
          copyVimText(selection.toString());
          setCollapsedSelection(selection.focusNode, selection.focusOffset);
          vimPhase = 'text';
          updateVimUi();
          handled = true;
        } else if ((key === 'Enter' || vimActionMode(key)) && selection && !selection.isCollapsed) {
          var textActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var textActionStarted = handleSelection(key === 'Enter' ? undefined : textActionMode);
          if (textActionStarted) {
            beginVimAction(textActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = textActionStarted;
        }
      } else if (vimPhase === 'visual-block') {
        var blockSelection = window.getSelection();
        if (key === 'j' || key === 'k') {
          handled = moveVimVisualBlock(key === 'j' ? 1 : -1);
        } else if (key === 'V') {
          restoreVimSemanticTarget();
          handled = true;
        } else if (key === 'o' && blockSelection && !blockSelection.isCollapsed) {
          blockSelection.setBaseAndExtent(
            blockSelection.focusNode,
            blockSelection.focusOffset,
            blockSelection.anchorNode,
            blockSelection.anchorOffset
          );
          var previousBlockAnchor = vimVisualBlockAnchorEl;
          vimVisualBlockAnchorEl = vimPinpointEl;
          if (previousBlockAnchor) vimPinpointEl = previousBlockAnchor;
          handled = true;
        } else if (key === 'y' && blockSelection && !blockSelection.isCollapsed) {
          copyVimText(blockSelection.toString());
          restoreVimSemanticTarget();
          handled = true;
        } else if ((key === 'Enter' || vimActionMode(key)) && blockSelection && !blockSelection.isCollapsed) {
          var blockActionMode = key === 'Enter' ? vimActiveMode : vimActionMode(key);
          rememberVimActionState();
          var blockActionStarted = handleSelection(key === 'Enter' ? undefined : blockActionMode);
          if (blockActionStarted) {
            beginVimAction(blockActionMode);
          } else {
            vimActionReturn = null;
          }
          handled = blockActionStarted;
        }
      }
    }

    if (handled) {
      if (vimHudEnabled && vimActionId) {
        vimLastActionId = vimActionId;
        vimLastActionContext = vimCommandContext;
        updateVimReticle();
        parent.postMessage({
          type: PREFIX + 'vim-command',
          actionId: vimActionId,
          key: hudKey,
          context: vimCommandContext
        }, '*');
      }
      e.preventDefault();
      e.stopImmediatePropagation();
    }
    return handled;
  }

  document.addEventListener('keydown', handleVimKeydown, true);

  // Pointer input exits the keyboard-owned semantic state without synthesizing
  // focus or consuming the pointer event. Drag selection and Pinpoint clicking
  // then continue through their existing handlers.
  document.addEventListener('mousedown', function(e) {
    if (!vimEnabled || isVimEditableTarget(e.target)) return;
    clearPinpointHover();
    if (vimPinpointEl) vimPinpointEl.classList.remove('plannotator-pinpoint-hover');
    vimPinpointEl = null;
    vimVisualBlockAnchorEl = null;
    vimPhase = 'inactive';
    hidePinpointLabel();
    updateVimUi();
  }, true);

  // --- Type-to-comment ---
  // While a selection is pending, focus is inside this iframe, so the parent's
  // toolbar keydown listener never sees the keystroke. Forward a single printable
  // char to the parent so it can open a comment pre-filled with it.
  document.addEventListener('keydown', function(e) {
    if (!pendingSelection) return;
    if (isVimEditableTarget(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (!e.key || e.key.length !== 1) return; // single printable char only
    e.preventDefault();
    parent.postMessage({ type: PREFIX + 'keytype', key: e.key }, '*');
    // Hand keyboard focus back to the parent window so the comment textarea can
    // take it. Blurring the <iframe> from the parent isn't enough — the inner
    // document keeps focus — so the iframe must relinquish it. parent.focus() is
    // allowed cross-origin (like postMessage); also drop the active element.
    try { if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } catch (ex) {}
    try { parent.focus(); } catch (ex) {}
  });

  // --- Helpers ---

  function getNodePath(node) {
    var path = [];
    while (node && node !== document.body) {
      if (node.parentNode) {
        var siblings = node.parentNode.childNodes;
        var idx = 0;
        for (var i = 0; i < siblings.length; i++) {
          if (siblings[i] === node) { idx = i; break; }
        }
        path.unshift(idx);
      }
      node = node.parentNode;
    }
    return path;
  }

  function applyMark(id, annType, selData) {
    try {
      var startNode = resolveNodePath(selData.startContainerPath);
      var endNode = resolveNodePath(selData.endContainerPath);
      if (!startNode || !endNode) return;

      var range = document.createRange();
      range.setStart(startNode, selData.startOffset);
      range.setEnd(endNode, selData.endOffset);
      wrapRangeInMarks(range, id, annType);
    } catch (ex) { /* range may be stale */ }
  }

  function wrapRangeInMarks(range, id, annType) {
    var walker = document.createTreeWalker(
      range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentNode,
      NodeFilter.SHOW_TEXT,
      null
    );

    var textNodes = [];
    while (walker.nextNode()) {
      if (range.intersectsNode(walker.currentNode)) {
        textNodes.push(walker.currentNode);
      }
    }

    for (var i = 0; i < textNodes.length; i++) {
      var tn = textNodes[i];
      var start = (tn === range.startContainer) ? range.startOffset : 0;
      var end = (tn === range.endContainer) ? range.endOffset : tn.length;
      if (start >= end) continue;

      var markRange = document.createRange();
      markRange.setStart(tn, start);
      markRange.setEnd(tn, end);

      var mark = document.createElement('mark');
      mark.className = 'annotation-highlight ' + annType;
      mark.setAttribute('data-bind-id', id);
      markRange.surroundContents(mark);
    }

    var rect = document.querySelector('[data-bind-id="' + id + '"]');
    if (rect) {
      var r = rect.getBoundingClientRect();
      parent.postMessage({
        type: PREFIX + 'mark-created',
        id: id,
        rect: { top: r.top, left: r.left, width: r.width, height: r.height }
      }, '*');
    }
  }

  function findTextAndMark(id, originalText, annType, root) {
    var walker = document.createTreeWalker(root || document.body, NodeFilter.SHOW_TEXT, null);
    var buffer = '';
    var nodes = [];
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, start: buffer.length });
      buffer += walker.currentNode.textContent;
    }
    var idx = buffer.indexOf(originalText);
    if (idx === -1) return false;

    var endIdx = idx + originalText.length;
    var slices = [];
    for (var i = 0; i < nodes.length; i++) {
      var entry = nodes[i];
      var nodeEnd = entry.start + entry.node.length;
      if (nodeEnd <= idx) continue;
      if (entry.start >= endIdx) break;

      var start = Math.max(0, idx - entry.start);
      var end = Math.min(entry.node.length, endIdx - entry.start);
      if (start >= end) continue;
      slices.push({ node: entry.node, start: start, end: end });
    }
    for (var j = slices.length - 1; j >= 0; j--) {
      try {
        var s = slices[j];
        var markRange = document.createRange();
        markRange.setStart(s.node, s.start);
        markRange.setEnd(s.node, s.end);

        var mark = document.createElement('mark');
        mark.className = 'annotation-highlight ' + annType;
        mark.setAttribute('data-bind-id', id);
        markRange.surroundContents(mark);
      } catch (ex) { /* node may have been mutated by a prior wrap */ }
    }
    return slices.length > 0;
  }

  function removeMark(id) {
    var marks = document.querySelectorAll('[data-bind-id="' + id + '"]');
    for (var i = marks.length - 1; i >= 0; i--) unwrapMark(marks[i]);
  }

  function unwrapMark(mark) {
    var parent = mark.parentNode;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }

  function resolveNodePath(path) {
    var node = document.body;
    for (var i = 0; i < path.length; i++) {
      if (!node.childNodes[path[i]]) return null;
      node = node.childNodes[path[i]];
    }
    return node;
  }

  function onReady() {
    if (typeof ResizeObserver !== 'undefined' && document.body) {
      new ResizeObserver(function() {
        postResize();
        scheduleVimUiUpdate();
        schedulePinpointReconcile();
      }).observe(document.body);
    }
    parent.postMessage({ type: PREFIX + 'ready' }, '*');
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }
})();`;
