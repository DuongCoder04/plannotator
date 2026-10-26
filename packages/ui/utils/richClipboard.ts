import { copyTextToClipboard } from './clipboard';
import { restoreClipboardLists } from './richClipboardLists';

/** Cap on markup carried across the HTML-viewer bridge (and on its range text). */
export const MAX_RICH_CLIPBOARD_HTML_LENGTH = 256 * 1024;
/** Cap on the sanitized HTML put on the clipboard; past it the copy is plain text. */
export const MAX_RICH_CLIPBOARD_OUTPUT_LENGTH = 512 * 1024;

/**
 * What the toolbar's Copy as rich text button copies, built when it is
 * pressed: sanitized HTML plus its plain text, the selection marked too large
 * for rich text (plain text is copied and the button says why), or null when
 * no markup is available (plain text, "rich clipboard unavailable").
 */
export type RichCopySource =
  | { html: string; text: string }
  | { tooLarge: true; text: string }
  | null;

const ALLOWED_TAGS = new Set([
  'a', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'hr', 'i', 'li', 'ol', 'p', 'pre', 's', 'span', 'strong',
  'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul',
]);

const DROP_WITH_CONTENT = new Set([
  'AUDIO', 'BUTTON', 'CANVAS', 'EMBED', 'FORM', 'IFRAME', 'INPUT', 'OBJECT',
  'OPTION', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEMPLATE', 'TEXTAREA', 'VIDEO',
]);

const DROP_SELECTORS = [
  '.annotation-exclude',
  '.annotation-toolbar',
  '[data-comment-popover="true"]',
  '[data-floating-picker="true"]',
  '[data-print-hide]',
  'button',
].join(',');

function safeIntegerAttribute(element: Element, name: string, minimum: number): string | null {
  const value = element.getAttribute(name);
  if (!value || !/^-?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= minimum ? String(number) : null;
}

/** A hostname that names this machine, whatever its spelling (URL-parsed). */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'localhost'
    || host.endsWith('.localhost')
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
    || host === '0.0.0.0'
    || host === '[::1]'
    || host === '[::]'
    // IPv4-mapped loopback, as the URL parser serializes it ([::ffff:7f00:1]).
    || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * Whether a URL path leads to the tokenized `/api/html-assets/` route after
 * the server's own normalization: percent-decoding (repeated, so `%252F`
 * counts), backslashes as slashes, dot segments, repeated slashes and case.
 */
export function isHtmlAssetRoutePath(pathname: string): boolean {
  let path = pathname;
  for (let round = 0; round < 4; round++) {
    let decoded = path;
    try { decoded = decodeURIComponent(path); } catch { /* keep the raw path */ }
    decoded = decoded.replace(/\\/g, '/');
    if (!decoded.startsWith('/')) decoded = `/${decoded}`;
    let normalized: string;
    try {
      normalized = new URL(`http://host${decoded}`).pathname;
    } catch {
      normalized = decoded;
    }
    if (normalized === path) break;
    path = normalized;
  }
  path = path.replace(/\/{2,}/g, '/').toLowerCase();
  return /^\/api\/html-assets(\/|$)/.test(path);
}

function safeLinkHref(href: string): string | null {
  try {
    const baseUrl = new URL(document.baseURI);
    const url = new URL(href, baseUrl);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    // Local HTML asset links carry a per-document access token in their path.
    // Do not export that session URL to another app's clipboard: dropped on
    // this page's origin and on every loopback spelling, any port.
    if (
      (url.protocol === 'http:' || url.protocol === 'https:')
      && (url.origin === baseUrl.origin || isLoopbackHostname(url.hostname))
      && isHtmlAssetRoutePath(url.pathname)
    ) return null;
    url.username = '';
    url.password = '';
    return url.href;
  } catch {
    return null;
  }
}

