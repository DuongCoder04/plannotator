/**
 * The Inbox's onboarding tour (approval "inbox-onboarding-tour"): the window's
 * own list, thread and question card, fed from the tour's fixture instead of
 * the person's store. Picks and Send change only the tour's state
 * (model.ts); nothing here calls a route that writes. The person's own Inbox
 * stays mounted in App, untouched, and comes back on exit.
 *
 * What is here: the tour bar, the coach card, the tour Inbox (list, thread,
 * the mock beside it), the picture viewer, and the hook that loads the
 * fixture (GET /api/inbox/tour/fixture.json, served lazily from the binary).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { inboxApi } from '../api';
import { Icon, HostMark } from '../icons';
import { InboxList } from '../components/InboxList';
import { MessageBody } from '../components/Thread';
import { Sidebar } from '../components/Sidebar';
import { Tip } from '../components/Tip';
import { TOUR_IMAGE_BASE } from '../images';
import { sentAnswersOf } from '../sentReply';
import type { ProjectFolder } from '../api';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import {
  TOUR_PROJECT_ID,
  TOUR_SIDE_THREAD,
  TOUR_STEPS,
  TOUR_THREAD,
  parseTourFixture,
  pickDiffers,
  replayTimings,
  tourAssetUrl,
  tourCanBack,
  tourFullPicture,
  tourMessages,
  tourQuestion,
  tourSections,
  tourTime,
  tourWaitingCount,
  type TourAction,
  type TourCoach as TourCoachModel,
  type TourFixture,
  type TourFixtureMessage,
  type TourPicture,
  type TourState,
  type TourTarget,
} from './model';

// ─────────────────────────── Loading the fixture ───────────────────────────

let fixtureLoad: Promise<TourFixture> | null = null;

/** The fixture, read once per page (and again after a failed read). */
export function useTourFixture(active: boolean): { fixture: TourFixture | null; error: string | null; retry: () => void } {
  const [fixture, setFixture] = useState<TourFixture | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!active || fixture) return;
    let gone = false;
    fixtureLoad ??= inboxApi.tourFixture().then(parseTourFixture);
    fixtureLoad.then(
      (f) => !gone && (setFixture(f), setError(null)),
      (cause: unknown) => {
        fixtureLoad = null;
        if (!gone) setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      gone = true;
    };
  }, [active, fixture, attempt]);
  return { fixture, error, retry: () => setAttempt((n) => n + 1) };
}

/**
 * The replay after Send (step 4): delivered, then the two messages the real
 * thread got next, on timers. A state reached directly (a reload of
 * `#tour=4`) has everything already, so nothing is scheduled.
 */
export function useTourReplay(state: TourState, dispatch: (action: TourAction) => void, reduced: boolean, say: (text: string) => void): void {
  const sent = state.sent;
  const done = state.delivered && state.arrived >= 2;
  useEffect(() => {
    if (!sent || done) return;
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
        say('New message from Claude Code: the pull request, with screenshots.');
      }, t.second),
    ];
    return () => timers.forEach(clearTimeout);
    // Scheduled once per Send; the state it reached is read by the reducer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sent]);
}

// ─────────────────────────── The tour bar ───────────────────────────

