/**
 * The Inbox's onboarding tour (approval "inbox-onboarding-tour"): a replay of
 * a real thread from building Plannotator with its own Inbox. Pure: the
 * fixture's shape, the tour's state machine, the coach card each state shows,
 * and the rows and messages the window's own components draw. Nothing here
 * touches the person's store: picks and Send write only to this state.
 *
 * Steps (BRIEF §2): 1 open the question, 2 pick a picture, 3 Send (a replay),
 * 4 watch the next messages arrive, 5 open the mock, 6 the person's own Inbox
 * (real: connect agents, first question, notifications).
 */
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import type { InboxListRow, InboxListSection, InboxMessageWire, InboxQuestion, InboxSectionId } from '@plannotator/core/inbox-types';
import { INBOX_SECTIONS } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { tourAssetLoaded, tourAssetUrl } from './assets';

export const TOUR_STEPS = 6;

/**
 * Step 6's prompt to copy (BRIEF §2, "Get your first question"): one real
 * question about the work at hand, with pictures when the choice is visual.
 * The first-run screen outside the tour keeps its own test message.
 */
export const TOUR_FIRST_QUESTION_PROMPT =
  'Send me one real question in my Plannotator Inbox about what we’re working on now. If the choice is visual, show the options as pictures: screenshots you already have, or a small HTML mock you attach. Then end your turn, and act on my answer when it comes back.';
export const TOUR_THREAD = 'tour-vscode';
export const TOUR_SIDE_THREAD = 'tour-graphite';
export const TOUR_PROJECT_ID = 'tour-project';

// ─────────────────────────── The fixture ───────────────────────────

export interface TourPicture {
  asset: string;
  /** A larger version the viewer shows (the tile shows `asset`). */
  full?: string;
  name: string;
  caption: string;
  alt: string;
}

export interface TourFileRef {
  name: string;
  kind: string;
  size: string;
  /** The asset that opens beside the thread (the clickable mock); absent: a file named, not opened. */
  mock?: string;
}

export interface TourFixtureMessage {
  id: string;
  who: 'developer' | 'agent';
  /** The real time, `HH:MM` on the 24-hour clock, in the developer's day. */
  time: string;
  body?: string;
  /** The message carries the question the tour turns on. */
  asks?: boolean;
  /** 1 or 2: a message the tour replays after Send. */
  replay?: number;
  attachments?: TourFileRef[];
  gallery?: TourPicture[];
  /** A finished thread's question: the label the developer sent, and when. */
  answer?: string;
  sent_at?: string;
  /** A developer's reply that sent the answers of this message. */
  answers?: string;
  delivered?: string;
}

export interface TourFixtureThread {
  id: string;
  subject: string;
  thread_name: string | null;
  slice?: string;
  real_answer?: string;
  /** The label over each of its picture choices (the brief's guard: a picture is plainly a picture), and a phone's shorter one. */
  picture_label?: string;
  picture_label_short?: string;
  messages: TourFixtureMessage[];
}