function appendSanitizedNode(source: Node, target: Node): void {
  if (source.nodeType === Node.TEXT_NODE) {
    target.appendChild(document.createTextNode(source.textContent ?? ''));
    return;
  }
  if (!(source instanceof Element)) return;
  if (DROP_WITH_CONTENT.has(source.tagName.toUpperCase()) || source.matches(DROP_SELECTORS)) return;

  const tag = source.tagName.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) {
    source.childNodes.forEach((child) => appendSanitizedNode(child, target));
    return;
  }

  const clean = document.createElement(tag);
  const element = source;
  if (tag === 'a') {
    const href = element.getAttribute('href');
    const safeHref = href ? safeLinkHref(href) : null;
    if (safeHref) clean.setAttribute('href', safeHref);
  }
  if (tag === 'a' || tag === 'th' || tag === 'td') {
    const title = element.getAttribute('title');
    if (title) clean.setAttribute('title', title);
  }
  if (tag === 'ol') {
    const start = safeIntegerAttribute(element, 'start', -2147483648);
    if (start) clean.setAttribute('start', start);
  }
  if (tag === 'li') {
    const value = safeIntegerAttribute(element, 'value', -2147483648);
    if (value) clean.setAttribute('value', value);
  }
  if (tag === 'td' || tag === 'th') {
    for (const name of ['colspan', 'rowspan']) {
      const span = safeIntegerAttribute(element, name, 1);
      if (span && Number(span) <= 1000) clean.setAttribute(name, span);
    }
    const scope = element.getAttribute('scope');
    if (scope && ['row', 'col', 'rowgroup', 'colgroup'].includes(scope)) {
      clean.setAttribute('scope', scope);
    }
  }
  if (tag === 'ol' || tag === 'ul' || tag === 'li') {
    const dir = element.getAttribute('dir');
    if (dir && ['ltr', 'rtl', 'auto'].includes(dir)) clean.setAttribute('dir', dir);
  }
  source.childNodes.forEach((child) => appendSanitizedNode(child, clean));
  target.appendChild(clean);
}

function sanitizeFragment(fragment: ParentNode): string {
  const clean = document.createElement('div');
  fragment.childNodes.forEach((node) => appendSanitizedNode(node, clean));
  return clean.innerHTML;
}

/**
 * Snapshot selected DOM as safe, theme-free rich clipboard HTML. Null when the
 * selection is too large for rich text (its text or the sanitized HTML past
 * MAX_RICH_CLIPBOARD_OUTPUT_LENGTH).
 */
export function selectionRangeToHtml(range: Range): string | null {
  if (range.toString().length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) return null;
  const fragment = range.cloneContents();
  // cloneContents omits the common ancestor, including formatting when both
  // endpoints are inside the same heading, link, or bold text node.
  let ancestor = range.commonAncestorContainer instanceof Element
    ? range.commonAncestorContainer
    : range.commonAncestorContainer.parentElement;
  while (ancestor && ancestor !== document.body) {
    if (ancestor.matches('a,b,blockquote,code,del,em,h1,h2,h3,h4,h5,h6,i,li,ol,p,pre,s,strong,sub,sup,table,tbody,td,tfoot,th,thead,tr,u,ul,[data-rich-list-level]')) {
      const wrapper = ancestor.cloneNode(false);
      while (fragment.firstChild) wrapper.appendChild(fragment.firstChild);
      fragment.appendChild(wrapper);
    }
    ancestor = ancestor.parentElement;
  }
  restoreClipboardLists(fragment);
  const html = sanitizeFragment(fragment);
  return html.length <= MAX_RICH_CLIPBOARD_OUTPUT_LENGTH ? html : null;
}

/** The button's source for a live range, built at press time. Never throws. */
export function richCopySourceFromRange(range: Range, text: string): RichCopySource {
  try {
    const html = selectionRangeToHtml(range);
    if (html === null) return { tooLarge: true, text };
    return html ? { html, text } : null;
  } catch {
    return null;
  }
}

/** Sanitize HTML received across the HTML-viewer bridge before clipboard use. */
export function sanitizeRichHtml(html: string): string | null {
  if (!html || html.length > MAX_RICH_CLIPBOARD_HTML_LENGTH) return null;
  try {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    return sanitizeFragment(parsed.body);
  } catch {
    return null;
  }
}

