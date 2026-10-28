/**
 * A ```html fence drawn as a live page in the document (approval
 * "inbox-inline-html", 2026-10-28; the policy and the page's protocol are
 * @plannotator/core/html-embed). Only for a host that serves embed documents
 * (`HtmlEmbedHost`, the Viewer's `htmlEmbeds`); without one a fence stays
 * code, as before.
 *
 * The look is the owner's: the page sits in the text with no card, border or
 * background of its own (its document is transparent and takes the host's
 * theme and color-scheme), as tall as its page up to `EMBED_CLIP_PX`, then a
 * fade and "Show more". Under it one quiet line: "HTML · sandboxed", Code
 * (the fence's source in place of the page) and Full screen (the same page in
 * ui's popout, scrolling).
 *
 * The window guards the keyboard (`focusGuard`): an inline page sits under a
 * transparent window-owned shield, a real button ("Use this page"), until the
 * person clicks, taps or presses it (the shield passes the click, pointer
 * moves and sideways scrolling on to the page, and vertical scrolling falls
 * through to the thread). Focus the person did not give is taken back; a page
 * that takes it while the person types, holds the thread after taking it,
 * gets a key while the person is not using it, takes it from another page, or
 * keeps taking it is stopped. In desktop Chrome no key meant for the window
 * reaches a page. Where the page shares the window's thread (Safari/WebKit,
 * Chromium without site isolation) a page that grabs while the person is not
 * typing and then blocks the thread gets the keys typed during that block,
 * however long it is (the window cannot run until it ends); then it is
 * stopped and the notice counts them. Not counted, and not stopped when the
 * block is under 250 ms: keys a page sends into a web frame it framed itself;
 * such a page can repeat that up to 5 times in 10 minutes per opening of the
 * thread before the grab count stops it. A link the
 * page hands over is never opened by the page: the window shows its real
 * address and the person opens it (`embedLinkOffer` refuses the Inbox's own
 * host, this computer and the private network), and only from a page the
 * person is using.
 */

import { Code } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { flushSync } from 'react-dom';
import {
  EMBED_SANDBOX,
  EMBED_THEME_TOKENS,
  embedFragment,
  embedLinkOffer,
  embedThemeMessage,
  readEmbedMessage,
  type EmbedMode,
  type EmbedShieldMessage,
  type EmbedTheme,
} from '@plannotator/core/html-embed';
import type { Block } from '../../types';
import { CodeBlock } from '../blocks/CodeBlock';
import { HostTitle } from '../HostTitle';
import { PopoutDialog } from '../PopoutDialog';
import { useTheme } from '../ThemeProvider';
import { chooseEmbedFrame, guardEmbedFocus, isEmbedFrameChosen, reportEmbedFocus, reportEmbedKeys, subscribeEmbedFocus, type EmbedGrab } from './focusGuard';
import { acquireEmbedLoad, claimEmbedLive, onEmbedLiveFreed, releaseEmbedLive, useNearViewport } from './loadGate';

/** A host that can serve embed documents (the Inbox: POST /api/inbox/embeds). */
export interface HtmlEmbedHost {
  /**
   * Keep `html` and give the URL of its embed document, served under
   * `EMBED_RESPONSE_CSP`. Null (or a rejection) shows the fence as code.
   */
  frameUrl(html: string): Promise<string | null>;
  /** Who wrote the page ("Claude Code"), for the caption's hover text. */
  author?: string;
}

/** How tall a page shows in the text before "Show more" (30rem). */
export const EMBED_CLIP_PX = 480;
/** The frame's height until its page reports one. */
const EMBED_FIRST_HEIGHT = 120;

/** The host's theme, read from the page's tokens once they have applied. */
function useEmbedTheme(): EmbedTheme {
  const { colorTheme, resolvedMode } = useTheme();
  const read = useCallback((): EmbedTheme => {
    const style = getComputedStyle(document.documentElement);
    const vars: Record<string, string> = {};
    for (const name of EMBED_THEME_TOKENS) {
      const value = style.getPropertyValue(name).trim();
      if (value) vars[name] = value;
    }
    return { vars, scheme: resolvedMode === 'light' ? 'light' : 'dark' };
  }, [resolvedMode]);
  const [theme, setTheme] = useState<EmbedTheme>(read);
  useEffect(() => {
    // The provider writes the tokens in its own effect, after this one: read on the next frame.
    const frame = requestAnimationFrame(() => setTheme(read()));
    return () => cancelAnimationFrame(frame);
  }, [colorTheme, read]);
  return theme;
}

