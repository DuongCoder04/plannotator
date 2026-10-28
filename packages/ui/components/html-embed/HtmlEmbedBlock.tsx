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
 */

import { Code } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EMBED_SANDBOX,
  EMBED_THEME_TOKENS,
  embedFragment,
  embedThemeMessage,
  readEmbedMessage,
  type EmbedMode,
  type EmbedTheme,
} from '@plannotator/core/html-embed';
import type { Block } from '../../types';
import { CodeBlock } from '../blocks/CodeBlock';
import { HostTitle } from '../HostTitle';
import { PopoutDialog } from '../PopoutDialog';
import { useTheme } from '../ThemeProvider';
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

/** A web link the page handed over: opened only for the person's own click in that frame. */
function openLinkFrom(frame: HTMLIFrameElement | null, url: string): void {
  if (!frame || document.activeElement !== frame) return;
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (activation && !activation.isActive) return;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * One embed frame and its messages. `onLoaded` runs on its first load; a
 * second load means the page went elsewhere (`onLeft`).
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
  onLeft,
}: {
  url: string;
  theme: EmbedTheme;
  mode: EmbedMode;
  title: string;
  height?: number;
  onHeight?: (height: number) => void;
  onEscape: (frame: HTMLIFrameElement | null) => void;
  onLoaded?: () => void;
  onLeft?: () => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const loads = useRef(0);
  // The theme the page starts with rides in the URL (no flash); later ones go by message.
  const [src] = useState(() => url + embedFragment(theme, mode));
  const handlers = useRef({ onHeight, onEscape, onLoaded, onLeft });
  handlers.current = { onHeight, onEscape, onLoaded, onLeft };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's own page: every other window (another embed, a page it framed) is ignored.
      if (!ref.current || event.source !== ref.current.contentWindow) return;
      const message = readEmbedMessage(event.data);
      if (!message) return;
      if (message.kind === 'height') handlers.current.onHeight?.(message.height);
      else if (message.kind === 'link') openLinkFrom(ref.current, message.url);
      else handlers.current.onEscape(ref.current);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    if (loads.current > 0) ref.current?.contentWindow?.postMessage(embedThemeMessage(theme), '*');
  }, [theme]);

  return (
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
}

type Phase = 'far' | 'waiting' | 'loading' | 'ready' | 'failed' | 'left';

export function HtmlEmbedBlock({ block, host }: { block: Block; host: HtmlEmbedHost }) {
  const figureRef = useRef<HTMLElement>(null);
  const near = useNearViewport(figureRef);
  const theme = useEmbedTheme();
  const [showCode, setShowCode] = useState(false);
  const [phase, setPhase] = useState<Phase>('far');
  const [url, setUrl] = useState<string | null>(null);
  const [height, setHeight] = useState<number | undefined>(undefined);
  const [expanded, setExpanded] = useState(false);
  const [full, setFull] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [forced, setForced] = useState(false);
  const releaseLoad = useRef<(() => void) | null>(null);
  // The host is read when a page is asked for: a new host object (a re-render) never reloads the page.
  const hostRef = useRef(host);
  hostRef.current = host;

  // Near the screen: take a live slot (or wait for one), a load permit, then the page's URL.
  useEffect(() => {
    if (!near || showCode) return;
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
  }, [near, showCode, forced, generation, block.content]);

  const loaded = useCallback(() => {
    releaseLoad.current?.();
    releaseLoad.current = null;
    setPhase('ready');
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
  const live = !showCode && url !== null && phase !== 'left';

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
    if (phase === 'left') {
      return (
        <div data-html-embed-left="" className="flex items-center justify-center gap-3 rounded-lg border border-dashed border-border py-6 text-xs text-muted-foreground">
          The page went to another address.
          <button type="button" className="underline hover:text-foreground" onClick={() => { setPhase('far'); setGeneration((g) => g + 1); }}>
            Reload
          </button>
        </div>
      );
    }
    return null;
  }, [showCode, phase, block, height]);

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
                onLeft={() => setPhase('left')}
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
          disabled={url === null || showCode}
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
          <div className="min-h-0 flex-1">
            <EmbedFrame url={url} theme={theme} mode="full" title={title} onEscape={() => setFull(false)} />
          </div>
        </PopoutDialog>
      )}
    </figure>
  );
}
