/**
 * ```html and ```svg fences in the REAL Viewer (approval "inbox-inline-html";
 * DOM-gated, DOM_TESTS=1). What regresses if these fail:
 * - a host that passes nothing (plan review, annotate, code review) starts
 *   framing pages instead of showing code;
 * - the frame loses its sandbox, or gains a token beyond `allow-scripts`;
 * - another window's message (another embed, a page a page framed) resizes
 *   this frame: only the frame's own page may;
 * - a tall page is not clipped with Show more, or Show more does not open it;
 * - Code no longer swaps the page for its source, or a host that cannot
 *   serve the page leaves a blank box instead of the code;
 * - a page that takes the keyboard keeps it (the person's typing would go to
 *   the page), hovering it counts as choosing it, a Tab that landed on a
 *   window element lends a frame the keyboard, a page that keeps taking it
 *   (fast or slowly) is not stopped, or the person's click on it no longer
 *   gives it the keyboard and reaches the page;
 * - a frame the browser refused (blank, never speaking) counts as ready
 *   instead of showing the code;
 * - a link the page hands over opens without the person seeing the address
 *   that opens and clicking Open, is offered without a click, or a link to
 *   the Inbox, this computer or the private network is offered at all.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { HtmlEmbedHost } from './HtmlEmbedBlock';

const hasDom = typeof document !== 'undefined';
const viewerModule = hasDom ? await import('../Viewer') : null;
const parserModule = hasDom ? await import('../../utils/parser') : null;
const gateModule = hasDom ? await import('./loadGate') : null;
const guardModule = hasDom ? await import('./focusGuard') : null;
const readyModule = hasDom ? await import('./HtmlEmbedBlock') : null;

const PAGE = '<div id="chart">bars</div>';
const MARKDOWN = ['Here is the chart:', '', '```html', PAGE, '```', '', 'And a drawing:', '', '```svg', '<svg width="10" height="10"><rect width="10" height="10"/></svg>', '```', ''].join('\n');

let root: Root | null = null;
let host: HTMLElement | null = null;
let restoreObserver: (() => void) | null = null;

beforeEach(() => {
  if (!hasDom) return;
  gateModule!.resetEmbedGateForTests();
  guardModule!.resetEmbedFocusGuardForTests();
  // happy-dom never reports an intersection: without the observer, an embed counts as near at once.
  const saved = (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  restoreObserver = () => {
    (globalThis as Record<string, unknown>).IntersectionObserver = saved;
  };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  restoreObserver?.();
  restoreObserver = null;
  if (hasDom) document.body.innerHTML = '';
});

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });

async function mount(htmlEmbeds?: HtmlEmbedHost): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(MARKDOWN)}
        markdown={MARKDOWN}
        annotations={[]}
        onAddAnnotation={() => {}}
        onSelectAnnotation={() => {}}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        disableCodePathValidation
        answerOnly
        htmlEmbeds={htmlEmbeds}
      />,
    );
  });
  await settle();
  await settle();
  return host;
}

const servedAt = (url: string | null): HtmlEmbedHost & { asked: string[] } => {
  const asked: string[] = [];
  return { asked, author: 'Claude Code', frameUrl: async (html) => (asked.push(html), url) };
};

const frameOf = (el: HTMLElement) => el.querySelector<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]');
const say = (source: unknown, data: unknown) =>
  act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data, source: source as Window }));
  });

describe.skipIf(!hasDom)('fences a host draws', () => {
  test('without htmlEmbeds both fences stay code, and no page is asked for', async () => {
    const el = await mount();
    expect(el.querySelector('iframe')).toBeNull();
    expect(el.querySelector('[data-html-embed]')).toBeNull();
    expect(el.querySelector('[data-svg-fence]')).toBeNull();
    expect(el.textContent).toContain('<div id="chart">bars</div>');
  });

  test('with a host: the page is asked for once and framed sandboxed, allow-scripts only', async () => {
    const embeds = servedAt('/api/inbox/embeds/abc');
    const el = await mount(embeds);
    expect(embeds.asked).toEqual([PAGE]);
    const frame = frameOf(el)!;
    expect(frame).not.toBeNull();
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('src')!.startsWith('/api/inbox/embeds/abc#pn=')).toBe(true);
    // The svg fence is an image: it never runs.
    const image = el.querySelector<HTMLImageElement>('[data-svg-fence] img')!;
    expect(image.getAttribute('src')!.startsWith('data:image/svg+xml')).toBe(true);
  });

  test("only the frame's own page sets its height; a tall page is clipped until Show more", async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await say({}, { pnEmbed: 1, kind: 'height', height: 300 });
    expect(frame.style.height).not.toBe('300px');
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 300 });
    expect(frame.style.height).toBe('300px');
    expect(el.querySelector('[data-html-embed-more]')).toBeNull();

    await say(frame.contentWindow, { pnEmbed: 1, kind: 'height', height: 1200 });
    expect(frame.style.height).toBe('1200px');
    const clip = el.querySelector<HTMLElement>('[data-html-embed-clip]')!;
    expect(clip.style.maxHeight).toBe('480px');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-more]')!.click());
    expect(clip.style.maxHeight).toBe('');
    expect(el.querySelector('[data-html-embed-more]')).toBeNull();
  });

  test('Code swaps the page for its source and back', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const code = el.querySelector<HTMLButtonElement>('[data-html-embed-code]')!;
    await act(async () => code.click());
    expect(frameOf(el)).toBeNull();
    expect(code.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
    await act(async () => code.click());
    await settle();
    expect(frameOf(el)).not.toBeNull();
  });

  test('a host that cannot serve the page shows the code', async () => {
    const el = await mount(servedAt(null));
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('failed');
    expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
  });
});

describe.skipIf(!hasDom)('the keyboard stays with the window', () => {
  const box = () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    return textarea;
  };
  const shieldOf = (el: HTMLElement) => el.querySelector<HTMLElement>('[data-html-embed-shield]');
  /** What the shield passed on to the page. */
  const toPage = (frame: HTMLIFrameElement) => {
    const sent: unknown[] = [];
    (frame.contentWindow as Window).postMessage = ((message: unknown) => sent.push(message)) as Window['postMessage'];
    return sent;
  };

  test('a page that takes focus by itself gets it taken back; one that keeps doing it is stopped', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    reply.focus();
    for (let grab = 1; grab <= 2; grab += 1) {
      await act(async () => frameOf(el)!.focus());
      await settle();
      expect(document.activeElement).toBe(reply);
      expect(frameOf(el)).not.toBeNull();
    }
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).toBe(reply);
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed-grabbed]')!.textContent).toContain('kept taking the keyboard');
    // Load again: a fresh page.
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-grabbed] button')!.click());
    await settle();
    expect(frameOf(el)).not.toBeNull();
  });

  test('a page that grabs slowly is stopped too (6 within 10 minutes)', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    try {
      for (let grab = 1; grab <= 6; grab += 1) {
        await act(async () => frameOf(el)!.focus());
        await settle();
        expect(document.activeElement).toBe(reply);
        clock += 60_000; // one a minute: never 3 within 15 s
        if (grab < 6) expect(frameOf(el)).not.toBeNull();
      }
      expect(el.querySelector('[data-html-embed-grabbed]')).not.toBeNull();
    } finally {
      Date.now = realNow;
    }
  });

  test('hovering the page never gives it the keyboard, typing or not', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    reply.focus();
    await new Promise((resolve) => setTimeout(resolve, 750));
    for (const type of ['pointerover', 'mouseover', 'pointermove', 'mousemove']) frame.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    shieldOf(el)!.dispatchEvent(new MouseEvent('pointermove', { bubbles: true }));
    await act(async () => frame.focus());
    await settle();
    expect(document.activeElement).toBe(reply);
  });

  test("the person's click on the page (the window's shield) gives it the keyboard and reaches the page; a press in the window takes it back", async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    const sent = toPage(frame);
    reply.focus();
    const shield = shieldOf(el)!;
    expect(shield).not.toBeNull();
    await act(async () => {
      shield.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      shield.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 7 }));
    });
    await settle();
    expect(document.activeElement).toBe(frame);
    expect(shieldOf(el)).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({ pnEmbed: 1, kind: 'click' }));
    // A press anywhere in the window (plain text too) ends the choice at once: the shield is back.
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(shieldOf(el)).not.toBeNull();
    // A press on plain text leaves focus on the page (body) in a browser; the page then grabs.
    frame.blur();
    await act(async () => frame.focus());
    await settle();
    expect(document.activeElement).not.toBe(frame);
  });

  test('Tab straight into the frame gives it the keyboard; a Tab that lands on a window element lends nothing', async () => {
    const reply = box();
    const button = document.createElement('button');
    document.body.appendChild(button);
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    reply.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await act(async () => button.focus());
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).toBe(button);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).toBe(frameOf(el));
  });

  test('a Tab a window field kept, or one that took focus out of the window, lends nothing', async () => {
    const button = document.createElement('button');
    document.body.appendChild(button);
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    button.focus();
    const kept = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    kept.preventDefault();
    window.dispatchEvent(kept);
    await settle();
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).toBe(button);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    button.blur();
    window.dispatchEvent(new Event('blur'));
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).not.toBe(frameOf(el));
  });

  test('a frame whose page never speaks (the browser refused it) shows the code, not a blank box', async () => {
    readyModule!.setEmbedReadyTimeoutForTests(400);
    try {
      const el = await mount(servedAt('/api/inbox/embeds/abc'));
      // The frame loading (a blank, refused frame loads too) is not the page running.
      await settle();
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).not.toBe('ready');
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
      expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('failed');
      expect(el.querySelector('[data-html-embed]')!.textContent).toContain('<div id="chart">bars</div>');
    } finally {
      readyModule!.setEmbedReadyTimeoutForTests(10_000);
    }
  });

  test('a page that speaks is ready', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'height', height: 200 });
    expect(el.querySelector('[data-html-embed]')!.getAttribute('data-html-embed-phase')).toBe('ready');
  });
});