/**
 * Grabs (focus taken without the person giving it) that stop a page: a burst
 * (3 within 15 s), or a page that keeps trying slowly (6 within 10 minutes).
 */
const GRAB_LIMITS = [
  { count: 3, withinMs: 15_000 },
  { count: 6, withinMs: 600_000 },
] as const;

/** How long a page has to speak (its bootstrap reports a height) before the block shows its code. */
let readyTimeoutMs = 10_000;
/** Tests only. */
export function setEmbedReadyTimeoutForTests(ms: number): void {
  readyTimeoutMs = ms;
}

/** How recent a click on the shield must be for a link the page then hands over. */
const SHIELD_CLICK_MS = 1000;

/**
 * A link the page handed over, as the window will offer it (`embedLinkOffer`:
 * the address that would open, in full), or null: an address it never
 * offers, nobody clicked (the window's user activation), or the person is not
 * using this page (it is not chosen and its shield was not just clicked: a
 * click elsewhere in the window activates the window too).
 */
function offeredLink(url: string, usingPage: boolean): string | null {
  if (!usingPage) return null;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (activation && !activation.isActive) return null;
  return embedLinkOffer(url, window.location.hostname);
}

/** Post what the shield passes on to the frame's page. */
function toPage(frame: HTMLIFrameElement | null, message: EmbedShieldMessage): void {
  frame?.contentWindow?.postMessage(message, '*');
}

/**
 * One embed frame and its messages. `onLoaded` runs on its first load; a
 * second load means the page went elsewhere (`onLeft`). `onReady` runs on the
 * page's first message (its bootstrap ran: a frame the browser refused never
 * sends one). Inline, the frame sits under the window's shield until the
 * person clicks it.
 */