export interface TourFixture {
  v: number;
  date: string;
  project: string;
  developer: string;
  /** A tile's thumbnail → the larger picture the viewer shows. */
  full: Record<string, string>;
  threads: TourFixtureThread[];
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ASSET_RE = /^[a-z0-9][a-z0-9.-]*\.(webp|html)$/;

/** The fixture as the server serves it, checked: anything else is refused (the tour is then not offered on this load). */
export function parseTourFixture(input: unknown): TourFixture {
  const fail = (why: string): never => {
    throw new Error(`The tour's content is not readable: ${why}.`);
  };
  if (!input || typeof input !== 'object') fail('not an object');
  const f = input as Record<string, unknown>;
  if (f.v !== 1) fail('an unknown version');
  if (typeof f.project !== 'string' || typeof f.developer !== 'string' || typeof f.date !== 'string') fail('no project, developer or date');
  if (!Array.isArray(f.threads)) fail('no threads');
  const threads = (f.threads as unknown[]).map((t) => {
    const thread = t as TourFixtureThread;
    if (!thread || typeof thread.id !== 'string' || typeof thread.subject !== 'string' || !Array.isArray(thread.messages)) fail('a thread without id, subject or messages');
    for (const m of thread.messages) {
      if (typeof m.id !== 'string' || (m.who !== 'developer' && m.who !== 'agent') || !TIME_RE.test(m.time)) fail(`a message without id, author or time (${String(m.id)})`);
      for (const p of m.gallery ?? []) if (!ASSET_RE.test(p.asset) || (p.full && !ASSET_RE.test(p.full))) fail(`a picture that is not a tour asset (${p.asset})`);
      for (const a of m.attachments ?? []) if (a.mock && !ASSET_RE.test(a.mock)) fail(`a mock that is not a tour asset (${a.mock})`);
    }
    return thread;
  });
  if (!threads.some((t) => t.id === TOUR_THREAD)) fail('no tour thread');
  const full: Record<string, string> = {};
  if (f.full && typeof f.full === 'object') {
    for (const [k, v] of Object.entries(f.full as Record<string, unknown>)) if (ASSET_RE.test(k) && typeof v === 'string' && ASSET_RE.test(v)) full[k] = v;
  }
  return { v: 1, date: f.date as string, project: f.project as string, developer: f.developer as string, full, threads };
}

/** "12:03 PM" from the fixture's `12:03`: the real time as it was read then, whatever the reader's clock. */
export function tourTime(time: string): string {
  const m = TIME_RE.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * An ISO time on the reader's own day at the fixture's wall-clock time, so a
 * list row reads "12:03 PM" as the thread does (the window's list prints
 * today's times as times).
 */
export function tourIso(time: string, now: Date = new Date()): string {
  const m = TIME_RE.exec(time);
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), m ? Number(m[1]) : 12, m ? Number(m[2]) : 0);
  return d.toISOString();
}

// ─────────────────────────── The state machine ───────────────────────────

export type TourRoute = 'list' | typeof TOUR_THREAD | typeof TOUR_SIDE_THREAD;

export interface TourState {
  /** 1 to 6. */
  step: number;
  /** What the tour Inbox shows (steps 1 to 5): its list, or one of its two threads. */
  route: TourRoute;
  /**
   * What the tour question's draft answers (until Send): a choice's label, the
   * person's own words (`“…”`, Other), or `Skipped`; null while nothing is
   * answered yet (a note alone stays in `answer`).
   */
  picked: string | null;
  /** The card's answer as the person left it (Other's words, a note, a skip), when it is more than a picked label. */
  answer: QuestionAnswer | null;
  sent: boolean;
  delivered: boolean;
  /** How many replayed messages have arrived (0, 1, 2). */
  arrived: number;
  /** prototype.html is open beside the thread. */
  mock: boolean;
  /** The tour thread was opened (its row is no longer bold until something new lands). */
  looked: boolean;
}

export const TOUR_START: TourState = { step: 1, route: 'list', picked: null, answer: null, sent: false, delivered: false, arrived: 0, mock: false, looked: false };

/** A step read from the address (`#tour=…`): a whole number from 1 to 6, anything else (empty, 0, `abc`, 99, 2.5) the nearest of them, 1 when none. */
export function tourStepOf(raw: string | null | undefined): number {
  const n = Math.trunc(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, TOUR_STEPS);
}

/** What the card's skip records as the pick. */
export const TOUR_SKIPPED = 'Skipped';

/** The pick an answer on the tour card makes: a choice's label, the person's own words, or a skip; null for nothing yet (a note alone). */
export function tourPickOf(answer: QuestionAnswer | null | undefined): string | null {
  if (!answer) return null;
  const label = answer.selected?.[0];
  if (label) return label;
  const other = answer.other?.trim();
  if (other) return `“${other}”`;
  if (answer.skipped) return TOUR_SKIPPED;
  return null;
}

/** The replay's honest note starts with what the person did: "You picked B · …", "You answered “…”", "You skipped it". */
export function tourPickWords(picked: string): string {
  if (picked === TOUR_SKIPPED) return 'You skipped it';
  if (picked.startsWith('“')) return `You answered ${picked}`;
  return `You picked ${picked}`;
}

export type TourAction =
  | { type: 'open'; thread: string }
  | { type: 'list' }
  /** `answer`: the card's whole answer (Other's words, a note, a skip); absent for a label picked elsewhere (the viewer). */
  | { type: 'pick'; label: string | null; answer?: QuestionAnswer | null }
  | { type: 'send' }
  | { type: 'delivered' }
  | { type: 'arrive' }
  | { type: 'next' }
  | { type: 'back' }
  | { type: 'openMock' }
  | { type: 'closeMock' }
  | { type: 'goto'; step: number; realAnswer: string };

/** The state the tour is in at a step reached directly (`#tour=N`, a reload): as the walk would leave it, with the real answer picked. */
export function tourStateAt(step: number, realAnswer: string): TourState {
  const s = Math.min(Math.max(Math.trunc(step) || 1, 1), TOUR_STEPS);
  if (s === 1) return TOUR_START;
  if (s === 2) return { ...TOUR_START, step: 2, route: TOUR_THREAD, looked: true };
  if (s === 3) return { ...TOUR_START, step: 3, route: TOUR_THREAD, looked: true, picked: realAnswer };
  const done = { ...TOUR_START, route: TOUR_THREAD as TourRoute, looked: true, picked: realAnswer, sent: true, delivered: true, arrived: 2 };
  return { ...done, step: s };
}

export function tourReducer(state: TourState, action: TourAction): TourState {
  switch (action.type) {
    case 'goto':
      return tourStateAt(action.step, action.realAnswer);
    case 'open': {
      if (state.step === 6) return state;
      if (action.thread === TOUR_SIDE_THREAD) return { ...state, route: TOUR_SIDE_THREAD, mock: false };
      if (action.thread !== TOUR_THREAD) return state;
      const step = state.step === 1 ? 2 : state.step;
      return { ...state, route: TOUR_THREAD, step, looked: true };
    }
    case 'list':
      return state.step === 6 ? state : { ...state, route: 'list', mock: false };
    case 'pick': {
      if (state.sent || state.route !== TOUR_THREAD || state.step > 3) return state;
      // A label picked in the viewer keeps a note written on the card.
      const answer =
        action.answer !== undefined
          ? action.answer
          : action.label && state.answer?.note
            ? { ...state.answer, selected: [action.label], other: undefined, skipped: undefined }
            : null;
      const picked = action.answer !== undefined ? tourPickOf(action.answer) : action.label;
      if (picked === null) return { ...state, picked: null, answer, step: 2 };
      return { ...state, picked, answer, step: 3 };
    }
    case 'send':
      if (state.sent || !state.picked || state.step !== 3) return state;
      return { ...state, sent: true, step: 4, delivered: false, arrived: 0 };
    case 'delivered':
      return state.sent ? { ...state, delivered: true } : state;
    case 'arrive':
      return state.delivered && state.arrived < 2 ? { ...state, arrived: state.arrived + 1 } : state;
    case 'next':
      if (state.step === 4 && state.arrived >= 2) return { ...state, step: 5, route: TOUR_THREAD, mock: false };
      if (state.step === 5 && state.mock) return { ...state, step: 6, mock: false };
      return state;
    case 'back':
      if (state.step === 5) return { ...state, step: 4, route: TOUR_THREAD, mock: false };
      // Step 4 has no Back: the answer was sent.
      if (state.step === 3) return { ...state, step: 2, route: TOUR_THREAD };
      if (state.step === 2) return { ...state, step: 1, route: 'list' };
      return state;
    case 'openMock':
      return state.step === 6 ? state : { ...state, mock: true, route: TOUR_THREAD };
    case 'closeMock':
      return { ...state, mock: false };
  }
}

/** Back is offered on steps 2, 3 and 5; step 4 has none (the answer was sent), step 1 has nothing before it. */
export function tourCanBack(state: TourState): boolean {
  return state.step === 2 || state.step === 3 || state.step === 5;
}

/** The replay's timings in ms after Send: delivered, the first message, the second. A little shorter under reduced motion. */
export function replayTimings(reduced: boolean): { delivered: number; first: number; second: number } {
  return reduced ? { delivered: 600, first: 2000, second: 3800 } : { delivered: 1100, first: 3000, second: 5600 };
}

/** The person's pick is not the real thread's answer: the replay says so (choice 2: it never pretends the agent obeyed). */
export function pickDiffers(state: TourState, realAnswer: string): boolean {
  return state.picked !== null && state.picked !== realAnswer;
}

// ─────────────────────────── The coach ───────────────────────────

/** What a coach card points at; the window resolves it to an element. */
export type TourTarget = 'row' | 'choices' | 'send' | 'delivered' | 'arrival' | 'mock-tile' | 'file';

export interface TourCoach {
  /** Stable per card: a change moves focus to the new title and says it in the live region. */
  key: string;
  title: string;
  /** At most two sentences. */
  text: string;
  /** The action, in bold after the text. */
  action?: string;
  /** A Next button; absent: the step advances on the real action. */
  next?: boolean;
  /** The replay is running: "Replaying…" in place of the action. */
  wait?: boolean;
  target: TourTarget | null;
}

/**
 * What the tour is drawing in place of a piece that is not here, so the coach
 * says only what is on screen, and always as what it shows, never as a
 * failure (the owner: the tour is all positive): the pictures (the card names
 * its choices in words), the mock (`still`: a still picture of it; `none`:
 * the coach describes it).
 */
export interface TourDegraded {
  pictures?: boolean;
  mock?: 'still' | 'none' | null;
}

/** The coach card a state shows (steps 1 to 5; step 6 is the person's own screen and has none). */
export function tourCoach(state: TourState, names: { developer: string; agent: string }, degraded: TourDegraded = {}): TourCoach | null {
  const { developer, agent } = names;
  if (state.step === 6) return null;
  const inThread = state.route === TOUR_THREAD;
  if (state.step === 1)
    return {
      key: '1',
      title: 'An agent came back with a question',
      text: `${developer} asked ${agent} to rethink a VS Code feature, then went back to other work.`,
      action: 'Open the question it came back with.',
      target: 'row',
    };
  // Left the thread mid-step: the way back to it.
  if (!inThread && !state.mock)
    return { key: `back-${state.step}`, title: 'The question is in this thread', text: 'The tour goes on where you left it.', action: 'Open it again.', target: 'row' };
  if (state.step === 2 && degraded.pictures)
    return {
      key: '2',
      title: 'Pick a direction',
      text: `These are ${agent}’s four directions for the VS Code guide, each named on the card.`,
      action: 'Pick the direction you would build.',
      target: 'choices',
    };
  if (state.step === 2)
    return {
      key: '2',
      title: 'The choices are pictures',
      text: `They are ${agent}’s mockups of VS Code; the magnifier looks closer.`,
      action: 'Pick the direction you would build.',
      target: 'choices',
    };
  if (state.step === 3)
    return {
      key: '3',
      title: 'Send it back',
      text: `In the real thread, this went straight back into the ${agent} session that asked.`,
      action: 'Press Send to replay it.',
      target: 'send',
    };
  if (state.step === 4) {
    if (state.arrived < 2)
      return {
        key: state.delivered ? '4-delivered' : '4-sending',
        title: state.delivered ? 'Delivered. Now watch.' : 'Sending…',
        text: 'In the real thread, the session that asked had the answer now.',
        wait: true,
        target: state.delivered ? 'delivered' : null,
      };
    return {
      key: '4-works',
      title: 'And it keeps working',
      text: `It took the answer and built it; PR #2134 came an hour later in the real thread. That’s the Inbox: it asks, you answer when you can, it goes on.`,
      next: true,
      target: 'arrival',
    };
  }
  if (state.step === 5 && !state.mock)
    return {
      key: '5',
      title: 'One more: the mock behind the pictures',
      text: 'The question came with a clickable prototype of all four directions.',
      action: 'Open prototype.html.',
      target: 'mock-tile',
    };
  if (degraded.mock)
    return {
      key: '5-mock',
      title: 'The mock behind the pictures',
      text:
        degraded.mock === 'still'
          ? `Direction A as ${agent} mocked it in VS Code: our guide reader in one tab, chapters beside their diffs. Go on when you like.`
          : `prototype.html is one VS Code window with all four directions to click through, the same ones the question showed. Go on when you like.`,
      next: true,
      target: 'file',
    };
  return {
    key: '5-mock',
    title: 'It runs right here',
    text: `${agent}’s VS Code mockups, live and sandboxed. Switch between its directions, then go on.`,
    next: true,
    target: 'file',
  };
}

/** The coach card as one sentence for the live region. */
export function tourCoachSpeech(coach: TourCoach, step: number): string {
  return `Step ${step} of ${TOUR_STEPS}. ${coach.title}. ${coach.text}${coach.action ? ` ${coach.action}` : ''}`;
}

// ─────────────────────────── What the window draws ───────────────────────────

const AGENT = { kind: 'agent' as const, host: 'claude-code', session: null, name: null };
const PERSON = { kind: 'person' as const };

/** The person's reply in the tour (never stored anywhere). */
export const TOUR_REPLY_ID = 'tour-vscode-reply';
const REPLY_TIME = '12:17';

function threadOf(fixture: TourFixture, id: string): TourFixtureThread | undefined {
  return fixture.threads.find((t) => t.id === id);
}

/** The tour thread's question, as core's parser reads it (the same parse the store makes). */
export function tourQuestion(fixture: TourFixture) {
  const asking = threadOf(fixture, TOUR_THREAD)?.messages.find((m) => m.asks);
  const [q] = parseInboxQuestionBlocks(asking?.body ?? '');
  return asking && q ? { message: asking, question: q } : null;
}

function wireQuestion(message: TourFixtureMessage, parsed: ReturnType<typeof parseInboxQuestionBlocks>[number], answer: QuestionAnswer | null, state: 'open' | 'picked' | 'sent', sentReply: string | null, at: string | null): InboxQuestion {
  return {
    key: parsed.key,
    position: parsed.position,
    kind: parsed.kind,
    prompt: parsed.prompt,
    context: parsed.parsed.context,
    choices: parsed.parsed.choices.map((c) => ({ label: c.label, description: c.description, recommended: c.recommended, settled: c.settled })) as InboxQuestion['choices'],
    recommendation: parsed.parsed.recommendation,
    suggested_text: parsed.parsed.suggested_text,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state,
    answer,
    revision: answer ? 1 : 0,
    sent_revision: state === 'sent' ? 1 : 0,
    picked_by: null,
    picked_at: at,
    sent_reply_id: sentReply,
    message_id: message.id,
    superseded_by: null,
  };
}

/** The answer the card shows for a label picked in the tour. */
export function tourAnswer(label: string, key: string, prompt: string): QuestionAnswer {
  return { v: 1, key, kind: 'single', prompt, selected: [label] };
}

function wireMessage(fixture: TourFixture, thread: TourFixtureThread, m: TourFixtureMessage, now: Date, questions?: InboxQuestion[]): InboxMessageWire {
  return {
    id: m.id,
    project_id: TOUR_PROJECT_ID,
    thread_id: thread.id,
    reply_to: null,
    author: m.who === 'agent' ? AGENT : PERSON,
    subject: thread.subject,
    body: m.answers ? `Answered ${questionCount(fixture, thread, m.answers)} question.` : (m.body ?? ''),
    created_at: tourIso(m.time, now),
    resolved_at: null,
    idempotency_key: null,
    thread_name: thread.thread_name,
    questions: questions ?? [],
  };
}

function questionCount(_fixture: TourFixture, thread: TourFixtureThread, messageId: string): number {
  const m = thread.messages.find((x) => x.id === messageId);
  return parseInboxQuestionBlocks(m?.body ?? '').length;
}

export interface TourMessageView {
  wire: InboxMessageWire;
  /** The display time ("12:03 PM"). */
  time: string;
  who: string;
  to: string;
  fixture: TourFixtureMessage | null;
  /** Part of the replay after Send: drawn under the replay divider, tagged Replay. */
  replay: boolean;
  /** The person's own replayed reply. */
  reply: boolean;
}

/** The messages a thread shows in this state, in order, each in the store's wire shape. */
export function tourMessages(fixture: TourFixture, threadId: string, state: TourState, now: Date = new Date()): TourMessageView[] {
  const thread = threadOf(fixture, threadId);
  if (!thread) return [];
  const developer = fixture.developer;
  const out: TourMessageView[] = [];
  for (const m of thread.messages) {
    if (m.replay && (thread.id !== TOUR_THREAD || state.arrived < m.replay)) continue;
    let questions: InboxQuestion[] | undefined;
    const parsed = m.body ? parseInboxQuestionBlocks(m.body) : [];
    if (parsed.length > 0) {
      if (thread.id === TOUR_THREAD) {
        const p = parsed[0]!;
        const answer = state.answer ? { ...state.answer, key: p.key, prompt: p.prompt } : state.picked ? tourAnswer(state.picked, p.key, p.prompt) : null;
        questions = [wireQuestion(m, p, answer, state.sent ? 'sent' : answer ? 'picked' : 'open', state.sent ? TOUR_REPLY_ID : null, answer ? tourIso(REPLY_TIME, now) : null)];
      } else {
        const reply = thread.messages.find((x) => x.answers === m.id);
        questions = parsed.map((p) => wireQuestion(m, p, m.answer ? tourAnswer(m.answer, p.key, p.prompt) : null, m.answer ? 'sent' : 'open', reply?.id ?? null, m.sent_at ? tourIso(m.sent_at, now) : null));
      }
    }
    const who = m.who === 'agent' ? 'Claude Code' : developer;
    const to = m.who === 'agent' ? `to ${m.replay ? 'you' : developer}` : 'to Claude Code';
    out.push({ wire: wireMessage(fixture, thread, m, now, questions), time: tourTime(m.time), who, to, fixture: m, replay: !!m.replay, reply: false });
    // The person's replayed reply follows the question it answers.
    if (thread.id === TOUR_THREAD && m.asks && state.sent && state.picked) {
      const reply: InboxMessageWire = {
        id: TOUR_REPLY_ID,
        project_id: TOUR_PROJECT_ID,
        thread_id: thread.id,
        reply_to: m.id,
        author: PERSON,
        subject: thread.subject,
        body: state.picked === TOUR_SKIPPED ? 'Skipped 1 question.' : 'Answered 1 question.',
        created_at: tourIso(REPLY_TIME, now),
        resolved_at: null,
        idempotency_key: null,
        questions: [],
      };
      out.push({ wire: reply, time: tourTime(REPLY_TIME), who: 'You', to: 'to Claude Code', fixture: null, replay: false, reply: true });
    }
  }
  return out;
}

function row(fixture: TourFixture, thread: TourFixtureThread, state: TourState, section: InboxSectionId, now: Date): InboxListRow {
  const shown = thread.messages.filter((m) => !(m.replay && (thread.id !== TOUR_THREAD || state.arrived < m.replay)));
  const first = shown[0]!;
  const last = shown[shown.length - 1]!;
  const lastAt = thread.id === TOUR_THREAD && state.sent && state.arrived === 0 ? tourIso(REPLY_TIME, now) : tourIso(last.time, now);
  const asks = thread.id === TOUR_THREAD && !state.sent;
  const opened = thread.id === TOUR_THREAD ? state.route === TOUR_THREAD : state.route === TOUR_SIDE_THREAD;
  const unread = section !== 'sent' && !opened && !(thread.id === TOUR_THREAD && state.looked && state.arrived === 0);
  return {
    thread_id: thread.id,
    project_id: TOUR_PROJECT_ID,
    project: { id: TOUR_PROJECT_ID, name: fixture.project },
    subject: thread.subject,
    thread_name: thread.thread_name,
    author: AGENT,
    created_at: tourIso(first.time, now),
    last_at: lastAt,
    last_author: thread.id === TOUR_THREAD && state.sent && state.arrived === 0 ? 'person' : 'agent',
    message_count: shown.length + (thread.id === TOUR_THREAD && state.sent ? 1 : 0),
    resolved_at: null,
    questions: { open: asks && !state.picked ? 1 : 0, picked: asks && state.picked ? 1 : 0, stopped: false, holds_up: [], prompt: null },
    waiting_on_person: section === 'waiting',
    section,
    unread,
    answered_not_sent: asks && !!state.picked,
    unsent: asks && state.picked ? { reply_at: null, picks: 1, comments: 0 } : null,
    waiting_since: null,
    unseen: unread ? 1 : 0,
    sent: section === 'sent' ? { at: tourIso(REPLY_TIME, now), checked_at: state.delivered ? tourIso(REPLY_TIME, now) : null } : null,
    guide: false,
  } as InboxListRow;
}

/** The tour Inbox's list in this state: the window's sections, the tour thread and the finished side thread. */
export function tourSections(fixture: TourFixture, state: TourState, now: Date = new Date()): InboxListSection[] {
  const placed: Partial<Record<InboxSectionId, InboxListRow[]>> = {};
  const add = (section: InboxSectionId, r: InboxListRow) => (placed[section] ??= []).push(r);
  const tour = threadOf(fixture, TOUR_THREAD);
  if (tour) {
    const section: InboxSectionId = state.sent ? (state.arrived > 0 ? 'new' : 'sent') : 'waiting';
    add(section, row(fixture, tour, state, section, now));
  }
  const side = threadOf(fixture, TOUR_SIDE_THREAD);
  if (side) add('new', row(fixture, side, state, 'new', now));
  return INBOX_SECTIONS.map((s) => ({ id: s.id, label: s.label, threads: placed[s.id] ?? [] }));
}

/** The sidebar's count for the tour project: threads waiting on the person. */
export function tourWaitingCount(state: TourState): number {
  return state.sent ? 0 : 1;
}

/** The URL a tour asset loads from: in memory once the tour loaded it, else the read-only asset route (assets.ts). */
export { tourAssetUrl };

/**
 * The larger picture the viewer shows for a tile's thumbnail (the fixture's `full` map), else the thumbnail
 * itself: also when the larger one is not in memory and the thumbnail is.
 */
export function tourFullPicture(fixture: TourFixture, name: string): string {
  const full = fixture.full[name];
  if (!full) return name;
  return !tourAssetLoaded(full) && tourAssetLoaded(name) ? name : full;
}