export function TourBar({
  step,
  phone,
  arrivals,
  onArrivals,
  onExit,
}: {
  step: number;
  phone: boolean;
  /** Real messages that reached the person's Inbox during the tour (choice 7: a chip, never an interruption). */
  arrivals: number;
  onArrivals: () => void;
  onExit: () => void;
}) {
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

const TARGET_SELECTORS: Record<TourTarget, string> = {
  row: `[data-thread-id="${TOUR_THREAD}"]:is(button, a, [role="button"])`,
  choices: `[data-tour-message="ask"] [data-question-tiles]`,
  send: '[data-tour-send]',
  delivered: '[data-tour-delivered]',
  arrival: '[data-tour-arrival="2"]',
  'mock-tile': '[data-tour-mock-tile]',
  file: '[data-tour-file]',
};

/** The element a coach card points at, when it is on screen. */
export function tourTargetElement(target: TourTarget | null, root: ParentNode = document): HTMLElement | null {
  if (!target) return null;
  return root.querySelector<HTMLElement>(TARGET_SELECTORS[target]);
}

type Side = 'right' | 'left' | 'below' | 'above' | 'corner';

const SIDES: Record<TourTarget, Side[]> = {
  row: ['below', 'above', 'right'],
  choices: ['left', 'right', 'above', 'below'],
  send: ['above', 'left', 'right'],
  delivered: ['left', 'above', 'below'],
  arrival: ['left', 'above', 'right'],
  'mock-tile': ['left', 'above', 'right', 'below'],
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

/**
 * A phone: the coach is a sheet at the top or the bottom. Scroll what it
 * points at into the room the sheet leaves (its top first when it is taller),
 * so the sheet never covers the control it asks for. Once per card, so it
 * never fights the person's own scrolling.
 */
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

export function TourCoach({
  coach,
  step,
  canBack,
  phone,
  reduced,
  focusTick,
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
    const target = tourTargetElement(coach.target);
    // The coach and the outline it draws around what it points at.
    for (const old of document.querySelectorAll('.ib-tour-target')) if (old !== target) old.classList.remove('ib-tour-target');
    target?.classList.add('ib-tour-target');
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const bar = document.querySelector('[data-tour-bar]')?.getBoundingClientRect().bottom ?? 0;
    const m = 12;
    if (phone) {
      // A sheet at the bottom, or at the top when what it points at is low on the screen: never over its target.
      // Decided once per card (fitAroundSheet then scrolls the target into the room left), so it never flips.
      if (sheetAt.current?.key !== coach.key) {
        const r = target?.getBoundingClientRect();
        const low = r ? r.top + Math.min(r.height, vh / 2) / 2 > vh * 0.5 : false;
        sheetAt.current = { key: coach.key, at: low ? 'top' : 'bottom' };
      }
      setPlace({ left: 0, top: 0, at: sheetAt.current.at });
      return;
    }
    const r = target?.getBoundingClientRect();
    if (!r || coach.target === 'file') {
      setPlace({ left: m, top: Math.max(bar + m, vh - h - 16), at: 'bottom' });
      return;
    }
    const sides = SIDES[coach.target!];
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
    // Nowhere free: a corner away from the target's middle.
    const left = r.left + r.width / 2 > vw / 2 ? m : vw - w - m;
    setPlace({ left, top: Math.max(bar + m, vh - h - 16), at: 'bottom' });
  }, [coach.target, coach.key, phone]);

  useLayoutEffect(() => {
    measure();
    const target = tourTargetElement(coach.target);
    if (target && coach.target !== 'file') {
      // The picture choices: their question's prompt comes into view with them.
      if (phone) fitAroundSheet(coach.target === 'choices' ? (target.closest<HTMLElement>('.question-block') ?? target) : target, ref.current, reduced);
      else target.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
    }
    const again = () => measure();
    window.addEventListener('resize', again);
    document.addEventListener('scroll', again, true);
    // Pictures load and messages arrive: follow what moves.
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
    <div
      ref={ref}
      className="ib-tour-coach"
      role="region"
      aria-label={`Tour, step ${step} of ${TOUR_STEPS}`}
      data-tour-coach={coach.key}
      data-at={phone ? (place?.at ?? 'bottom') : undefined}
      style={style}
    >
      <div className="ib-tc-eb">
        Step {step} of {TOUR_STEPS}
      </div>
      <h2 ref={titleRef} tabIndex={-1}>
        {coach.title}
      </h2>
      <p>
        {coach.text}
        {coach.action && (
          <>
            {' '}
            <b>{coach.action}</b>
          </>
        )}
      </p>
      <div className="ib-tc-acts">
        {canBack && (
          <button type="button" className="ib-tc-back" onClick={onBack} data-tour-back="">
            Back
          </button>
        )}
        <span className="ib-sp" />
        {coach.next ? (
          <button type="button" className="ib-tc-next" onClick={onNext} data-tour-next="">
            Next
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

// ─────────────────────────── The picture viewer ───────────────────────────

export interface TourViewerPicture {
  asset: string;
  name: string;
  caption: string;
  alt: string;
  /** The choice this picture shows, when it can still be picked from the viewer. */
  pick?: string;
}

/** A picture large, over the window (the file viewer's stand-in): Close and Escape leave it, focus goes back where it was. */
export function TourViewer({ picture, onPick, onClose }: { picture: TourViewerPicture; onPick: (label: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
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
    // Focus stays in the viewer.
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
          <img src={tourAssetUrl(picture.asset)} alt={picture.alt} />
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

/** The tour's one project, as the sidebar draws a folder. */
function tourFolder(fixture: TourFixture): ProjectFolder {
  return { id: TOUR_PROJECT_ID, key: 'tour', name: fixture.project, root: '', created_at: '', threads: 2, unread: 0, listed: 2, archived: 0 };
}

/** The tour Inbox's sidebar: the window's own, with the tour's one project. */
export function TourNavigation({ fixture, state, dispatch, onSettings }: { fixture: TourFixture | null; state: TourState; dispatch: (a: TourAction) => void; onSettings: () => void }) {
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
      onInbox={() => dispatch({ type: 'list' })}
      onProject={() => dispatch({ type: 'list' })}
      onSettings={onSettings}
      onUpdate={() => {}}
      onWhatsNew={() => {}}
      connectPrompt={false}
    />
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

function Gallery({ pictures, onOpen }: { pictures: TourPicture[]; onOpen: (picture: TourPicture, opener: HTMLElement) => void }) {
  return (
    <div className="ib-tour-gal">
      {pictures.map((p) => (
        <button key={p.name} type="button" onClick={(event) => onOpen(p, event.currentTarget)} aria-label={`Open ${p.name}, ${p.caption}`} data-tour-picture={p.asset}>
          <img src={tourAssetUrl(p.asset)} alt="" loading="lazy" />
          <span className="ib-tg-n">{p.name}</span>
          <span className="ib-kd">{p.caption}</span>
        </button>
      ))}
    </div>
  );
}

const noop = () => {};

export interface TourMainProps {
  fixture: TourFixture;
  state: TourState;
  dispatch: (action: TourAction, options?: { focusCoach?: boolean }) => void;
  phone: boolean;
  /** A window too narrow for two panes (stack.ts): the thread covers the list, the mock covers the thread. */
  stacked: { thread: boolean; file: boolean };
  reduced: boolean;
  say: (text: string) => void;
}

/** The view on top, for `.pn-inbox[data-view]` (the window's phone and stacked rules read it). */
export function tourView(state: TourState): 'list' | 'thread' | 'file' {
  if (state.mock) return 'file';
  return state.route === 'list' ? 'list' : 'thread';
}

export function TourMain({ fixture, state, dispatch, phone, stacked, reduced, say }: TourMainProps) {
  const [viewer, setViewer] = useState<{ picture: TourViewerPicture; opener: HTMLElement | null } | null>(null);
  const question = useMemo(() => tourQuestion(fixture), [fixture]);
  const sections = useMemo(() => tourSections(fixture, state), [fixture, state]);
  const openThread = state.route === 'list' ? null : state.route;

  const closeViewer = useCallback(() => {
    const opener = viewer?.opener;
    setViewer(null);
    // Back to the magnifier (or picture) that opened it.
    requestAnimationFrame(() => opener?.isConnected && opener.focus());
  }, [viewer]);

  // A tile's zoom (the card's own button) opens the picture large; the viewer can pick it.
  const onImage = useCallback(
    (src: string, alt: string) => {
      const name = decodeURIComponent(src.split('/').pop() ?? '');
      const choice = question?.question.parsed.choices.find((c) => c.image?.src === name);
      const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const pickable = choice && openThread === TOUR_THREAD && !state.sent && state.step <= 3;
      setViewer({
        picture: {
          asset: tourFullPicture(fixture, name),
          name: choice ? `${choice.label.split(' · ')[0]}: ${name}` : name,
          caption: choice ? `${choice.label}${choice.description ? ` · ${choice.description.replace(/!\[[^\]]*\]\([^)]*\)\s*/g, '')}` : ''}` : alt,
          alt: alt || choice?.label || name,
          pick: pickable ? choice!.label : undefined,
        },
        opener,
      });
    },
    [fixture, question, openThread, state.sent, state.step],
  );

  const openPicture = useCallback((p: TourPicture, opener: HTMLElement) => setViewer({ picture: { asset: p.full ?? p.asset, name: p.name, caption: p.caption, alt: p.alt }, opener }), []);

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
      onOpen={(row) => dispatch({ type: 'open', thread: row.thread_id }, { focusCoach: true })}
      phone={phone}
    />
  );

  const pane = openThread ? (
    <TourThreadPane
      fixture={fixture}
      threadId={openThread}
      state={state}
      dispatch={dispatch}
      phone={phone}
      stacked={stacked.thread}
      withFile={state.mock}
      reduced={reduced}
      onImage={onImage}
      onOpenPicture={openPicture}
      say={say}
    />
  ) : null;

  const file = state.mock ? <TourFilePane phone={phone} stacked={stacked.file} onClose={() => dispatch({ type: 'closeMock' }, { focusCoach: false })} /> : null;

  let main: ReactNode;
  if (phone) main = file ?? pane ?? list;
  else if (file) main = stacked.file ? file : (
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
    <>
      {main}
      {viewer && (
        <TourViewer
          picture={viewer.picture}
          onClose={closeViewer}
          onPick={(label) => {
            setViewer(null);
            dispatch({ type: 'pick', label });
            say(`Picked ${label}. Press Send.`);
            // The pick lands on the card: focus goes to Send, the next thing to press.
            requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-tour-send]')?.focus());
          }}
        />
      )}
    </>
  );
}

function TourThreadPane({
  fixture,
  threadId,
  state,
  dispatch,
  phone,
  stacked,
  withFile,
  reduced,
  onImage,
  onOpenPicture,
  say,
}: {
  fixture: TourFixture;
  threadId: string;
  state: TourState;
  dispatch: TourMainProps['dispatch'];
  phone: boolean;
  stacked: boolean;
  withFile: boolean;
  reduced: boolean;
  onImage: (src: string, alt: string) => void;
  onOpenPicture: (p: TourPicture, opener: HTMLElement) => void;
  say: (text: string) => void;
}) {
  const thread = fixture.threads.find((t) => t.id === threadId)!;
  const tour = threadId === TOUR_THREAD;
  const views = useMemo(() => tourMessages(fixture, threadId, state), [fixture, threadId, state]);
  const wires = useMemo(() => views.map((v) => v.wire), [views]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const realAnswer = thread.real_answer ?? '';

  // Step 4: follow the thread's end as the replay arrives, the way the Inbox follows an arrival at the bottom.
  useEffect(() => {
    if (!tour || state.step !== 4 || !state.sent) return;
    const body = bodyRef.current;
    if (body) body.scrollTo({ top: body.scrollHeight, behavior: reduced ? 'auto' : 'smooth' });
  }, [tour, state.step, state.sent, state.delivered, state.arrived, reduced]);

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

  const pickedFoot = state.picked && !state.sent;
  const foot = !tour ? null : state.sent ? null : pickedFoot ? (
    <button
      type="button"
      className="ib-btn ib-pri"
      data-tour-send=""
      onClick={() => {
        dispatch({ type: 'send' }, { focusCoach: true });
        say('Sent. Sending to Claude Code.');
      }}
    >
      <Icon name="send" size={15} />
      Send
    </button>
  ) : null;

  const replayAt = views.findIndex((v) => v.replay);
  return (
    <section className={`ib-pane${withFile ? ' ib-withfile' : ''}`} aria-label={thread.subject} data-thread-id={thread.id} data-tour-thread="">
      <div className="ib-phead">
        {phone ? (
          <>
            {back}
            <span className="ib-sp" />
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
      <div className="ib-pbody" ref={bodyRef}>
        <h2 className="ib-subject" dir="auto" tabIndex={-1}>
          {thread.subject}
        </h2>
        {thread.slice && (
          <p className="ib-tour-slice">
            <Icon name="chevD" size={14} />
            {thread.slice}
          </p>
        )}
        {views.map((view, index) => {
          const m = view.wire;
          const fx = view.fixture;
          const isAgent = m.author.kind === 'agent';
          const asks = !!fx?.asks;
          const question = m.questions?.[0];
          const answers = new Map<string, QuestionAnswer>(question?.answer ? [[question.key, question.answer]] : []);
          const footerFor = (key: string) => {
            const q = m.questions?.find((x) => x.key === key);
            if (!q?.answer) return null;
            if (q.state === 'sent') return `Sent ${tour ? tourTime('12:17') : fx?.sent_at ? tourTime(fx.sent_at) : ''}`.trim();
            return 'Picked · in your draft';
          };
          const sentAnswers = view.reply || fx?.answers ? sentAnswersOf(m, wires, (asking) => `Claude Code’s message, ${tourTime(fixtureTime(fixture, asking.id))}`) : undefined;
          const arrival = view.replay ? fx?.replay : undefined;
          return (
            <div key={m.id}>
              {index === replayAt && (
                <div className="ib-tour-replay" role="note">
                  <Icon name="replay" size={14} />
                  Replay of the real thread: what Claude Code did next
                </div>
              )}
              <article
                className="ib-message"
                data-author={m.author.kind}
                data-tour-message={asks ? 'ask' : view.reply ? 'reply' : undefined}
                data-tour-arrival={arrival}
                data-arrived={arrival !== undefined && arrival === state.arrived ? '' : undefined}
              >
                <MessageHead
                  who={view.who}
                  host={isAgent ? 'claude-code' : null}
                  to={view.to}
                  time={view.time}
                  project={fixture.project}
                  replay={view.replay}
                />
                <div className="ib-msg">
                  {arrival === 1 && pickDiffers(state, realAnswer) && (
                    <p className="ib-tour-note" data-tour-differs="">
                      You picked {state.picked}. In the real thread the answer was {realAnswer.split(' · ')[0]}, so this is what Claude Code built.
                    </p>
                  )}
                  <MessageBody
                    message={m}
                    projectRoot=""
                    onOpenAttachment={noop}
                    readOnly={!isAgent || !tour || !asks || state.sent}
                    answers={answers}
                    onPick={(_key, answer) => {
                      const label = answer?.selected?.[0] ?? null;
                      dispatch({ type: 'pick', label });
                      if (label) say(`Picked ${label}. Press Send.`);
                    }}
                    footerFor={footerFor}
                    sentAnswers={sentAnswers}
                    imageBase={TOUR_IMAGE_BASE}
                    onImage={onImage}
                  />
                  {fx?.attachments && fx.attachments.length > 0 && (
                    <>
                      <div className="ib-tour-attach-h">
                        <Icon name="clip" size={14} />
                        Attached
                      </div>
                      {fx.attachments.map((a) =>
                        a.mock ? (
                          <button
                            key={a.name}
                            type="button"
                            className="ib-tour-filetile"
                            onClick={() => {
                              dispatch({ type: 'openMock' }, { focusCoach: true });
                              say(`${a.name} is open beside the thread.`);
                            }}
                            data-tour-mock-tile=""
                            aria-label={`Open ${a.name}, ${a.kind}, ${a.size}`}
                          >
                            <span className="ib-tft-i">
                              <Icon name="code" size={20} />
                            </span>
                            <span className="ib-tft-t">
                              <b>{a.name}</b>
                              <span>
                                {a.kind} · {a.size}
                              </span>
                            </span>
                            <span className="ib-tft-o">{state.mock ? 'Open beside' : 'Open'}</span>
                          </button>
                        ) : (
                          <span key={a.name} className="ib-tour-filetile ib-tour-filechip">
                            <span className="ib-tft-i">
                              <Icon name="doc" size={20} />
                            </span>
                            <span className="ib-tft-t">
                              <b>{a.name}</b>
                              <span>
                                {a.kind} · {a.size}
                              </span>
                            </span>
                          </span>
                        ),
                      )}
                    </>
                  )}
                  {fx?.gallery && fx.gallery.length > 0 && <Gallery pictures={fx.gallery} onOpen={onOpenPicture} />}
                  {view.reply && (
                    <div className="ib-delivered" data-delivery={state.delivered ? 'delivered' : 'sending'} data-tour-delivered="" tabIndex={-1}>
                      <span className="ib-dl-main">
                        <Icon name={state.delivered ? 'check' : 'send'} size={14} />
                        <span className="ib-dl-text">{state.delivered ? `Delivered to Claude Code, ${tourTime('12:17')}` : 'Sending to Claude Code…'}</span>
                      </span>
                      <span className="ib-tour-realtime">Replay</span>
                    </div>
                  )}
                  {fx?.delivered && (
                    <div className="ib-delivered" data-delivery="delivered">
                      <span className="ib-dl-main">
                        <Icon name="check" size={14} />
                        <span className="ib-dl-text">Delivered to Claude Code, {tourTime(fx.delivered)}</span>
                      </span>
                    </div>
                  )}
                </div>
              </article>
            </div>
          );
        })}
      </div>
      <div className="ib-pfoot">
        <div className="ib-acts ib-footrow" data-foot-row="">
          <div className="ib-footbtns" data-foot-buttons="">
            {foot ?? (
              <Tip content={tour && !state.sent ? 'In the tour, pick an answer above; Send replays it' : 'Replies are not part of the tour'}>
                <button type="button" className="ib-btn" aria-disabled="true" onClick={noop}>
                  <Icon name="reply" size={15} />
                  Reply
                </button>
              </Tip>
            )}
          </div>
          {pickedFoot && (
            <div className="ib-footstatus" data-foot-status="">
              <span className="ib-draft-foot">
                <span className="ib-draft-pill">Draft</span> <span className="ib-st">1 pick</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function fixtureTime(fixture: TourFixture, messageId: string): string {
  for (const t of fixture.threads) {
    const m: TourFixtureMessage | undefined = t.messages.find((x) => x.id === messageId);
    if (m) return m.time;
  }
  return '12:00';
}

/** prototype.html beside the thread: the real mockups Claude Code sent, live and sandboxed (no allow-same-origin). */
function TourFilePane({ phone, stacked, onClose }: { phone: boolean; stacked: boolean; onClose: () => void }) {
  const covers = phone || stacked;
  return (
    <section className="ib-tour-file" aria-label="prototype.html" data-tour-file="">
      <header>
        {covers && (
          <button type="button" className="ib-pback" onClick={onClose} aria-label="Back to the thread" data-tour-file-back="">
            <Icon name="chevL" size={18} />
            <span className="ib-pback-l">Thread</span>
          </button>
        )}
        <span className="ib-tf-n">prototype.html</span>
        <span className="ib-mut ib-tf-from">from Claude Code · {tourTime('12:03')} · runs here, sandboxed</span>
        <span className="ib-sp" />
        {!covers && (
          <Tip content="Close the file">
            <button type="button" className="ib-iconbtn" onClick={onClose} aria-label="Close the file">
              <Icon name="x" />
            </button>
          </Tip>
        )}
      </header>
      <iframe title="The VS Code mockups Claude Code sent" sandbox="allow-scripts" src={tourAssetUrl('vscode-mockups.html')} />
    </section>
  );
}

/** Where the tour's own screens are loading or could not load: Exit is in the bar above. */
export function TourLoading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  return (
    <section className="ib-listcol" aria-label="Tour">
      <div className="ib-lbody">
        <div className="ib-empty" data-tour-loading={error ? 'failed' : 'loading'} aria-busy={!error || undefined}>
          {error ? (
            <>
              <h2>The tour could not load</h2>
              <p className="ib-mut">{error}</p>
              <div>
                <button type="button" className="ib-btn" onClick={onRetry}>
                  Try again
                </button>
              </div>
            </>
          ) : (
            <h2>Loading the tour…</h2>
          )}
        </div>
      </div>
    </section>
  );
}

/** Reduced motion, read once and followed. */
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

export { TOUR_SIDE_THREAD, tourCanBack };