function EmbedFrame({
  url,
  theme,
  mode,
  title,
  height,
  onHeight,
  onEscape,
  onLoaded,
  onReady,
  onLeft,
  onGrab,
  onLink,
}: {
  url: string;
  theme: EmbedTheme;
  mode: EmbedMode;
  title: string;
  height?: number;
  onHeight?: (height: number) => void;
  onEscape: (frame: HTMLIFrameElement | null) => void;
  onLoaded?: () => void;
  onReady?: () => void;
  onLeft?: () => void;
  onGrab: (why: EmbedGrab, heldMs?: number) => void;
  onLink: (url: string) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  // The theme the page starts with rides in the URL (no flash); later ones go by message.
  const [src] = useState(() => url + embedFragment(theme, mode));
  const handlers = useRef({ onHeight, onEscape, onLoaded, onReady, onLeft, onGrab, onLink });
  handlers.current = { onHeight, onEscape, onLoaded, onReady, onLeft, onGrab, onLink };
  const spoke = useRef(false);
  const chosen = useSyncExternalStore(
    subscribeEmbedFocus,
    () => isEmbedFrameChosen(ref.current),
    () => false,
  );
  const moveFrame = useRef(0);
  const shieldRef = useRef<HTMLButtonElement>(null);
  const shieldClickAt = useRef<number | null>(null);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    // Full screen: its dialog is not modal, but it closes as soon as focus leaves it (Base UI), so
    // no window field takes typing while its page holds the keyboard: focus there is the page's.
    return guardEmbedFocus(frame, (why, heldMs) => handlers.current.onGrab(why, heldMs), mode === 'full', () => shieldRef.current);
  }, [mode]);

  /** A point on the shield, in the frame's own pixels. */
  const at = (event: { clientX: number; clientY: number }) => {
    const box = ref.current!.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own page: every other window (another embed, a page it framed) is ignored.
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const message = readEmbedMessage(event.data);
      if (!message) return;
      if (!spoke.current) {
        spoke.current = true;
        handlers.current.onReady?.();
      }
      if (message.kind === 'height') handlers.current.onHeight?.(message.height);
      else if (message.kind === 'link') {
        const clickedAt = shieldClickAt.current;
        const usingPage = isEmbedFrameChosen(ref.current) || (clickedAt !== null && performance.now() - clickedAt < SHIELD_CLICK_MS);
        const url = offeredLink(message.url, usingPage);
        if (url) handlers.current.onLink(url);
      }
      else if (message.kind === 'focus') {
        if (reportEmbedFocus(ref.current)) handlers.current.onGrab('unseen');
      } else if (message.kind === 'keys') {
        if (reportEmbedKeys(ref.current)) handlers.current.onGrab('keys');
      } else handlers.current.onEscape(ref.current);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loads.current > 0) ref.current?.contentWindow?.postMessage(embedThemeMessage(theme), '*');
  }, [theme]);

  const iframe = (
    <iframe
      ref={ref}
      src={src}
      sandbox={EMBED_SANDBOX}
      referrerPolicy="no-referrer"
      title={title}
      data-html-embed-frame={mode}
      onLoad={() => {
        loads.current += 1;
        if (loads.current === 1) handlers.current.onLoaded?.();
        else handlers.current.onLeft?.();
      }}
      style={{
        display: 'block',
        width: '100%',
        height: mode === 'full' ? '100%' : `${height ?? EMBED_FIRST_HEIGHT}px`,
        border: 0,
        background: 'transparent',
        // Must match the page's own color-scheme, or the browser paints an opaque backdrop behind it.
        colorScheme: theme.scheme,
      }}
    />
  );
  if (mode === 'full') return iframe;
  return (
    <div className="relative">
      {!chosen && (
        // The window's shield, a real button: the person's click, tap or press lands here, so the
        // window knows the page was chosen (the page sees its own pointer, so hovering can never
        // count). It passes the click, pointer moves and sideways scrolling on; vertical scrolling
        // falls through to the thread (an inline page never scrolls up and down itself). Before the
        // frame in the tab order, so a keyboard or screen reader reaches it first.
        <button
          ref={shieldRef}
          type="button"
          // Explicit: Safari's Tab skips buttons without it (its default "Tab to highlight" setting).
          tabIndex={0}
          aria-label="Use this page"
          data-html-embed-shield=""
          className="absolute inset-0 z-10 m-0 block h-full w-full cursor-default appearance-none rounded-md border-0 bg-transparent p-0 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onPointerMove={(event) => {
            if (event.pointerType !== 'mouse') return;
            const point = at(event);
            cancelAnimationFrame(moveFrame.current);
            moveFrame.current = requestAnimationFrame(() => toPage(ref.current, { pnEmbed: 1, kind: 'pointer', ...point }));
          }}
          onPointerLeave={() => {
            cancelAnimationFrame(moveFrame.current);
            toPage(ref.current, { pnEmbed: 1, kind: 'pointerleave' });
          }}
          onClick={(event) => {
            const frame = ref.current;
            if (!frame) return;
            shieldClickAt.current = performance.now();
            chooseEmbedFrame(frame);
            // Enter or Space (or a screen reader's press) has no point: the page just gets the keyboard.
            if (event.detail === 0) return;
            toPage(frame, { pnEmbed: 1, kind: 'click', ...at(event) });
          }}
          onWheel={(event) => {
            if (event.deltaX !== 0) toPage(ref.current, { pnEmbed: 1, kind: 'scroll', dx: event.deltaX });
          }}
        />
      )}
      {iframe}
    </div>
  );
}

/**
 * A link the page handed over, offered by the window: its real address in
 * full, opened only by the person's own click on Open (in a new tab, no
 * opener, no referrer).
 */
function LinkOffer({ url, onDone }: { url: string; onDone: () => void }) {
  return (
    <div data-html-embed-link="" role="group" aria-label="A link from the page" className="mt-1 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">
      <span className="shrink-0">Link</span>
      <span data-html-embed-link-url="" className="min-w-0 flex-1 break-all font-mono text-foreground">
        {url}
      </span>
      <button
        type="button"
        data-html-embed-link-open=""
        className="shrink-0 rounded px-1.5 py-0.5 font-medium text-foreground hover:bg-background"
        onClick={() => {
          window.open(url, '_blank', 'noopener,noreferrer');
          onDone();
        }}
      >
        Open
      </button>
      <button type="button" className="shrink-0 rounded px-1.5 py-0.5 hover:bg-background hover:text-foreground" onClick={onDone}>
        Cancel
      </button>
    </div>
  );
}

