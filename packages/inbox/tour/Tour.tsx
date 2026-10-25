/**
 * The Inbox's onboarding tour (approval "inbox-onboarding-tour", v2): the
 * window's own list, thread, question card, attachment tiles, viewers,
 * comments, reply box, Artifacts view and compose dialog, fed from the tour's
 * fixture instead of the person's store. The viewers read through the tour's
 * file source (tour/fileSource.ts) and compose through the tour's transport,
 * so picks, comments, drawings, Sends and the new thread change only the
 * tour's state (model.ts); nothing here calls a route that writes. The
 * person's own Inbox stays mounted in App, untouched, and comes back on exit.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { InboxAnnotationRecord, InboxAttachmentState, InboxInlineImage, InboxMessageWire } from '@plannotator/core/inbox-types';
import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import type { Annotation } from '@plannotator/ui/types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { inboxApi, type ComposeSessionsModel, type ProjectFolder } from '../api';
import { Icon, HostMark } from '../icons';
import { InboxList } from '../components/InboxList';
import { MessageBody } from '../components/Thread';
import { Sidebar } from '../components/Sidebar';
import { Tip } from '../components/Tip';
import { AttachmentTiles } from '../components/AttachmentTiles';
import { AttachmentPane, type AttachmentPaneHandle } from '../components/AttachmentPane';
import { ArtifactsView } from '../components/ArtifactsView';
import { ReplyAnswers, draftAnswerWords, type DraftAnswer } from '../components/ReplyAnswers';
import { AnnotationsChip } from '../components/AnnotationsChip';
import { ComposeDialog, type ComposeTransport } from '../compose/ComposeDialog';
import { InboxFileSourceProvider } from '../fileSource';
import { TOUR_IMAGE_BASE } from '../images';
import { annotationOf } from '../attachments';
import { kindDefaultView } from '../fileView';
import { threadArtifacts } from '../artifacts';
import { stepsOf } from '../stepping';
import { formatInboxVideoTime, readInboxVideoTime } from '@plannotator/core/inbox-types';
import { plural } from '../format';
import { forgetTourMarkups, preloadTourAssets, tourAssetNameOf } from './assets';
import { tourFileSource } from './fileSource';
import { sentAnswersOf } from '../sentReply';
import {
  TOUR_FILM_REPLY_ID,
  TOUR_FILM_THREAD,
  TOUR_NEW_THREAD,
  TOUR_PROJECT_ID,
  TOUR_REPLY_ID,
  TOUR_SESSION,
  TOUR_STEPS,
  TOUR_THREAD,
  filmTimings,
  newThreadTimings,
  parseTourFixture,
  pickDiffers,
  replayTimings,
  tourAssetUrl,
  tourAttachments,
  tourCanBack,
  tourFileOf,
  tourFullPicture,
  tourInlineImageId,
  tourMessages,
  tourPickOf,
  tourPickWords,
  tourQuestion,
  tourRecord,
  tourSections,
  tourSubject,
  tourTime,
  tourWaitingCount,
  type TourAction,
  type TourCoach as TourCoachModel,
  type TourDegraded,
  type TourFixture,
  type TourState,
  type TourTarget,
  type TourUi,
} from './model';

// ─────────────────────────── Loading the fixture ───────────────────────────

let fixtureLoad: Promise<TourFixture> | null = null;

/** For tests: the next tour reads the fixture again (a page reads it once). */
export function __forgetTourFixtureForTests(): void {
  fixtureLoad = null;
}

/**
 * The whole tour, loaded once per page before it shows (assets.ts): the
 * fixture (tried three times), then every picture and text file into memory.
 * Resolves null when the fixture cannot be had: the tour then never starts.
 * Never rejects.
 */
export function loadTour(): Promise<TourFixture | null> {
  fixtureLoad ??= (async () => {
    for (const wait of [0, 400, 1200]) {
      if (wait) await new Promise((done) => setTimeout(done, wait));
      try {
        const fixture = parseTourFixture(await inboxApi.tourFixture());
        await preloadTourAssets(fixture);
        return fixture;
      } catch {
        // Tried again, then the tour is not offered on this load.
      }
    }
    throw new Error('no tour');
  })();
  return fixtureLoad.then(
    (fixture) => fixture,
    () => {
      fixtureLoad = null;
      return null;
    },
  );
}

/** The tour's content while it shows: `unavailable` once it cannot be had (the window then leaves the tour, quietly). */
export function useTourFixture(active: boolean): { fixture: TourFixture | null; unavailable: boolean } {
  const [fixture, setFixture] = useState<TourFixture | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!active) setUnavailable(false);
    // The tour ended: its drawings go (blob URLs held only for it).
    if (!active) forgetTourMarkups();
    if (!active || fixture) return;
    let gone = false;
    void loadTour().then((f) => {
      if (gone) return;
      if (f) setFixture(f);
      else setUnavailable(true);
    });
    return () => {
      gone = true;
    };
  }, [active, fixture]);
  return { fixture, unavailable };
}

/**
 * The replays after each Send: thread A (delivered, then two messages),
 * the film (delivered, the reply) and the new thread (delivered, the reply),
 * on timers. A state reached directly (a reload of `#tour=N`) has everything
 * already, so nothing is scheduled.
 */