function copyRichTextWithFallback(html: string, text: string): boolean {
  const activeElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const selection = window.getSelection();
  const savedRanges = selection
    ? Array.from({ length: selection.rangeCount }, (_, index) =>
        selection.getRangeAt(index).cloneRange())
    : [];
  let copied = false;

  // Only this button's own execCommand('copy') passes through here: the
  // listener exists for that one synchronous call, at window capture, and
  // stops the event so no page copy handler (Viewer's plain-text one) runs.
  const handleCopy = (event: ClipboardEvent) => {
    event.stopImmediatePropagation();
    const clipboardData = event.clipboardData;
    if (!clipboardData) return;
    try {
      clipboardData.setData('text/html', html);
      clipboardData.setData('text/plain', text);
      event.preventDefault();
      copied = true;
    } catch {
      copied = false;
    }
  };

  window.addEventListener('copy', handleCopy, true);
  try {
    copied = document.execCommand('copy') && copied;
  } catch {
    copied = false;
  } finally {
    window.removeEventListener('copy', handleCopy, true);
  }

  if (activeElement?.isConnected) {
    activeElement.focus({ preventScroll: true });
  }
  if (selection && savedRanges.length > 0) {
    selection.removeAllRanges();
    savedRanges.forEach((range) => selection.addRange(range));
  }
  return copied;
}

/** 'too-large': plain text was copied because the HTML is past the output cap. */
export type RichClipboardResult = 'rich' | 'plain' | 'too-large' | false;

/** Prefer both MIME types; report an honest plain fallback when the host is text-only. */
export async function copyRichTextToClipboard(html: string, text: string): Promise<RichClipboardResult> {
  if (html.length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) {
    return await copyTextToClipboard(text) ? 'too-large' : false;
  }
  if (!html) {
    return await copyTextToClipboard(text) ? 'plain' : false;
  }
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return 'rich';
    }
  } catch {
    // Fall back only if the legacy copy event can set both MIME types.
  }
  try {
    if (copyRichTextWithFallback(html, text)) return 'rich';
  } catch {
    // Try the host's text-only clipboard below.
  }
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return 'plain';
    }
  } catch {
    // Clipboard access is unavailable.
  }
  return false;
}

async function copyResolvedSource(source: RichCopySource, fallbackText: string): Promise<RichClipboardResult> {
  if (!source) {
    return await copyTextToClipboard(fallbackText) ? 'plain' : false;
  }
  if ('tooLarge' in source) {
    return await copyTextToClipboard(source.text || fallbackText) ? 'too-large' : false;
  }
  if (!source.html) {
    return await copyTextToClipboard(source.text || fallbackText) ? 'plain' : false;
  }
  return copyRichTextToClipboard(source.html, source.text || fallbackText);
}

/**
 * The toolbar button's copy: builds the rich HTML only now, through `build`
 * (synchronous for the markdown Viewer, a bridge round trip on HTML surfaces).
 * An asynchronous source is handed to the clipboard as a promise inside the
 * click, so browsers that need the write to start in the gesture keep it.
 */
export async function copyRichSelection(
  build: () => RichCopySource | Promise<RichCopySource>,
  fallbackText: string,
): Promise<RichClipboardResult> {
  let source: RichCopySource | Promise<RichCopySource>;
  try {
    source = build();
  } catch {
    source = null;
  }
  if (!(source instanceof Promise)) return copyResolvedSource(source, fallbackText);

  const settled = source.then((value) => value, () => null);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': settled.then((value) => {
          if (!value || 'tooLarge' in value || !value.html
            || value.html.length > MAX_RICH_CLIPBOARD_OUTPUT_LENGTH) {
            throw new Error('no rich HTML for this selection');
          }
          return new Blob([value.html], { type: 'text/html' });
        }),
        'text/plain': settled.then((value) =>
          new Blob([value?.text || fallbackText], { type: 'text/plain' })),
      });
      await navigator.clipboard.write([item]);
      return 'rich';
    } catch {
      // Too large, no markup, or a refused write: the plain paths below.
    }
  }
  return copyResolvedSource(await settled, fallbackText);
}