describe.skipIf(!hasDom)('a link the page hands over', () => {
  let opened: unknown[][] = [];
  let restoreOpen: (() => void) | null = null;
  beforeEach(() => {
    opened = [];
    const saved = window.open;
    window.open = ((...args: unknown[]) => (opened.push(args), null)) as typeof window.open;
    restoreOpen = () => {
      window.open = saved;
    };
  });
  afterEach(() => restoreOpen?.());

  test("shows its real address and opens only on the person's Open", async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/docs?a=1' });
    expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://example.com/docs?a=1');
    expect(opened).toEqual([]);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-link-open]')!.click());
    expect(opened).toEqual([['https://example.com/docs?a=1', '_blank', 'noopener,noreferrer']]);
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
  });

  test('the address shown is the one that opens', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://evil.com\\@example.com' });
    expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://evil.com/@example.com');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-link-open]')!.click());
    expect(opened).toEqual([['https://evil.com/@example.com', '_blank', 'noopener,noreferrer']]);
  });

  test('without the person\'s activation (no click) a link is not offered', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'userActivation');
    let active = false;
    Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: active, hasBeenActive: true }) });
    try {
      const el = await mount(servedAt('/api/inbox/embeds/abc'));
      await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/a' });
      expect(el.querySelector('[data-html-embed-link]')).toBeNull();
      active = true;
      await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/a' });
      expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://example.com/a');
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'userActivation', descriptor);
      else delete (navigator as unknown as Record<string, unknown>).userActivation;
    }
  });

  test('a link to the Inbox, this computer or the private network is never offered, nor one from another window', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    for (const url of [`${window.location.origin}/api/inbox/threads`, 'http://127.0.0.1:54321/api/inbox/threads', 'http://localhost:54321/', 'http://192.168.1.1/']) {
      await say(frame.contentWindow, { pnEmbed: 1, kind: 'link', url });
    }
    await say({}, { pnEmbed: 1, kind: 'link', url: 'https://example.com/' });
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
    expect(opened).toEqual([]);
  });
});