export function useTourReplay(state: TourState, dispatch: (action: TourAction) => void, reduced: boolean, say: (text: string) => void): void {
  const aDone = state.delivered && state.arrived >= 2;
  useEffect(() => {
    if (!state.sent || aDone) return;
    const t = replayTimings(reduced);
    const timers = [
      setTimeout(() => {
        dispatch({ type: 'delivered' });
        say('Delivered to Claude Code.');
      }, t.delivered),
      setTimeout(() => {
        dispatch({ type: 'arrive' });
        say('New message from Claude Code, replayed from the real thread.');
      }, t.first),
      setTimeout(() => {
        dispatch({ type: 'arrive' });
        say('New message from Claude Code: the pull request, with screenshots in the message.');
      }, t.second),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sent]);
  useEffect(() => {
    if (!state.filmSent || state.filmArrived) return;
    const t = filmTimings(reduced);
    const timers = [
      setTimeout(() => {
        dispatch({ type: 'filmDelivered' });
        say('Delivered to Claude Code.');
      }, t.delivered),
      setTimeout(() => {
        dispatch({ type: 'filmArrive' });
        say('New message from Claude Code about the film, replayed from the real thread.');
      }, t.reply),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.filmSent]);
  const sentNew = state.compose === 'sent';
  useEffect(() => {
    if (!sentNew || state.newArrived) return;
    const t = newThreadTimings(reduced);
    const timers = [
      setTimeout(() => {
        dispatch({ type: 'newDelivered' });
        say('Delivered to Claude Code.');
      }, t.delivered),
      setTimeout(() => {
        dispatch({ type: 'newArrive' });
        say('New message from Claude Code in your new thread.');
      }, t.reply),
    ];
    return () => timers.forEach(clearTimeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sentNew]);
}

// ─────────────────────────── The tour bar ───────────────────────────

export function TourBar({ step, phone, arrivals, onArrivals, onExit }: { step: number; phone: boolean; arrivals: number; onArrivals: () => void; onExit: () => void }) {
  const real = step === TOUR_STEPS;
  return (
    <div className="ib-tour-bar" role="region" aria-label="Tour" data-tour-bar="">
      <span className="ib-tour-tag">
        <Icon name="map" size={13} />
        Tour
      </span>
      <span className="ib-tour-what">
        {real ? (
          <>
            <b>Your own Inbox</b>
            <span className="ib-mut ib-tour-long"> · this step is real: what you connect here stays connected</span>
          </>
        ) : (
          <>
            <b>A replay</b>
            <span className="ib-mut ib-tour-long"> of how we built the Inbox with the Inbox. What you do here stays here.</span>
          </>
        )}
      </span>
      {arrivals > 0 && (
        <Tip content="Leave the tour and open your Inbox">
          <button type="button" className="ib-tour-chip" onClick={onArrivals} data-tour-arrivals={arrivals}>
            <Icon name="inbox" size={14} />
            {arrivals === 1 ? '1 new message in your Inbox' : `${arrivals} new messages in your Inbox`}
          </button>
        </Tip>
      )}
      <span className="ib-tour-steps" role="img" aria-label={`Step ${step} of ${TOUR_STEPS}`}>
        {phone
          ? `${step}/${TOUR_STEPS}`
          : Array.from({ length: TOUR_STEPS }, (_, i) => <span key={i} className="ib-tour-dot" data-on={i + 1 === step ? '' : undefined} data-done={i + 1 < step ? '' : undefined} />)}
      </span>
      <button type="button" className="ib-tour-exit" onClick={onExit} data-tour-exit={real ? 'finish' : 'exit'}>
        {real ? 'Finish the tour' : 'Exit tour'}
      </button>
    </div>
  );
}

// ─────────────────────────── The coach card ───────────────────────────

const row = (id: string) => `[data-thread-id="${id}"]:is(button, a, [role="button"])`;

const TARGET_SELECTORS: Record<TourTarget, string> = {
  row: row(TOUR_THREAD),
  'film-row': row(TOUR_FILM_THREAD),
  'new-row': row(TOUR_NEW_THREAD),
  choices: '[data-tour-message="ask"] [data-question-tiles]',
  phrase: '[data-tour-phrase-host]',
  composer: '[data-comment-popover]',
  'eval-tile': '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="EVALUATION.md"]',
  'eval-line': '[data-attachment-pane] .ib-docscroll',
  file: '[data-attachment-pane]',
  reply: '[data-tour-reply]',
  'reply-box': '[data-tour-thread] .ib-rbox',
  delivered: '[data-tour-delivered]',
  'inline-img': `[data-tour-thread] img[data-inline-image="${tourInlineImageId('built-a1.webp')}"]`,
  markup: '[data-attachment-pane] [data-markup-open]',
  'image-foot': '[data-attachment-pane] [data-image-composer]',
  'art-button': '[data-tour-thread] [data-artifacts-button]',
  'art-grid': '[data-tour-thread] [data-artifacts-view]',
  'film-tile': '[data-tour-thread] .ib-attachments:not(.ib-hatts-tiles) [data-attachment-name="guides-vscode.mp4"]',
  'film-rail': '[data-attachment-pane] [data-video-rail]',
  'film-composer': '[data-attachment-pane] [data-video-composer]',
  'film-send': '[data-tour-film-send]',
  'compose-btn': '[data-open-compose]',
  'compose-to': '[data-compose] [data-compose-to]',
  'compose-send': '[data-compose] .ib-cp-foot [data-compose-send], [data-compose] .ib-cp-bar [data-compose-send]',
  arrival: '[data-tour-arrival-last]',
};

/** The element a coach card points at, when it is on screen (the visible one of several). */
export function tourTargetElement(target: TourTarget | null, root: ParentNode = document): HTMLElement | null {
  if (!target) return null;
  const all = [...root.querySelectorAll<HTMLElement>(TARGET_SELECTORS[target])];
  const el = all.find((e) => e.getClientRects().length > 0) ?? all[0] ?? null;
  if (!el && target === 'choices') return root.querySelector<HTMLElement>('[data-tour-message="ask"] .question-block');
  return el;
}

/** What the card is placed against: the phrase's own words (a CSS highlight, not an element), else the target's box. */
function targetRect(target: TourTarget | null): DOMRect | null {
  if (target === 'phrase' || target === 'eval-line') {
    const range = phraseRanges.get(target === 'phrase' ? 'message' : 'file');
    if (range) {
      const r = range.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r;
    }
  }
  return tourTargetElement(target)?.getBoundingClientRect() ?? null;
}

type Side = 'right' | 'left' | 'below' | 'above' | 'corner';

const SIDES: Partial<Record<TourTarget, Side[]>> = {
  row: ['below', 'above', 'right'],
  'film-row': ['below', 'above', 'right'],
  'new-row': ['below', 'right', 'above'],
  choices: ['left', 'right', 'above', 'below'],
  phrase: ['below', 'above', 'left'],
  composer: ['left', 'right', 'above', 'below'],
  'eval-tile': ['above', 'left', 'right', 'below'],
  'eval-line': ['left', 'below', 'above'],
  reply: ['above', 'left', 'right'],
  'reply-box': ['above', 'left'],
  delivered: ['left', 'above', 'below'],
  'inline-img': ['left', 'above', 'right'],
  markup: ['above', 'left'],
  'image-foot': ['above', 'left'],
  'art-button': ['below', 'left'],
  'art-grid': ['corner'],
  'film-tile': ['above', 'left', 'right', 'below'],
  'film-rail': ['above', 'left'],
  'film-composer': ['above', 'left'],
  'film-send': ['above', 'left', 'right'],
  'compose-btn': ['right', 'below'],
  'compose-to': ['right', 'below', 'left'],
  'compose-send': ['right', 'above', 'left'],
  arrival: ['left', 'above', 'right'],
  file: ['corner'],
};

function overlaps(a: { left: number; top: number; right: number; bottom: number }, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** The nearest ancestor that scrolls vertically. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return null;
}

/** A phone: scroll what the sheet points at into the room the sheet leaves, once per card. */
function fitAroundSheet(target: HTMLElement, sheet: HTMLElement | null, reduced: boolean): void {
  requestAnimationFrame(() => {
    const scroller = scrollerOf(target);
    if (!scroller || !sheet) return;
    const r = target.getBoundingClientRect();
    const c = sheet.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const sheetLow = c.top + c.height / 2 > window.innerHeight / 2;
    const free = sheetLow ? { top: view.top + 8, bottom: Math.min(view.bottom, c.top) - 8 } : { top: Math.max(view.top, c.bottom) + 8, bottom: view.bottom - 8 };
    let delta = 0;
    if (r.height > free.bottom - free.top || r.top < free.top) delta = r.top - free.top;
    else if (r.bottom > free.bottom) delta = r.bottom - free.bottom;
    if (Math.abs(delta) > 1) scroller.scrollBy({ top: delta, behavior: reduced ? 'auto' : 'smooth' });
  });
}

/**
 * The "How it's organised" card's picture (step 1's opener): the tour's own
 * list and thread in miniature, drawn from the fixture: a project in the
 * sidebar, a row per thread (one subject each), a thread that reads like an
 * email, and its files as the familiar tiles.
 */
export function OrientPicture({ fixture }: { fixture: TourFixture }) {
  const a = fixture.threads.find((t) => t.id === TOUR_THREAD)!;
  const film = fixture.threads.find((t) => t.id === TOUR_FILM_THREAD);
  const ask = a.messages.find((m) => m.asks);
  const files = ask?.attachments ?? [];
  return (
    <div className="ib-tour-orient" role="img" aria-label="The Inbox in small: a project in the sidebar, one row per thread, a thread read like an email, its files as tiles." data-tour-orient="">
      <div className="ib-to-side" aria-hidden="true">
        <span className="ib-to-lbl">Projects</span>
        <span className="ib-to-proj">
          <Icon name="folder" size={12} />
          {fixture.project}
        </span>
      </div>
      <div className="ib-to-list" aria-hidden="true">
        {[a, film].filter(Boolean).map((t) => (
          <span key={t!.id} className="ib-to-row" data-on={t!.id === TOUR_THREAD ? '' : undefined}>
            <span className="ib-to-chip">{t!.thread_name}</span>
            <span className="ib-to-subj">{tourSubject(t!)}</span>
          </span>
        ))}
      </div>
      <div className="ib-to-mail" aria-hidden="true">
        <span className="ib-to-from">
          <HostMark host="claude-code" />
          <b>Claude Code</b>
          <span className="ib-mut">to you · {tourTime(ask?.time ?? '12:03')}</span>
        </span>
        <span className="ib-to-line" />
        <span className="ib-to-line ib-short" />
        <span className="ib-to-tiles">
          {files.map((f) => (
            <span key={f.name} className="ib-to-tile">
              <Icon name={readInboxAttachmentKind(f.kind) === 'image' ? 'photo' : readInboxAttachmentKind(f.kind) === 'html' ? 'code' : 'doc'} size={12} />
              {f.name}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

export function TourCoach({
  coach,
  step,
  canBack,
  phone,
  reduced,
  focusTick,
  fixture,
  onBack,
  onNext,
}: {
  coach: TourCoachModel;
  step: number;
  canBack: boolean;
  phone: boolean;
  reduced: boolean;
  /** Raised when the person acted and the card changed: focus goes to its title. */
  focusTick: number;
  fixture: TourFixture | null;
  onBack: () => void;
  onNext: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number; at: 'top' | 'bottom' } | null>(null);
  const sheetAt = useRef<{ key: string; at: 'top' | 'bottom' } | null>(null);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const target = coach.target === 'phrase' || coach.target === 'eval-line' ? null : tourTargetElement(coach.target);
    for (const old of document.querySelectorAll('.ib-tour-target')) if (old !== target) old.classList.remove('ib-tour-target');
    target?.classList.add('ib-tour-target');
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bar = document.querySelector('[data-tour-bar]')?.getBoundingClientRect().bottom ?? 0;
    const m = 12;
    const r = targetRect(coach.target);
    if (phone) {
      if (sheetAt.current?.key !== coach.key) {
        const low = r ? r.top + Math.min(r.height, vh / 2) / 2 > vh * 0.5 : false;
        sheetAt.current = { key: coach.key, at: low ? 'top' : 'bottom' };
      }
      setPlace({ left: 0, top: 0, at: sheetAt.current.at });
      return;
    }
    const sides = coach.target ? (SIDES[coach.target] ?? ['corner']) : ['corner'];
    if (!r || sides[0] === 'corner') {
      setPlace({ left: m, top: Math.max(bar + m, vh - h - 16), at: 'bottom' });
      return;
    }
    for (const side of sides) {
      let x = 0;
      let y = 0;
      if (side === 'below') [x, y] = [r.left, r.bottom + 14];
      if (side === 'above') [x, y] = [r.left, r.top - h - 14];
      if (side === 'right') [x, y] = [r.right + 18, Math.min(Math.max(bar + m, r.top), vh - h - m)];
      if (side === 'left') [x, y] = [r.left - w - 18, Math.min(Math.max(bar + m, r.top), vh - h - m)];
      x = Math.min(Math.max(m, x), vw - w - m);
      const box = { left: x, top: y, right: x + w, bottom: y + h };
      if (y < bar + m || y + h > vh - m || overlaps(box, r)) continue;
      setPlace({ left: x, top: y, at: 'bottom' });
      return;
    }
    const left = r.left + r.width / 2 > vw / 2 ? m : vw - w - m;
    setPlace({ left, top: Math.max(bar + m, vh - h - 16), at: 'bottom' });
  }, [coach.target, coach.key, phone]);

  useLayoutEffect(() => {
    measure();
    const target = tourTargetElement(coach.target);
    if (target && coach.target !== 'file' && coach.target !== 'art-grid') {
      if (phone) fitAroundSheet(coach.target === 'choices' ? (target.closest<HTMLElement>('.question-block') ?? target) : target, ref.current, reduced);
      else target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
    const again = () => measure();
    window.addEventListener('resize', again);
    document.addEventListener('scroll', again, true);
    const tick = setInterval(again, 300);
    return () => {
      window.removeEventListener('resize', again);
      document.removeEventListener('scroll', again, true);
      clearInterval(tick);
    };
  }, [measure, coach.key, coach.target, reduced, phone]);

  useEffect(
    () => () => {
      for (const old of document.querySelectorAll('.ib-tour-target')) old.classList.remove('ib-tour-target');
    },
    [],
  );

  useEffect(() => {
    if (focusTick > 0) titleRef.current?.focus({ preventScroll: true });
  }, [focusTick]);

  const style = phone ? undefined : place ? { left: place.left, top: place.top } : { visibility: 'hidden' as const };
  return (
    <div ref={ref} className={`ib-tour-coach${coach.picture ? ' ib-tc-wide' : ''}`} role="region" aria-label={`Tour, step ${step} of ${TOUR_STEPS}`} data-tour-coach={coach.key} data-at={phone ? (place?.at ?? 'bottom') : undefined} style={style}>
      <div className="ib-tc-eb">
        Step {step} of {TOUR_STEPS}
      </div>
      <h2 ref={titleRef} tabIndex={-1}>
        {coach.title}
      </h2>
      {coach.text && (
        <p>
          {coach.text}
          {coach.action && (
            <>
              {' '}
              <b>{coach.action}</b>
            </>
          )}
        </p>
      )}
      {coach.picture === 'orient' && fixture && <OrientPicture fixture={fixture} />}
      {coach.items && (
        <ul className="ib-tour-also" data-tour-also="">
          {coach.items.map((item) => (
            <li key={item.title}>
              <span aria-hidden="true">{item.mark}</span>
              <b>{item.title}</b>
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      )}
      <div className="ib-tc-acts">
        {canBack && (
          <button type="button" className="ib-tc-back" onClick={onBack} data-tour-back="">
            Back
          </button>
        )}
        <span className="ib-sp" />
        {coach.next ? (
          <button type="button" className="ib-tc-next" onClick={onNext} data-tour-next="">
            {coach.nextLabel ?? 'Next'}
          </button>
        ) : coach.wait ? (
          <span className="ib-tc-wait">Replaying…</span>
        ) : (
          <span className="ib-tc-do">
            <Icon name="chevR" size={14} />
            Your move
          </span>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────── The tour's words to point at ───────────────────────────

/**
 * The phrase a coach card points at (step 3's words in the message, step 4's
 * line in EVALUATION.md): drawn with the CSS Custom Highlight API, so the
 * message's DOM never changes (the comment highlighter's own marks stay its).
 */
const phraseRanges = new Map<'message' | 'file', Range>();
const TOUR_PHRASE_HIGHLIGHT = 'ib-tour-phrase';

function rangeOfText(root: Element, phrase: string): Range | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    text += (n as Text).data;
  }
  const at = text.indexOf(phrase);
  if (at < 0) return null;
  const range = document.createRange();
  let offset = 0;
  let started = false;
  for (const node of nodes) {
    const end = offset + node.data.length;
    if (!started && at < end) {
      range.setStart(node, at - offset);
      started = true;
    }
    if (started && at + phrase.length <= end) {
      range.setEnd(node, at + phrase.length - offset);
      return range;
    }
    offset = end;
  }
  return null;
}

/** Keep the tour's phrase highlights drawn while their step shows: re-found as the page redraws. */
function useTourPhrases(want: { message?: string | null; file?: string | null }) {
  useEffect(() => {
    const highlights = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
    const HighlightCtor = (globalThis as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    const draw = () => {
      phraseRanges.clear();
      const msgRoot = document.querySelector('[data-tour-message="ask"] .ib-body');
      const fileRoot = document.querySelector('[data-attachment-pane] .ib-docscroll');
      const m = want.message && msgRoot ? rangeOfText(msgRoot, want.message) : null;
      const f = want.file && fileRoot ? rangeOfText(fileRoot, want.file) : null;
      if (m) phraseRanges.set('message', m);
      if (f) phraseRanges.set('file', f);
      // A marker the coach can find and screen readers ignore (the words stay as they are).
      for (const el of document.querySelectorAll('[data-tour-phrase-host]')) el.removeAttribute('data-tour-phrase-host');
      if (m) (m.startContainer.parentElement as HTMLElement | null)?.setAttribute('data-tour-phrase-host', '');
      if (highlights && HighlightCtor) {
        const ranges = [m, f].filter((r): r is Range => r !== null);
        if (ranges.length > 0) highlights.set(TOUR_PHRASE_HIGHLIGHT, new HighlightCtor(...ranges));
        else highlights.delete(TOUR_PHRASE_HIGHLIGHT);
      }
    };
    draw();
    const timer = setInterval(draw, 500);
    return () => {
      clearInterval(timer);
      phraseRanges.clear();
      highlights?.delete(TOUR_PHRASE_HIGHLIGHT);
      for (const el of document.querySelectorAll('[data-tour-phrase-host]')) el.removeAttribute('data-tour-phrase-host');
    };
  }, [want.message, want.file]);
}

// ─────────────────────────── The picture viewer (a choice's magnifier) ───────────────────────────

export interface TourViewerPicture {
  asset: string;
  name: string;
  caption: string;
  alt: string;
  pick?: string;
}

/** A choice's picture large, over the window: Close and Escape leave it, focus goes back where it was. */
export function TourViewer({ picture, onPick, onClose }: { picture: TourViewerPicture; onPick: (label: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    if (items.length === 0) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };
  return createPortal(
    <div className="pn-inbox ib-tour-layer">
      <div ref={ref} className="ib-tour-viewer" role="dialog" aria-modal="true" aria-label={picture.name} onKeyDown={onKeyDown} data-tour-viewer="">
        <header>
          <b>{picture.name}</b>
          <span className="ib-mut">{picture.caption}</span>
          <span className="ib-sp" />
          <Tip content="Close">
            <button ref={closeRef} type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close" data-tour-viewer-close="">
              <Icon name="x" />
            </button>
          </Tip>
        </header>
        <div className="ib-tv-stage">
          {failed ? (
            <p className="ib-tv-words" data-tour-viewer-words="">
              {picture.alt}
            </p>
          ) : (
            <img src={tourAssetUrl(picture.asset)} alt={picture.alt} onError={() => setFailed(true)} />
          )}
        </div>
        {picture.pick && (
          <footer>
            <button type="button" className="ib-btn ib-pri" onClick={() => onPick(picture.pick!)} data-tour-viewer-pick="">
              Pick {picture.pick}
            </button>
            <button type="button" className="ib-btn" onClick={onClose}>
              Close
            </button>
          </footer>
        )}
      </div>
    </div>,
    document.querySelector('.pn-inbox') ?? document.body,
  );
}

// ─────────────────────────── The tour Inbox ───────────────────────────

function tourFolder(fixture: TourFixture): ProjectFolder {
  return { id: TOUR_PROJECT_ID, key: 'tour', name: fixture.project, root: '', created_at: '', threads: 3, unread: 0, listed: 3, archived: 0 };
}

/** The tour Inbox's sidebar: the window's own, with the tour's one project; New message is live in step 8 only. */
export function TourNavigation({
  fixture,
  state,
  dispatch,
  onSettings,
  onCompose,
  say,
}: {
  fixture: TourFixture | null;
  state: TourState;
  dispatch: (a: TourAction) => void;
  onSettings: () => void;
  onCompose: (opener: HTMLElement) => void;
  say: (text: string) => void;
}) {
  const folders = fixture ? [tourFolder(fixture)] : [];
  const waiting = tourWaitingCount(state);
  return (
    <Sidebar
      page="inbox"
      projectId={null}
      inboxCount={waiting}
      projects={folders}
      projectCounts={new Map([[TOUR_PROJECT_ID, waiting]])}
      update={null}
      restarting={false}
      updated={null}
      onSearch={() => say('Search finds your own threads; it is not part of the tour.')}
      onCompose={onCompose}
      onInbox={() => dispatch({ type: 'list' })}
      onProject={() => dispatch({ type: 'list' })}
      onSettings={onSettings}
      onUpdate={() => {}}
      onWhatsNew={() => {}}
      connectPrompt={false}
    />
  );
}

/** The tour's compose: one live session (Claude Code in the tour's project), and a Send that only tells the tour. */
export function tourComposeTransport(fixture: TourFixture, onSent: () => void): ComposeTransport {
  const project = { id: TOUR_PROJECT_ID, name: fixture.project, root: '' };
  const model: ComposeSessionsModel = {
    serverSession: 'tour',
    home: '',
    projects: [
      {
        project,
        sessions: [{ session: TOUR_SESSION, host: 'claude-code', started_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), busy: false, idle_since: null, last_thread: null }],
      },
    ] as ComposeSessionsModel['projects'],
  };
  return {
    sessions: async () => model,
    startThread: async () => {
      onSent();
      return { thread_id: TOUR_NEW_THREAD, project };
    },
    drafts: false,
    uploads: false,
  };
}

const noop = () => {};

export interface TourMainProps {
  fixture: TourFixture;
  state: TourState;
  dispatch: (action: TourAction, options?: { focusCoach?: boolean }) => void;
  phone: boolean;
  stacked: { thread: boolean; file: boolean };
  reduced: boolean;
  say: (text: string) => void;
  onDegraded?: (change: TourDegraded) => void;
  /** What is on screen that the state does not hold (TourUi): the coach follows it. */
  onUi?: (ui: TourUi) => void;
  /** Step 8's compose: open it (the sidebar's, the list header's New message). */
  onCompose: (opener: HTMLElement) => void;
}

/** The view on top, for `.pn-inbox[data-view]`. */
export function tourView(state: TourState): 'list' | 'thread' | 'file' {
  if (state.file) return 'file';
  return state.route === 'list' ? 'list' : 'thread';
}

/** The ui the coach follows, read from the page every 300 ms while the tour shows. */
function useTourUi(onUi: ((ui: TourUi) => void) | undefined) {
  const last = useRef('');
  useEffect(() => {
    if (!onUi) return;
    const read = () => {
      const pinned = document.querySelector('[data-attachment-pane] [data-video-time][data-pinned]');
      const to = document.querySelector('[data-compose] [data-compose-to]')?.getAttribute('data-compose-to');
      const ui: TourUi = {
        composing: document.querySelector('[data-comment-popover]') !== null,
        drawn: document.querySelector('[data-attachment-pane] [data-image-composer] .ib-markup') !== null,
        pinnedAt: pinned?.textContent?.trim() || null,
        toChosen: to === TOUR_SESSION,
      };
      const key = JSON.stringify(ui);
      if (key !== last.current) {
        last.current = key;
        onUi(ui);
      }
    };
    read();
    const timer = setInterval(read, 300);
    return () => clearInterval(timer);
  }, [onUi]);
}

export function TourMain({ fixture, state, dispatch, phone, stacked, reduced, say, onDegraded, onUi, onCompose }: TourMainProps) {
  const [viewer, setViewer] = useState<{ picture: TourViewerPicture; opener: HTMLElement | null } | null>(null);
  const degradedRef = useRef(onDegraded);
  degradedRef.current = onDegraded;
  useTourUi(onUi);
  useEffect(() => {
    const onError = (event: Event) => {
      const img = event.target;
      if (!(img instanceof HTMLImageElement) || !img.src.includes('/api/inbox/tour/assets/')) return;
      requestAnimationFrame(() => {
        const card = document.querySelector('[data-tour-message="ask"] .question-block');
        if (card && !card.querySelector('[data-question-tiles]')) degradedRef.current?.({ pictures: true });
      });
    };
    document.addEventListener('error', onError, true);
    return () => document.removeEventListener('error', onError, true);
  }, []);
  const question = useMemo(() => tourQuestion(fixture), [fixture]);
  const sections = useMemo(() => tourSections(fixture, state), [fixture, state]);
  const openThread = state.route === 'list' ? null : state.route;
  const files = useMemo(() => tourAttachments(fixture, state), [fixture, state]);
  const stateRef = useRef(state);
  stateRef.current = state;

  // The real viewers over the tour's files: a comment saved there goes to the tour's state, never anywhere else.
  const source = useMemo(
    () =>
      tourFileSource(fixture, {
        onSave: (record) => {
          dispatch({ type: 'comment', record }, { focusCoach: true });
          say('Comment saved in the tour.');
        },
        onRemove: (id) => dispatch({ type: 'uncomment', id }),
        threadOf: (messageId) => fixture.threads.find((t) => t.messages.some((m) => m.id === messageId))?.id ?? TOUR_THREAD,
      }),
    [fixture, dispatch, say],
  );

  // The phrases the coach points at, highlighted while their step shows.
  const ask = question?.message;
  const evalPhrase = ask?.attachments?.find((a) => a.name === 'EVALUATION.md')?.suggest?.phrase ?? null;
  useTourPhrases({
    message: state.step === 3 && openThread === TOUR_THREAD ? (ask?.suggest?.phrase ?? null) : null,
    file: state.step === 4 && state.file ? evalPhrase : null,
  });

  const closeViewer = useCallback(() => {
    const opener = viewer?.opener;
    setViewer(null);
    requestAnimationFrame(() => opener?.isConnected && opener.focus());
  }, [viewer]);

  // A choice's magnifier opens the picture large; the viewer can pick it.
  const onImage = useCallback(
    (src: string, alt: string) => {
      const name = tourAssetNameOf(src);
      const choice = question?.question.parsed.choices.find((c) => c.image?.src === name);
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const pickable = choice && openThread === TOUR_THREAD && !state.sent;
      const asset = choice?.image?.src ?? name;
      setViewer({
        picture: {
          asset: tourFullPicture(fixture, asset),
          name: choice ? `${choice.label.split(' · ')[0]}: ${asset}` : asset,
          caption: choice ? `${choice.label}${choice.description ? ` · ${choice.description.replace(/!\[[^\]]*\]\([^)]*\)\s*/g, '')}` : ''}` : alt,
          alt: alt || choice?.label || name,
          pick: pickable ? choice!.label : undefined,
        },
        opener,
      });
    },
    [fixture, question, openThread, state.sent],
  );

  const openFile = useCallback(
    (attachment: InboxAttachmentState, view?: 'full' | 'side' | null) => {
      const full = phone || stacked.file ? true : (view ?? kindDefaultView(attachment)) === 'full';
      dispatch({ type: 'openFile', id: attachment.id, full }, { focusCoach: true });
      say(`${attachment.name} is open${full ? ' full screen' : ' beside the thread'}.`);
    },
    [dispatch, phone, stacked.file, say],
  );

  const list = (
    <InboxList
      title="Inbox"
      path={null}
      sections={sections}
      filtered={false}
      narrow={openThread !== null && !phone && !stacked.thread}
      selectedThreadId={openThread}
      notice={null}
      onShowNew={noop}
      onOpen={(r) => dispatch({ type: 'open', thread: r.thread_id }, { focusCoach: true })}
      onCompose={state.step === 8 && state.compose !== 'sent' ? onCompose : undefined}
      phone={phone}
    />
  );

  const threadFiles = openThread ? files.filter((a) => fixture.threads.find((t) => t.id === openThread)?.messages.some((m) => m.id === a.message_id)) : [];
  const pane = openThread ? (
    <TourThreadPane
      fixture={fixture}
      threadId={openThread}
      state={state}
      files={threadFiles}
      dispatch={dispatch}
      phone={phone}
      stacked={stacked.thread}
      withFile={state.file !== null}
      reduced={reduced}
      onImage={onImage}
      onOpenFile={openFile}
      say={say}
    />
  ) : null;

  const openAttachment = state.file ? (files.find((a) => a.id === state.file!.id) ?? null) : null;
  const paneRef = useRef<AttachmentPaneHandle>(null);
  const [paneFocus, setPaneFocus] = useState(0);
  useEffect(() => {
    if (state.file) setPaneFocus((n) => n + 1);
  }, [state.file?.id]);
  const steps = useMemo(() => {
    if (!openThread) return [];
    const wires = tourMessages(fixture, openThread, state).map((v) => v.wire);
    return stepsOf(threadArtifacts(wires, threadFiles.filter((a) => a.ref === undefined), threadFiles.filter((a) => a.ref !== undefined)));
  }, [fixture, openThread, state, threadFiles]);
  const records = state.comments.filter((r) => r.attachment_id !== '' && r.thread_id === openThread);
  const waitingHere = state.comments.filter((r) => r.thread_id === openThread && r.sent_reply_id === null).length;
  const file = openAttachment ? (
    <AttachmentPane
      ref={paneRef}
      attachment={openAttachment}
      attachments={threadFiles}
      records={records}
      agent="Claude Code"
      projectName={fixture.project}
      projectRoot=""
      version="current"
      onVersion={noop}
      full={state.file!.full}
      fullLocked={phone || stacked.file}
      phone={phone}
      steps={steps}
      onStep={(id) => {
        const next = threadFiles.find((a) => a.id === id);
        if (next) dispatch({ type: 'openFile', id, full: state.file!.full });
      }}
      onOpenLinked={(id) => dispatch({ type: 'openFile', id, full: state.file!.full })}
      onToggleFull={() => dispatch({ type: 'fullFile', full: !state.file!.full })}
      onKeepView={noop}
      focusId={null}
      focusRequest={paneFocus}
      readOnly={false}
      onSaved={noop}
      onRemoved={noop}
      onOpenAt={(id) => dispatch({ type: 'openFile', id, full: state.file!.full })}
      onClose={() => dispatch({ type: 'closeFile' }, { focusCoach: true })}
      strip={{
        picks: openThread === TOUR_THREAD && state.picked && !state.sent ? 1 : 0,
        annotations: waitingHere,
        onWriteReply: () => {
          dispatch({ type: 'fullFile', full: false });
          dispatch({ type: 'closeFile' });
          dispatch({ type: 'reply', open: true });
        },
      }}
    />
  ) : null;

  let main: ReactNode;
  if (phone) main = file ?? pane ?? list;
  else if (file)
    main = stacked.file || state.file!.full ? (
      file
    ) : (
      <>
        {pane}
        {file}
      </>
    );
  else if (pane && stacked.thread) main = pane;
  else
    main = (
      <>
        {list}
        {pane}
      </>
    );

  return (
    <InboxFileSourceProvider source={source}>
      {main}
      {viewer && (
        <TourViewer
          picture={viewer.picture}
          onClose={closeViewer}
          onPick={(label) => {
            setViewer(null);
            dispatch({ type: 'pick', label });
            say(`Picked ${label}.`);
          }}
        />
      )}
    </InboxFileSourceProvider>
  );
}

function MessageHead({ who, host, to, time, project, replay }: { who: string; host: 'claude-code' | null; to: string; time: string; project: string; replay: boolean }) {
  return (
    <div className="ib-fline ib-is-open" data-open-head="">
      <span className="ib-a11y-skip">
        {host ? (
          <HostMark host={host} big />
        ) : (
          <span className="ib-mk ib-big">
            <Icon name="reply" />
          </span>
        )}
      </span>
      <span className="ib-fl-nm ib-who">
        <bdi>{who}</bdi>
      </span>
      <span className="ib-fl-meta">
        <span className="ib-fl-in">
          in <bdi>{project}</bdi>{' '}
        </span>
        <span className="ib-fl-to">
          <span className="ib-to-sep">·</span> <span className="ib-to">{to}</span>
        </span>
      </span>
      <span className="ib-fl-chips" />
      <span className="ib-fl-tm">
        <span>{time}</span>
        {replay && <span className="ib-tour-realtime">Replay</span>}
      </span>
    </div>
  );
}

/** "Claude Code's message, 12:03 PM": how a reply's list names the message it answers. */
const messageName = (time: string) => `Claude Code’s message, ${tourTime(time)}`;

function TourThreadPane({
  fixture,
  threadId,
  state,
  files,
  dispatch,
  phone,
  stacked,
  withFile,
  reduced,
  onImage,
  onOpenFile,
  say,
}: {
  fixture: TourFixture;
  threadId: string;
  state: TourState;
  files: InboxAttachmentState[];
  dispatch: TourMainProps['dispatch'];
  phone: boolean;
  stacked: boolean;
  withFile: boolean;
  reduced: boolean;
  onImage: (src: string, alt: string) => void;
  onOpenFile: (attachment: InboxAttachmentState, view?: 'full' | 'side' | null) => void;
  say: (text: string) => void;
}) {
  const thread = fixture.threads.find((t) => t.id === threadId)!;
  const isA = threadId === TOUR_THREAD;
  const isFilm = threadId === TOUR_FILM_THREAD;
  const views = useMemo(() => tourMessages(fixture, threadId, state), [fixture, threadId, state]);
  const wires = useMemo(() => views.map((v) => v.wire), [views]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const realAnswer = thread.real_answer ?? '';
  const pictureLabel = (phone ? thread.picture_label_short : null) ?? thread.picture_label ?? null;
  const subject = tourSubject(thread);
  const artifacts = useMemo(() => threadArtifacts(wires, files.filter((a) => a.ref === undefined), files.filter((a) => a.ref !== undefined)), [wires, files]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of state.comments) if (r.attachment_id && r.sent_reply_id === null) m.set(r.path, (m.get(r.path) ?? 0) + 1);
    return m;
  }, [state.comments]);
  const waiting = state.comments.filter((r) => r.thread_id === threadId && r.sent_reply_id === null);

  // A replay follows the thread's end, the way the Inbox follows an arrival at the bottom.
  const arrivals = `${state.delivered}${state.arrived}${state.filmDelivered}${state.filmArrived}${state.newDelivered}${state.newArrived}`;
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    if ((isA && state.sent && state.step === 6 && state.arrived < 2) || (isFilm && state.filmSent) || threadId === TOUR_NEW_THREAD) body.scrollTo({ top: body.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals]);

  const back = (
    <button type="button" className="ib-pback" onClick={() => dispatch({ type: 'list' }, { focusCoach: true })} aria-label="Back to Inbox" data-tour-thread-back="">
      <Icon name="chevL" size={phone ? 18 : 16} />
      <span className="ib-pback-l">Inbox</span>
    </button>
  );
  const offInTour = (label: string, icon: 'checkCircle' | 'archive', withLabel: boolean) => (
    <Tip content={`${label}: not in the tour`}>
      <button type="button" className={withLabel ? 'ib-hbtn' : 'ib-iconbtn'} aria-disabled="true" aria-label={withLabel ? undefined : label} onClick={noop}>
        <Icon name={icon} size={16} />
        {withLabel && label}
      </button>
    </Tip>
  );
  const artifactsButton = artifacts.length > 0 && (
    <Tip content={state.artifactsOpen ? 'Back to the thread' : 'Artifacts: every file, image and guided review in this thread'}>
      <button
        type="button"
        className="ib-iconbtn ib-artbtn"
        aria-label={`Artifacts, ${artifacts.length}`}
        aria-pressed={state.artifactsOpen}
        onClick={() => dispatch({ type: 'artifacts', open: !state.artifactsOpen }, { focusCoach: true })}
        data-artifacts-button=""
      >
        <Icon name="artifacts" size={17} />
        <span className="ib-artbtn-n" aria-hidden="true">
          {artifacts.length}
        </span>
      </button>
    </Tip>
  );

  // ── the reply box: thread A until its Send, the film's once its comment waits ──
  const asking = views.find((v) => v.fixture?.asks);
  const question = asking?.wire.questions?.[0];
  const draftAnswers: DraftAnswer[] =
    isA && !state.sent && question?.answer
      ? [{ id: `${asking!.wire.id}/${question.key}`, messageId: asking!.wire.id, key: question.key, number: question.position + 1, prompt: question.prompt, answer: draftAnswerWords(question.answer), messageName: messageName(asking!.fixture!.time) }]
      : [];
  const canReply = isA ? !state.sent && !!state.picked : isFilm ? !state.filmSent && waiting.length > 0 : false;
  const boxOpen = canReply && (state.replyOpen || (isFilm && waiting.length > 0));
  const sendReady = isA ? state.step === 5 : isFilm && state.step === 7;
  const sendNow = () => {
    if (isA) {
      dispatch({ type: 'send' }, { focusCoach: true });
      say('Sent. Sending to Claude Code.');
    } else {
      dispatch({ type: 'filmSend' }, { focusCoach: true });
      say('Sent. Sending to Claude Code.');
    }
  };
  const editRecord = async (record: InboxAnnotationRecord, text: string) => {
    dispatch({ type: 'comment', record: { ...record, annotation: { ...record.annotation, text }, updated_at: new Date().toISOString() } });
  };
  const removeRecord = async (record: InboxAnnotationRecord) => dispatch({ type: 'uncomment', id: record.id });
  const openRecord = (record: InboxAnnotationRecord) => {
    const at = files.find((a) => a.id === record.attachment_id);
    if (at) onOpenFile(at);
  };
  const chipName = (record: InboxAnnotationRecord) => {
    const m = thread.messages.find((x) => x.id === record.message_id);
    return messageName(m?.time ?? '12:03');
  };
  const sendButton = (attr: Record<string, string>) => (
    <Tip content={sendReady ? 'Send it, in the tour: a replay of the real thread' : 'In the tour, Send comes after the comments'}>
      <button type="button" className="ib-btn ib-pri" aria-disabled={!sendReady || undefined} onClick={() => sendReady && sendNow()} {...attr}>
        <Icon name="send" size={15} />
        Send
      </button>
    </Tip>
  );
  const replyBox = boxOpen ? (
    <div className="ib-rbox ib-tour-rbox" data-tour-rbox="">
      <textarea className="ib-rtext" readOnly rows={2} placeholder="Your words go here in a real reply." aria-label="Your reply (the tour carries no words)" />
      {draftAnswers.length > 0 && <ReplyAnswers answers={draftAnswers} onJump={noop} />}
      <div className="ib-rfoot">
        {draftAnswers.length > 0 && (
          <span className="ib-rchip" data-picks-chip="">
            <Icon name="check" size={13} />
            {plural(draftAnswers.length, 'pick')}
          </span>
        )}
        <AnnotationsChip records={waiting} attachments={files} onEdit={editRecord} onRemove={removeRecord} onOpen={openRecord} messageName={chipName} />
      </div>
    </div>
  ) : null;

  const footStatus = isA && !state.sent && state.picked ? `${plural(1, 'pick')}${waiting.length > 0 ? `, ${plural(waiting.length, 'comment')}` : ''}` : null;
  let foot: ReactNode;
  if (boxOpen)
    foot = (
      <>
        {replyBox}
        <div className="ib-acts">
          {sendButton(isA ? { 'data-tour-send': '' } : { 'data-tour-film-send': '' })}
          {isA && (
            <button type="button" className="ib-btn ib-ghost" onClick={() => dispatch({ type: 'reply', open: false })}>
              Cancel
            </button>
          )}
        </div>
      </>
    );
  else if (canReply)
    foot = (
      <div className="ib-acts ib-footrow" data-foot-row="">
        <div className="ib-footbtns" data-foot-buttons="">
          <button type="button" className="ib-btn ib-pri" data-tour-reply="" onClick={() => dispatch({ type: 'reply', open: true }, { focusCoach: true })}>
            <Icon name="send" size={15} />
            Send
          </button>
          <button type="button" className="ib-btn" onClick={() => dispatch({ type: 'reply', open: true })}>
            <Icon name="pen" size={15} />
            Edit draft
          </button>
        </div>
        {footStatus && (
          <div className="ib-footstatus" data-foot-status="">
            <span className="ib-draft-foot">
              <span className="ib-draft-pill">Draft</span> <span className="ib-st">{footStatus}</span>
            </span>
          </div>
        )}
      </div>
    );
  else
    foot = (
      <div className="ib-acts ib-footrow" data-foot-row="">
        <div className="ib-footbtns" data-foot-buttons="">
          <Tip content={isA && !state.sent ? 'In the tour, pick an answer above first' : isFilm && !state.filmSent ? 'Comment on the film first; the comment goes with the reply' : 'Replies are not part of the tour'}>
            <button type="button" className="ib-btn" aria-disabled="true" onClick={noop}>
              <Icon name="reply" size={15} />
              Reply
            </button>
          </Tip>
        </div>
      </div>
    );

  const lastArrival = [...views].reverse().find((v) => v.replay)?.wire.id ?? null;
  const replayAt = views.findIndex((v) => v.replay);
  return (
    <section className={`ib-pane${withFile ? ' ib-withfile' : ''}`} aria-label={subject} data-thread-id={thread.id} data-tour-thread="">
      <div className="ib-phead">
        {phone ? (
          <>
            {back}
            <span className="ib-sp" />
            {artifactsButton}
            {offInTour('Archive', 'archive', false)}
          </>
        ) : (
          <>
            {stacked && (
              <>
                {back}
                <span className="ib-vsep" aria-hidden="true" />
              </>
            )}
            {offInTour('Mark read', 'checkCircle', true)}
            <span className="ib-sp" />
            {artifactsButton}
            {offInTour('Archive', 'archive', false)}
            {!stacked && (
              <>
                <span className="ib-vsep" aria-hidden="true" />
                <Tip content="Close">
                  <button type="button" className="ib-iconbtn" onClick={() => dispatch({ type: 'list' }, { focusCoach: true })} aria-label="Close the thread">
                    <Icon name="x" />
                  </button>
                </Tip>
              </>
            )}
          </>
        )}
      </div>
      {state.artifactsOpen ? (
        <div className="ib-artbody">
          <ArtifactsView
            artifacts={artifacts}
            annotationCounts={counts}
            openId={state.file?.id ?? null}
            onOpen={(artifact) => onOpenFile(artifact.attachment)}
            onOpenGuide={noop}
            onBack={phone ? undefined : () => dispatch({ type: 'artifacts', open: false }, { focusCoach: true })}
            phone={phone}
          />
        </div>
      ) : (
        <div className="ib-pbody" ref={bodyRef}>
          <h2 className="ib-subject" dir="auto" tabIndex={-1}>
            {subject}
          </h2>
          {thread.slice && (
            <p className="ib-tour-slice">
              <Icon name="chevD" size={14} />
              {thread.slice}
            </p>
          )}
          {thread.person && (
            <p className="ib-tour-slice" data-tour-started="">
              <Icon name="pen" size={14} />
              You started this thread · to Claude Code in {fixture.project}
            </p>
          )}
          {views.map((view, index) => {
            const m = view.wire;
            const fx = view.fixture;
            const isAgent = m.author.kind === 'agent';
            const asks = !!fx?.asks;
            const q = m.questions?.[0];
            const answers = new Map<string, QuestionAnswer>(q?.answer ? [[q.key, q.answer]] : []);
            const footerFor = (key: string) => {
              const found = m.questions?.find((x) => x.key === key);
              if (!found?.answer) return null;
              if (found.state === 'sent') return `Sent ${tourTime(thread.reply_time ?? '12:17')}`;
              if (found.answer.skipped) return 'Skipped · in your draft';
              return tourPickOf(found.answer) ? 'Picked · in your draft' : 'Note · in your draft';
            };
            const sentAnswers = view.reply && isA ? sentAnswersOf(m, wires, (a) => messageName(views.find((v) => v.wire.id === a.id)?.fixture?.time ?? '12:03')) : undefined;
            const messageComments = state.comments.filter((r) => r.message_id === m.id && r.message).map((r) => annotationOf(r) as Annotation);
            const takesComments = isAgent && isA && asks && !state.sent;
            const sentHere = view.reply ? state.comments.filter((r) => r.sent_reply_id === m.id) : [];
            const delivered = view.reply && (m.id === TOUR_REPLY_ID ? state.delivered : m.id === TOUR_FILM_REPLY_ID ? state.filmDelivered : state.newDelivered);
            const replyTime = m.id === TOUR_REPLY_ID ? (thread.reply_time ?? '12:17') : m.id === TOUR_FILM_REPLY_ID ? (thread.reply_time ?? '18:10') : (thread.compose?.time ?? '13:06');
            const myFiles = files.filter((a) => a.message_id === m.id && a.ref === undefined);
            const note = fx?.attachments?.find((a) => a.note)?.note;
            return (
              <div key={m.id}>
                {index === replayAt && !thread.person && (
                  <div className="ib-tour-replay" role="note">
                    <Icon name="replay" size={14} />
                    Replay of the real thread: what Claude Code did next
                  </div>
                )}
                <article
                  className="ib-message"
                  data-author={m.author.kind}
                  data-tour-message={asks ? 'ask' : view.reply ? 'reply' : undefined}
                  data-tour-arrival={view.replay ? (fx?.replay ?? 1) : undefined}
                  data-tour-arrival-last={m.id === lastArrival ? '' : undefined}
                >
                  <MessageHead who={view.who} host={isAgent ? 'claude-code' : null} to={view.to} time={view.time} project={fixture.project} replay={view.replay} />
                  <div className="ib-msg">
                    {isA && fx?.replay === 1 && pickDiffers(state, realAnswer) && (
                      <p className="ib-tour-note" data-tour-differs="">
                        {tourPickWords(state.picked!)}. In the real thread the answer was {realAnswer.split(' · ')[0]}, so this is what Claude Code built.
                      </p>
                    )}
                    {(m.body || view.reply) && (
                      <MessageBody
                        message={m}
                        projectRoot=""
                        onOpenAttachment={(a) => {
                          const found = files.find((x) => x.id === a.id);
                          if (found) onOpenFile(found);
                        }}
                        onOpenInlineImage={(image: InboxInlineImage) => {
                          const found = files.find((x) => x.id === image.id);
                          if (found) onOpenFile(found, 'full');
                        }}
                        inlineRefOf={inlineRefOf}
                        readOnly={!isAgent || !isA || !asks || state.sent}
                        answers={answers}
                        onPick={(_key, answer) => {
                          const picked = tourPickOf(answer);
                          dispatch({ type: 'pick', label: picked, answer });
                          if (picked) say(`${tourPickWords(picked)}.`);
                        }}
                        footerFor={footerFor}
                        sentAnswers={sentAnswers}
                        imageBase={TOUR_IMAGE_BASE}
                        onImage={(src, alt) => {
                          const ref = inlineRefOf(src);
                          const image = ref ? files.find((x) => x.ref === ref && x.message_id === m.id) : null;
                          if (image) onOpenFile(image, 'full');
                          else onImage(src, alt);
                        }}
                        pictureBadge={pictureLabel ? () => pictureLabel : undefined}
                        comments={
                          takesComments
                            ? {
                                annotations: messageComments,
                                onSave: async (annotation) => {
                                  dispatch(
                                    {
                                      type: 'comment',
                                      record: tourRecord({ id: annotation.id, thread: threadId, message: m.id, messageAt: m.created_at, annotation: annotation as unknown as Record<string, unknown> }),
                                    },
                                    { focusCoach: true },
                                  );
                                  say('Comment saved in the tour. It goes with your reply.');
                                  return true;
                                },
                                suggest: (selected) => {
                                  const s = fx?.suggest;
                                  if (!s?.phrase) return undefined;
                                  const words = selected.replace(/\s+/g, ' ').trim();
                                  return words && (s.phrase.includes(words) || words.includes(s.phrase)) ? s.comment : undefined;
                                },
                              }
                            : undefined
                        }
                      />
                    )}
                    {myFiles.length > 0 && <AttachmentTiles attachments={myFiles} annotationCounts={counts} onOpen={(a) => onOpenFile(a)} openId={state.file?.id ?? null} />}
                    {note && <p className="ib-tour-filenote">{note}</p>}
                    {sentHere.length > 0 && (
                      <div className="ib-tour-sentcomments" data-tour-sent-comments="">
                        <Icon name="comment" size={13} />
                        <span>{plural(sentHere.length, 'comment')} went with this reply</span>
                        {sentHere
                          .map((r) => readInboxVideoTime(annotationOf(r)))
                          .filter((t): t is number => t !== null)
                          .map((t) => (
                            <span key={t} className="ib-tour-moment">
                              at {formatInboxVideoTime(t)}, with its frame
                            </span>
                          ))}
                      </div>
                    )}
                    {view.reply && (
                      <div className="ib-delivered" data-delivery={delivered ? 'delivered' : 'sending'} data-tour-delivered="" tabIndex={-1}>
                        <span className="ib-dl-main">
                          <Icon name={delivered ? 'check' : 'send'} size={14} />
                          <span className="ib-dl-text">{delivered ? `Delivered to Claude Code, ${tourTime(replyTime)}` : 'Sending to Claude Code…'}</span>
                        </span>
                        <span className="ib-tour-realtime">Replay</span>
                      </div>
                    )}
                  </div>
                </article>
              </div>
            );
          })}
        </div>
      )}
      <div className="ib-pfoot" hidden={state.artifactsOpen}>
        {foot}
      </div>
    </section>
  );
}

/** A tour image's src back to the name the body wrote (`built-a1.webp`): its blob URL or its asset route. */
function inlineRefOf(src: string): string | null {
  const name = tourAssetNameOf(src);
  return /^[a-z0-9][a-z0-9.-]*\.webp$/.test(name) ? name : null;
}

/** While the tour loads (its content, once per page): a quiet heading; Exit is in the bar above. */
export function TourLoading() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) headingRef.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section className="ib-listcol" aria-label="Tour">
      <div className="ib-lbody">
        <div className="ib-empty" data-tour-loading="loading" aria-busy="true">
          <h2 ref={headingRef} tabIndex={-1}>
            Loading the tour…
          </h2>
        </div>
      </div>
    </section>
  );
}

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)';

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia?.(REDUCED_QUERY);
    if (!query) return;
    const on = () => setReduced(query.matches);
    query.addEventListener?.('change', on);
    return () => query.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Thread A's question message: its suggested words (for tests and the e2e walk). */
export function tourMessagePhrase(fixture: TourFixture): string | null {
  return tourQuestion(fixture)?.message.suggest?.phrase ?? null;
}

export { tourCanBack, tourFileOf };

/** The compose request the tour opens: its suggested words. */
export function tourComposeBody(fixture: TourFixture): string {
  return fixture.threads.find((t) => t.id === TOUR_NEW_THREAD)?.compose?.body ?? '';
}

export { ComposeDialog };
export type { InboxMessageWire };
