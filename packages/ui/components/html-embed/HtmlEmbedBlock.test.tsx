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
 *   window element (or one older than 500 ms) lends a frame the keyboard, a
 *   page that keeps taking it (fast or slowly) is not stopped, or the
 *   person's click on it no longer gives it the keyboard and reaches the page;
 * - a page that grabs while the person types is not removed in the same task,
 *   or one that holds the thread after a grab is not stopped with a notice;
 * - the shield is not a button a keyboard or screen reader reaches, pressing
 *   it does not give the page the keyboard, focus moving from it into the
 *   page counts as a grab, or the window regaining focus keeps a page chosen;
 * - a frame the browser refused (blank, never speaking) counts as ready
 *   instead of showing the code;
 * - a link the page hands over opens without the person seeing the address
 *   that opens and clicking Open, is offered without a click or from a page
 *   the person is not using, or a link to the Inbox, this computer or the
 *   private network is offered at all.
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

async function mount(htmlEmbeds?: HtmlEmbedHost, markdown = MARKDOWN): Promise<HTMLElement> {
  const Viewer = viewerModule!.Viewer;
  host = document.createElement('div');
  document.body.appendChild(host);
  await act(async () => {
    root = createRoot(host!);
    root.render(
      <Viewer
        blocks={parserModule!.parseMarkdownToBlocks(markdown)}
        markdown={markdown}
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
const shieldOf = (el: HTMLElement) => el.querySelector<HTMLButtonElement>('[data-html-embed-shield]');
/** The person clicks the page: on the window's shield, at a point. */
const clickPage = (el: HTMLElement) =>
  act(async () => {
    const shield = shieldOf(el)!;
    shield.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    shield.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1, clientX: 12, clientY: 7 }));
  });
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

describe.skipIf(!hasDom)('the window guards the keyboard', () => {
  const box = () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    return textarea;
  };
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
    expect(shield.tagName).toBe('BUTTON');
    expect(shield.getAttribute('aria-label')).toBe('Use this page');
    await clickPage(el);
    await settle();
    expect(document.activeElement).toBe(frame);
    expect(shieldOf(el)).toBeNull();
    expect(sent).toContainEqual(expect.objectContaining({ pnEmbed: 1, kind: 'click' }));
    // A press anywhere in the window (plain text too) ends the choice at once: the shield is back.
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    expect(shieldOf(el)).not.toBeNull();
    // A press on plain text leaves focus on the page (body) in a browser, and the window gets it
    // back; the page then grabs.
    frame.blur();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => frame.focus());
    await settle();
    expect(document.activeElement).not.toBe(frame);
  });

  test('the window regaining focus ends the choice, unless the chosen page still has focus (back from another app)', async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    toPage(frame);
    await clickPage(el);
    expect(shieldOf(el)).toBeNull();
    // Back from another app, focus still in the page: still theirs.
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(shieldOf(el)).toBeNull();
    // Focus elsewhere: the choice ends.
    frame.blur();
    await act(async () => window.dispatchEvent(new Event('focus')));
    expect(shieldOf(el)).not.toBeNull();
  });

  test("the shield is a button a keyboard or screen reader reaches: pressing it, or moving on from it into the page, gives the page the keyboard", async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    const sent = toPage(frame);
    // Enter or Space on it (a click with no pointer): chosen, and nothing is clicked in the page.
    shieldOf(el)!.focus();
    await act(async () => shieldOf(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 })));
    await settle();
    expect(document.activeElement).toBe(frame);
    expect(sent.filter((message) => (message as { kind?: string }).kind === 'click')).toEqual([]);

    // Back in the window; then a screen reader moves from the button straight into the page.
    reply.focus();
    await settle();
    expect(shieldOf(el)).not.toBeNull();
    shieldOf(el)!.focus();
    await act(async () => frame.focus());
    await settle();
    expect(document.activeElement).toBe(frame);
    expect(el.querySelector('[data-html-embed-grabbed]')).toBeNull();
  });

  test('a page that takes the keyboard while the person types is stopped at once, in the same task', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    // Still typing a moment later (the person pauses between keys).
    await new Promise((resolve) => setTimeout(resolve, 300));
    // No await: the frame must be out of the document before the page's next line could block the thread.
    frame.focus();
    expect(frame.isConnected).toBe(false);
    await settle();
    expect(document.activeElement).toBe(reply);
    expect(el.querySelector('[data-html-embed-stopped]')!.getAttribute('data-html-embed-stopped')).toBe('typing');
    expect(el.querySelector('[data-html-embed-grabbed]')!.textContent).toContain('while you were typing');
  });

  test('a page that holds the thread after taking the keyboard is stopped, and the person is told', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await act(async () => {
      frame.focus();
      // The page blocks the thread it shares with the window: the restore runs late.
      const end = performance.now() + 400;
      while (performance.now() < end) {}
    });
    await settle();
    expect(document.activeElement).toBe(reply);
    // Stopped once the page's key reports for that grab are in; none came, so the notice is calm.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')!.getAttribute('data-html-embed-stopped')).toBe('late');
    expect(el.querySelector('[data-html-embed-grabbed]')!.textContent).toMatch(/^This page took the keyboard and kept the window busy for 0\.[4-9] s, so it was stopped\.Load again$/);
  });

  /** A clock the guard reads, moved by the test. */
  const withClock = async (run: (advance: (ms: number) => void) => Promise<void>) => {
    const real = performance.now.bind(performance);
    let offset = 0;
    performance.now = () => real() + offset;
    try {
      await run((ms) => {
        offset += ms;
      });
    } finally {
      performance.now = real;
    }
  };

  test('typing means a key in the last 2 s: a grab after a longer pause is taken back, not stopped', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await withClock(async (advance) => {
      reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      advance(2500);
      await act(async () => frameOf(el)!.focus());
      await settle();
    });
    expect(document.activeElement).toBe(reply);
    expect(frameOf(el)).not.toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')).toBeNull();
  });

  test('Tab and a modifier alone are not typing; dictation (input with no key) is', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await withClock(async (advance) => {
      for (const key of ['Tab', 'Shift', 'Meta']) reply.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      advance(600); // past what the Tab lends
      reply.focus();
      await act(async () => frameOf(el)!.focus());
      await settle();
    });
    expect(frameOf(el)).not.toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')).toBeNull();

    reply.focus();
    reply.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, inputType: 'insertText', data: 'dictated' }));
    frameOf(el)!.focus();
    expect(el.querySelector('[data-html-embed-stopped]')!.getAttribute('data-html-embed-stopped')).toBe('typing');
  });

  test('a late restore in a hidden window (its timers slowed) stops nothing', async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState') ?? Object.getOwnPropertyDescriptor(document, 'visibilityState');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await act(async () => {
        frameOf(el)!.focus();
        const end = performance.now() + 400;
        while (performance.now() < end) {}
      });
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (descriptor && !Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState')) Object.defineProperty(document, 'visibilityState', descriptor);
    }
    expect(frameOf(el)).not.toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')).toBeNull();
  });

  test('a key that reaches a page the person is not using stops it, and the notice counts the keys', async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')!.getAttribute('data-html-embed-stopped')).toBe('keys');
    expect(el.querySelector('[data-html-embed-grabbed]')!.textContent).toContain('It got 2 keys you typed.');
  });

  test("keys in the page the person is using are theirs, after a press on the window's scrollbar too (focus stayed)", async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    toPage(frame);
    await clickPage(el);
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    // A press that moves no focus (a scrollbar): the shield returns, but the page still has focus.
    await withClock(async (advance) => {
      await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
      advance(600); // past the trailing grace, before the poll looks again
      await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(frameOf(el)).not.toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')).toBeNull();
  });

  test('a key report that trails the person leaving the page (sent while they still used it) stops nothing', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    toPage(frame);
    await clickPage(el);
    // They type in the page, then click the reply box; the page's report of that last key comes after.
    reply.focus();
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(frameOf(el)).not.toBeNull();
    // Long after they left, a key report means a grab got it.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'keys' });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
    expect(frameOf(el)).toBeNull();
  });

  test('a page that takes focus from the page the person chose is stopped, and the keyboard goes back', async () => {
    box();
    const two = ['```html', '<p>A</p>', '```', '', 'And:', '', '```html', '<p>B</p>', '```', ''].join('\n');
    const el = await mount(servedAt('/api/inbox/embeds/abc'), two);
    const [a, b] = [...el.querySelectorAll<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]')];
    toPage(a!);
    await clickPage(el);
    expect(document.activeElement).toBe(a);
    // The window sees no event for a move between pages; page B's bootstrap reports its focus.
    await say(b!.contentWindow, { pnEmbed: 1, kind: 'focus' });
    await settle();
    expect(b!.isConnected).toBe(false);
    expect(el.querySelectorAll('[data-html-embed-stopped]')[0]!.getAttribute('data-html-embed-stopped')).toBe('unseen');
    expect(el.querySelector('[data-html-embed-grabbed]')!.textContent).toContain('from another page');
    expect(document.activeElement).toBe(a);
  });

  test('when the window does see the move from the chosen page into another, that page is stopped at once too', async () => {
    box();
    const two = ['```html', '<p>A</p>', '```', '', 'And:', '', '```html', '<p>B</p>', '```', ''].join('\n');
    const el = await mount(servedAt('/api/inbox/embeds/abc'), two);
    const [a, b] = [...el.querySelectorAll<HTMLIFrameElement>('iframe[data-html-embed-frame="inline"]')];
    toPage(a!);
    await clickPage(el);
    await act(async () => b!.focus());
    await settle();
    expect(b!.isConnected).toBe(false);
    expect(document.activeElement).toBe(a);
  });

  test("a page's focus report for a grab the window already handled stops nothing", async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await act(async () => frame.focus());
    await settle();
    expect(document.activeElement).toBe(reply);
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'focus' });
    await settle();
    expect(frameOf(el)).not.toBeNull();
  });

  test('leaving the shield button without focusing a window element lends the page nothing afterwards', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    shieldOf(el)!.focus();
    // A press on plain text: no window element takes focus.
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    shieldOf(el)!.blur();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).not.toBe(frameOf(el));
    void reply;
  });

  test('a stopped page stays stopped: Code and back shows the notice again, Full screen is off, its live slot is free', async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    for (let grab = 1; grab <= 3; grab += 1) {
      await act(async () => frameOf(el)?.focus());
      await settle();
    }
    expect(el.querySelector('[data-html-embed-stopped]')).not.toBeNull();
    const code = el.querySelector<HTMLButtonElement>('[data-html-embed-code]')!;
    await act(async () => code.click());
    await act(async () => code.click());
    await settle();
    expect(frameOf(el)).toBeNull();
    expect(el.querySelector('[data-html-embed-stopped]')).not.toBeNull();
    expect(el.querySelector<HTMLButtonElement>('[data-html-embed-full]')!.disabled).toBe(true);
    // Its slot went back: 12 more pages may run.
    for (let i = 0; i < 12; i += 1) expect(gateModule!.claimEmbedLive(false)).toBe(true);
  });

  test('Load again gives a fresh page a fresh count: one grab does not stop it', async () => {
    box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    for (let grab = 1; grab <= 3; grab += 1) {
      await act(async () => frameOf(el)?.focus());
      await settle();
    }
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-grabbed] button')!.click());
    await settle();
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(frameOf(el)).not.toBeNull();
  });

  test('a stop takes the link offer away', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    toPage(frameOf(el)!);
    await clickPage(el);
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/a' });
    expect(el.querySelector('[data-html-embed-link]')).not.toBeNull();
    reply.focus();
    reply.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    frameOf(el)!.focus();
    await settle();
    expect(el.querySelector('[data-html-embed-stopped]')).not.toBeNull();
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
  });

  test('the shield shows a ring when the keyboard is on it', async () => {
    await mount(servedAt('/api/inbox/embeds/abc'));
    const classes = shieldOf(document.body)!.className.split(/\s+/);
    expect(classes).toEqual(expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-ring']));
  });

  test('Tab straight into the frame gives it the keyboard', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    reply.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await act(async () => frameOf(el)!.focus());
    await settle();
    expect(document.activeElement).toBe(frameOf(el));
  });

  test('a Tab lends for 500 ms only', async () => {
    const reply = box();
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    reply.focus();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    await act(async () => frameOf(el)?.focus());
    await settle();
    expect(document.activeElement).toBe(reply);
  });

  for (const [name, afterTab] of [
    ['lands on a window element', (button: HTMLButtonElement) => button.focus()],
    ['takes focus out of the window', () => ((document.activeElement as HTMLElement).blur(), window.dispatchEvent(new Event('blur')))],
    ['a window field kept (cancelled)', () => undefined],
  ] as const) {
    test(`a Tab that ${name} lends nothing: the grab after it is taken back`, async () => {
      const button = document.createElement('button');
      document.body.appendChild(button);
      const el = await mount(servedAt('/api/inbox/embeds/abc'));
      box();
      const tab = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
      if (name.startsWith('a window field')) tab.preventDefault();
      window.dispatchEvent(tab);
      afterTab(button);
      await settle();
      await act(async () => frameOf(el)!.focus());
      await settle();
      expect(document.activeElement).not.toBe(frameOf(el) ?? undefined);
      expect(el.querySelector('iframe[data-html-embed-frame="inline"]:focus')).toBeNull();
    });
  }

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
    await clickPage(el);
    await say(frame.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/docs?a=1' });
    expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://example.com/docs?a=1');
    expect(opened).toEqual([]);
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-link-open]')!.click());
    expect(opened).toEqual([['https://example.com/docs?a=1', '_blank', 'noopener,noreferrer']]);
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
  });

  test('the address shown is the one that opens', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await clickPage(el);
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
      await clickPage(el);
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

  test('a link from a page the person is not using (they clicked elsewhere in the window) is not offered', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/phish' });
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
    await clickPage(el);
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/docs' });
    expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://example.com/docs');
  });

  test('a link right after a click on the shield is offered; more than a second later, from a page no longer in use, it is not', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    await clickPage(el);
    // A press on plain text: focus goes back to the window.
    await act(async () => document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })));
    frameOf(el)!.blur();
    await act(async () => window.dispatchEvent(new Event('focus')));
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/now' });
    expect(el.querySelector('[data-html-embed-link-url]')!.textContent).toBe('https://example.com/now');
    await act(async () => el.querySelector<HTMLButtonElement>('[data-html-embed-link] button:last-child')!.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
    await say(frameOf(el)!.contentWindow, { pnEmbed: 1, kind: 'link', url: 'https://example.com/later' });
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
  });

  test('a link to the Inbox, this computer or the private network is never offered, nor one from another window', async () => {
    const el = await mount(servedAt('/api/inbox/embeds/abc'));
    const frame = frameOf(el)!;
    await clickPage(el);
    for (const url of [`${window.location.origin}/api/inbox/threads`, 'http://127.0.0.1:54321/api/inbox/threads', 'http://localhost:54321/', 'http://192.168.1.1/']) {
      await say(frame.contentWindow, { pnEmbed: 1, kind: 'link', url });
    }
    await say({}, { pnEmbed: 1, kind: 'link', url: 'https://example.com/' });
    expect(el.querySelector('[data-html-embed-link]')).toBeNull();
    expect(opened).toEqual([]);
  });
});
