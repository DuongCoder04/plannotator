import { copyTextToClipboard } from './clipboard';
import { isDocumentKeyboardControl } from './domSelection';
import { restoreClipboardLists } from './richClipboardLists';

export const MAX_RICH_CLIPBOARD_HTML_LENGTH = 256 * 1024;

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

function safeLinkHref(href: string): string | null {
  try {
    const baseUrl = new URL(document.baseURI);
    const url = new URL(href, baseUrl);
    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) return null;
    // Local HTML asset links carry a per-document access token in their path.
    // Do not export that session URL to another app's clipboard.
    if (
      url.origin === baseUrl.origin
      && decodeURIComponent(url.pathname).toLowerCase().startsWith('/api/html-assets/')
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

/** Snapshot selected DOM as safe, theme-free rich clipboard HTML. */
export function selectionRangeToHtml(range: Range): string {
  if (range.toString().length > MAX_RICH_CLIPBOARD_HTML_LENGTH) return '';
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
  return html.length <= MAX_RICH_CLIPBOARD_HTML_LENGTH ? html : '';
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

  const handleCopy = (event: ClipboardEvent) => {
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

  document.addEventListener('copy', handleCopy);
  try {
    copied = document.execCommand('copy') && copied;
  } catch {
    copied = false;
  } finally {
    document.removeEventListener('copy', handleCopy);
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

/** Keep ordinary keyboard copy plain, including text-only embedded hosts. */
export function copySelectionFromKeyboard(event: KeyboardEvent, text: string): boolean {
  if (
    event.isComposing
    || event.altKey
    || event.shiftKey
    || !(event.metaKey || event.ctrlKey)
    || event.key.toLowerCase() !== 'c'
    || isDocumentKeyboardControl(event.target)
  ) return false;

  // Leave the native copy event eligible: Viewer handles it synchronously
  // from the captured payload if async clipboard access fails or is denied.
  void copyTextToClipboard(text);
  return true;
}

/** Override native selection copy only for document selections, never editable controls. */
export function writeSelectionClipboard(event: ClipboardEvent, text: string): boolean {
  if (isDocumentKeyboardControl(event.target) || !event.clipboardData) return false;
  try {
    event.clipboardData.setData('text/plain', text);
    event.preventDefault();
    return true;
  } catch {
    return false;
  }
}

export type RichClipboardResult = 'rich' | 'plain' | false;

/** Prefer both MIME types; report an honest plain fallback when the host is text-only. */
export async function copyRichTextToClipboard(html: string, text: string): Promise<RichClipboardResult> {
  if (!html || html.length > MAX_RICH_CLIPBOARD_HTML_LENGTH) {
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