type Phase = 'far' | 'waiting' | 'loading' | 'ready' | 'failed' | 'left' | 'grabbed';
/** Why a page was stopped for the keyboard. */
type Stopped =
  | { why: 'kept'; keys: number }
  | { why: 'typing'; keys: number }
  | { why: 'late'; heldMs: number; keys: number }
  | { why: 'keys'; keys: number }
  | { why: 'unseen'; keys: number };

/** How long after a late restore or a stray key the block waits for the page's key reports before it stops it. */
const STOP_SETTLE_MS = 300;

/**
 * The notice for a page stopped for the keyboard. The count is the keys the
 * page's bootstrap reported while the person was not using it.
 */
function stoppedNotice(stopped: Stopped): string {
  const got = stopped.keys > 0 ? ` It got ${stopped.keys === 1 ? '1 key' : `${stopped.keys} keys`} you typed.` : '';
  if (stopped.why === 'typing') return 'This page took the keyboard while you were typing, so it was stopped.';
  if (stopped.why === 'unseen') return `This page took the keyboard from another page, so it was stopped.${got}`;
  if (stopped.why === 'keys') return `This page took the keyboard, so it was stopped.${got}`;
  if (stopped.why === 'late') {
    const seconds = Math.max(0.1, Math.round(stopped.heldMs / 100) / 10).toFixed(1);
    return stopped.keys > 0
      ? `This page took the keyboard and kept the window busy for ${seconds} s, so it was stopped.${got}`
      : `This page took the keyboard and kept the window busy for ${seconds} s, so it was stopped.`;
  }
  return `This page kept taking the keyboard, so it was stopped.${got}`;
}

export function HtmlEmbedBlock({ block, host }: { block: Block; host: HtmlEmbedHost }) {
  const figureRef = useRef<HTMLElement>(null);
  const near = useNearViewport(figureRef);
  const theme = useEmbedTheme();
  const [showCode, setShowCode] = useState(false);
  const [phase, setPhase] = useState<Phase>('far');
  const [stopped, setStopped] = useState<Stopped>({ why: 'kept', keys: 0 });
  // Stopped for the keyboard: stays stopped (Code and back, a re-render) until Load again.
  const [halted, setHalted] = useState(false);
  /** Keys the page reported while the person was not using it, and a stop waiting for more reports. */
  const strayKeys = useRef(0);
  const pendingStop = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [forced, setForced] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const grabs = useRef<number[]>([]);
  const releaseLoad = useRef<(() => void) | null>(null);
  // The host is read when a page is asked for: a new host object (a re-render) never reloads the page.
  const hostRef = useRef(host);
  hostRef.current = host;

  // Near the screen: take a live slot (or wait for one), a load permit, then the page's URL.
  useEffect(() => {
    if (!near || showCode || halted) return;
    let cancelled = false;
    let holdsLive = false;
    let stopWaiting: (() => void) | null = null;
    const start = () => {
      if (cancelled) return;
      if (!claimEmbedLive(forced)) {
        setPhase('waiting');
        stopWaiting = onEmbedLiveFreed(() => {
          stopWaiting?.();
          stopWaiting = null;
          start();
        });
        return;
      }
      holdsLive = true;
      setPhase('loading');
      void acquireEmbedLoad().then(async (release) => {
        if (cancelled) return release();
        releaseLoad.current = release;
        let next: string | null = null;
        try {
          next = await hostRef.current.frameUrl(block.content);
        } catch {
          next = null;
        }
        if (cancelled) return release();
        if (next === null) {
          release();
          setPhase('failed');
          return;
        }
        setUrl(next);
      });
    };
    start();
    return () => {
      cancelled = true;
      stopWaiting?.();
      releaseLoad.current?.();
      releaseLoad.current = null;
      if (holdsLive) releaseEmbedLive();
      setUrl(null);
    };
  }, [near, showCode, forced, generation, block.content, halted]);

  // Loaded: the load permit goes back. Ready only once the page speaks (a frame the browser
  // refused loads too, blank, and never speaks).
  const loaded = useCallback(() => {
    releaseLoad.current?.();
    releaseLoad.current = null;
  }, []);
  const ready = useCallback(() => {
    releaseLoad.current?.();
    releaseLoad.current = null;
    setPhase((now) => (now === 'loading' ? 'ready' : now));
  }, []);

  // A page that never speaks (the frame was refused, or the Inbox lost it): its code instead.
  useEffect(() => {
    if (phase !== 'loading' || url === null) return;
    const timer = setTimeout(() => setPhase((now) => (now === 'loading' ? 'failed' : now)), readyTimeoutMs);
    return () => clearTimeout(timer);
  }, [phase, url]);

  // Focus is already back in the window; a page that keeps taking it is stopped.
  const stop = useCallback((why: Stopped) => {
    if (pendingStop.current) clearTimeout(pendingStop.current);
    pendingStop.current = null;
    setFull(false);
    setLink(null);
    setStopped(why);
    setHalted(true);
    setPhase('grabbed');
  }, []);
  /** Stop after the page's key reports for this grab have come in (focus is already back). */
  const stopSoon = useCallback(
    (make: (keys: number) => Stopped) => {
      if (pendingStop.current) clearTimeout(pendingStop.current);
      pendingStop.current = setTimeout(() => stop(make(strayKeys.current)), STOP_SETTLE_MS);
    },
    [stop],
  );
  useEffect(() => () => {
    if (pendingStop.current) clearTimeout(pendingStop.current);
  }, []);
  const grabbed = useCallback(
    (why: EmbedGrab, heldMs?: number) => {
      // While the person types: gone in this task, before the page can block the thread and take
      // the keys that follow (the guard needs the frame out of the document when this returns).
      if (why === 'typing') return flushSync(() => stop({ why: 'typing', keys: strayKeys.current }));
      // Straight from the page the person chose: gone now (the keyboard is back on their page).
      if (why === 'unseen') return stop({ why: 'unseen', keys: strayKeys.current });
      // A key reached it while the person was not using it; or it held the thread while it had the
      // keyboard. Either way it goes, once its key reports are in.
      if (why === 'keys') {
        strayKeys.current += 1;
        if (!pendingStop.current) stopSoon((keys) => ({ why: 'keys', keys }));
        return;
      }
      if (why === 'late') return stopSoon((keys) => ({ why: 'late', heldMs: heldMs ?? 0, keys }));
      const t = Date.now();
      const longest = GRAB_LIMITS[GRAB_LIMITS.length - 1]!.withinMs;
      grabs.current = [...grabs.current.filter((at) => t - at < longest), t];
      if (GRAB_LIMITS.some(({ count, withinMs }) => grabs.current.filter((at) => t - at < withinMs).length >= count)) {
        stop({ why: 'kept', keys: strayKeys.current });
      }
    },
    [stop, stopSoon],
  );

  const reload = useCallback(() => {
    grabs.current = [];
    strayKeys.current = 0;
    setHalted(false);
    setPhase('far');
    setGeneration((g) => g + 1);
  }, []);

  const escapeInline = useCallback((frame: HTMLIFrameElement | null) => {
    // Escape in the page hands the keyboard back to the document (the host's own Escape comes next).
    if (frame && document.activeElement === frame) frame.blur();
  }, []);

  const clipped = !expanded && height !== undefined && height > EMBED_CLIP_PX;
  const title = host.author ? `HTML from ${host.author}` : 'HTML page';
  const caption = host.author
    ? `From ${host.author}. It runs in a sandbox: it can load from the web, but cannot reach your Inbox.`
    : 'It runs in a sandbox: it can load from the web, but cannot reach this page.';
  const live = !showCode && url !== null && phase !== 'left' && phase !== 'grabbed';

  const body = useMemo(() => {
    if (showCode || phase === 'failed') return <CodeBlock block={block} isHovered={false} />;
    if (phase === 'waiting') {
      return (
        <button
          type="button"
          data-html-embed-waiting=""
          className="flex w-full items-center justify-center rounded-lg border border-dashed border-border py-6 text-xs text-muted-foreground hover:text-foreground"
          style={{ minHeight: height ? Math.min(height, EMBED_CLIP_PX) : EMBED_FIRST_HEIGHT }}
          onClick={() => setForced(true)}
        >
          Show page
        </button>
      );
    }
    if (phase === 'left' || phase === 'grabbed') {
      return (
        <div
          data-html-embed-left={phase === 'left' ? '' : undefined}
          data-html-embed-grabbed={phase === 'grabbed' ? '' : undefined}
          data-html-embed-stopped={phase === 'grabbed' ? stopped.why : undefined}
          role="status"
          className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground"
        >
          {phase === 'left' ? 'The page went to another address.' : stoppedNotice(stopped)}
          <button type="button" className="underline hover:text-foreground" onClick={reload}>
            {phase === 'left' ? 'Reload' : 'Load again'}
          </button>
        </div>
      );
    }
    return null;
  }, [showCode, phase, block, height, reload, stopped]);

  return (
    <figure ref={figureRef} data-block-id={block.id} data-html-embed="" data-html-embed-phase={showCode ? 'code' : phase} className="my-4">
      {body ?? (
        <div className="relative">
          <div
            data-html-embed-clip=""
            style={{
              maxHeight: clipped ? EMBED_CLIP_PX : undefined,
              overflow: 'hidden',
              // A fade that needs no background color: the message shows through it.
              maskImage: clipped ? 'linear-gradient(to bottom, black calc(100% - 72px), transparent)' : undefined,
              WebkitMaskImage: clipped ? 'linear-gradient(to bottom, black calc(100% - 72px), transparent)' : undefined,
            }}
          >
            {live ? (
              <EmbedFrame
                key={`${url}:${generation}`}
                url={url}
                theme={theme}
                mode="inline"
                title={title}
                height={height}
                onHeight={setHeight}
                onEscape={escapeInline}
                onLoaded={loaded}
                onReady={ready}
                onLeft={() => setPhase('left')}
                onGrab={grabbed}
                onLink={setLink}
              />
            ) : (
              <div aria-hidden="true" style={{ height: height ?? EMBED_FIRST_HEIGHT }} />
            )}
          </div>
          {clipped && (
            <div className="absolute inset-x-0 bottom-1 flex justify-center">
              <button
                type="button"
                data-html-embed-more=""
                className="rounded-full border border-border bg-background px-3.5 py-1 text-xs font-medium text-foreground shadow-sm hover:bg-muted"
                onClick={() => setExpanded(true)}
              >
                Show more
              </button>
            </div>
          )}
        </div>
      )}
      {link !== null && !full && <LinkOffer url={link} onDone={() => setLink(null)} />}
      <figcaption data-html-embed-caption="" className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
        <Code aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <HostTitle title={caption}>
          <span className="truncate">HTML · sandboxed</span>
        </HostTitle>
        <span className="flex-1" />
        {expanded && !showCode && (
          <button type="button" className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground" onClick={() => setExpanded(false)}>
            Show less
          </button>
        )}
        <button
          type="button"
          data-html-embed-code=""
          aria-pressed={showCode}
          className={`rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground ${showCode ? 'bg-muted text-foreground' : ''}`}
          onClick={() => setShowCode((value) => !value)}
        >
          Code
        </button>
        <button
          type="button"
          data-html-embed-full=""
          disabled={url === null || showCode || halted}
          className="rounded px-1.5 py-0.5 hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
          onClick={() => setFull(true)}
        >
          Full screen
        </button>
      </figcaption>
      {full && url !== null && (
        <PopoutDialog
          open
          onClose={() => setFull(false)}
          title={title}
          className="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none"
          dataAttributes={{ 'data-html-embed-popout': '' }}
        >
          <div className="flex h-9 shrink-0 items-center border-b border-border pl-4 pr-12 text-xs font-medium text-foreground">{title}</div>
          {link !== null && (
            <div className="shrink-0 border-b border-border px-3 pb-1.5">
              <LinkOffer url={link} onDone={() => setLink(null)} />
            </div>
          )}
          <div className="min-h-0 flex-1">
            <EmbedFrame url={url} theme={theme} mode="full" title={title} onEscape={() => setFull(false)} onGrab={grabbed} onLink={setLink} />
          </div>
        </PopoutDialog>
      )}
    </figure>
  );
}
