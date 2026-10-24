/**
 * Decision mode's queue (approval "inbox-decision-mode", direction A "Queue";
 * experimental). Pure: the queue's state lives in the window only (brief §10:
 * no new storage), built from `GET /api/inbox/decisions` and kept as the
 * person walks it. Picks go through the existing picks route; a session's
 * reply goes through the existing reply route, one per agent session per
 * thread (`sendTargetsOf`), once its last decision there is handled.
 */
import type { InboxDecision, InboxListRow, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind, inboxAgentName } from '@plannotator/core/inbox-types';
import { capQuestionPrompt, type QuestionAnswer } from '@plannotator/core/question-block';
import { sendTargetsOf, type SendTarget } from '../sendTargets';

/** Why a decision left the projection while the queue held it. */
export type DecisionGone = 'sent' | 'replaced' | 'closed';

export interface QueueState {
  /** Every decision this sitting has met, in queue order (new ones join at the end). */
  order: string[];
  /** The last known copy of each. */
  cache: Map<string, InboxDecision>;
  /** The ones that left the projection, and why. */
  gone: Map<string, DecisionGone>;
  /** Put off with Later: walked once everything else is handled. */
  later: Set<string>;
  /** The card on screen; null on the end screen. */
  current: string | null;
}

export function emptyQueue(): QueueState {
  return { order: [], cache: new Map(), gone: new Map(), later: new Set(), current: null };
}

/** The send group: one reply per agent session per thread (server's `inboxDecisionGroupKey`). */
export function groupKeyOf(decision: Pick<InboxDecision, 'session' | 'thread'>): string {
  return `${decision.session.key}\u0001${decision.thread.id}`;
}

/** An agent message's session key, as the projection writes it (`s:<host>\0<session>`, or `m:<message id>`). */
export function sessionKeyOfMessage(message: InboxMessageWire): string {
  if (message.author.kind !== 'agent' || !message.author.session) return `m:${message.id}`;
  return `s:${message.author.host ?? ''}\u0000${message.author.session}`;
}

/** An action item (its Done and Can't do it go through the actions route, not a reply). */
export function isActionDecision(decision: InboxDecision): boolean {
  return readInboxQuestionKind(decision.question.kind) === 'action';
}

/** Handled: answered (picked, skipped), marked done, or no longer waiting at all. */
export function isHandled(state: QueueState, id: string): boolean {
  if (state.gone.has(id)) return true;
  const decision = state.cache.get(id);
  return decision !== undefined && decision.question.state !== 'open';
}

/**
 * Fold a fresh projection into the queue: copies refreshed, new decisions
 * appended in the server's order (the queue never reorders under the
 * person), and the ones that left marked gone. `sentGroups`: the groups this
 * sitting sent, so a decision that left with its group's reply reads as sent.
 */
export function mergeDecisions(
  state: QueueState,
  decisions: readonly InboxDecision[],
  sentGroups: ReadonlySet<string> = new Set(),
  /** Decisions with a pick on its way: the copy on screen is newer than any read that crossed it. */
  pending: ReadonlySet<string> = new Set(),
): QueueState {
  const cache = new Map(state.cache);
  const order = [...state.order];
  const known = new Set(order);
  const fresh = new Set<string>();
  for (const decision of decisions) {
    fresh.add(decision.id);
    const held = cache.get(decision.id);
    // A read older than what the window already saved (a lower revision, or a pick still on its way) never undoes it.
    const stale = held !== undefined && (pending.has(decision.id) || held.question.revision > decision.question.revision);
    cache.set(decision.id, stale ? { ...decision, question: held.question } : decision);
    if (!known.has(decision.id)) {
      order.push(decision.id);
      known.add(decision.id);
    }
  }
  const gone = new Map(state.gone);
  for (const id of order) {
    if (fresh.has(id)) {
      gone.delete(id);
      continue;
    }
    if (gone.has(id)) continue;
    const decision = cache.get(id);
    gone.set(id, decision && sentGroups.has(groupKeyOf(decision)) ? 'sent' : 'closed');
  }
  const later = new Set([...state.later].filter((id) => fresh.has(id) && cache.get(id)?.question.state === 'open'));
  const next: QueueState = { order, cache, gone, later, current: state.current };
  if (next.current === null || !known.has(next.current)) next.current = nextId(next, null);
  return next;
}

/** The decision a replaced one gives way to (its `superseded_by`), when the queue knows it. */
export function replacementOf(question: Pick<InboxQuestion, 'superseded_by'>): string | null {
  const by = question.superseded_by;
  return by && by.key ? `${by.message_id}/${by.key}` : null;
}

/**
 * A question line said the agent replaced or withdrew one of the queue's
 * decisions: it is marked replaced, and its replacement (once the projection
 * brings it) takes its place in the order, right after it.
 */
export function markReplaced(state: QueueState, question: InboxQuestion): QueueState {
  const id = `${question.message_id}/${question.key}`;
  if (!state.order.includes(id)) return state;
  const gone = new Map(state.gone).set(id, 'replaced');
  const cache = new Map(state.cache);
  const old = cache.get(id);
  if (old) cache.set(id, { ...old, question: { ...old.question, ...question } });
  return { ...state, gone, cache, later: new Set([...state.later].filter((l) => l !== id)) };
}

/** Put a replacement right after the decision it replaces (it may have joined at the end). */
export function placeAfter(state: QueueState, id: string, after: string): QueueState {
  if (!state.order.includes(id) || !state.order.includes(after) || id === after) return state;
  const order = state.order.filter((o) => o !== id);
  order.splice(order.indexOf(after) + 1, 0, id);
  return { ...state, order };
}

/**
 * The next card: the first decision after `from` that waits and is not put
 * off, then from the top, then the ones put off with Later; null when
 * nothing waits (the end screen).
 */
export function nextId(state: QueueState, from: string | null): string | null {
  const waiting = (id: string) => !isHandled(state, id);
  const start = from === null ? -1 : state.order.indexOf(from);
  const after = state.order.slice(start + 1).concat(state.order.slice(0, start + 1));
  return after.find((id) => waiting(id) && !state.later.has(id)) ?? after.find((id) => waiting(id)) ?? null;
}

/** Previous: the card before this one in the queue, handled or not, that is still a decision (not replaced or closed). */
export function previousId(state: QueueState, from: string | null): string | null {
  const index = from === null ? state.order.length : state.order.indexOf(from);
  for (let i = index - 1; i >= 0; i -= 1) {
    const id = state.order[i]!;
    const reason = state.gone.get(id);
    if (reason === 'replaced' || reason === 'closed') continue;
    return id;
  }
  return null;
}

/** Later: the decision moves to the end of the queue, and the next card shows. */
export function putOff(state: QueueState, id: string): QueueState {
  const order = [...state.order.filter((o) => o !== id), id];
  const later = new Set(state.later).add(id);
  const next = { ...state, order, later };
  return { ...next, current: nextId(next, id) };
}

/** Decisions still waiting (the "N left" in the head). */
export function leftCount(state: QueueState): number {
  return state.order.filter((id) => !isHandled(state, id)).length;
}

/** The decisions of one send group, in queue order. */
export function groupIds(state: QueueState, key: string): string[] {
  return state.order.filter((id) => {
    const decision = state.cache.get(id);
    return decision !== undefined && groupKeyOf(decision) === key;
  });
}

/**
 * Whether a group's reply can go: every decision in it is handled (none put
 * off with Later and still open), and at least one question there is picked
 * and not sent (a group of action items alone sends nothing: the actions route
 * sends those by itself after its own Undo window).
 */
export function groupReady(state: QueueState, key: string): boolean {
  const ids = groupIds(state, key);
  if (ids.length === 0) return false;
  if (!ids.every((id) => isHandled(state, id))) return false;
  return ids.some((id) => {
    const decision = state.cache.get(id)!;
    return !state.gone.has(id) && !isActionDecision(decision) && decision.question.state === 'picked';
  });
}

/** Some of a group answered, the rest not: closing then asks "Send what you answered / Keep as a draft". */
export function groupHalfAnswered(state: QueueState, key: string): boolean {
  const ids = groupIds(state, key);
  const picked = ids.some((id) => !state.gone.has(id) && state.cache.get(id)!.question.state === 'picked' && !isActionDecision(state.cache.get(id)!));
  return picked && !groupReady(state, key);
}

/** Every send group the queue has met, in queue order. */
export function groupKeys(state: QueueState): string[] {
  const out: string[] = [];
  for (const id of state.order) {
    const decision = state.cache.get(id);
    if (!decision) continue;
    const key = groupKeyOf(decision);
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * The replies a group's Send makes: the thread's own Send targets
 * (`sendTargetsOf`, one per session; approval "inbox-explicit-skip"), kept to
 * this group's session and to the ones that carry an answer. Words, files
 * and comments wait for the thread's own Send.
 */
export function groupSendTargets(thread: InboxThread, sessionKey: string): SendTarget[] {
  return sendTargetsOf(thread).filter((t) => sessionKeyOfMessage(t.message) === sessionKey && (t.questions.length > 0 || t.skip.length > 0));
}

// ─────────────────────────────── Chips ───────────────────────────────

/** Where a group's reply is. */
export type GroupSend =
  | { kind: 'waiting' }
  | { kind: 'hold'; until: number }
  | { kind: 'held' }
  | { kind: 'sending' }
  | { kind: 'sent'; at: string }
  | { kind: 'failed'; error: string };

/** After a Send: Delivered, then working, then Replied (brief §4), from the list row and the connection. */
export type AfterSend = 'sending' | 'queued' | 'saved' | 'undelivered' | 'delivered' | 'working' | 'replied';

/**
 * Where a sent reply is, from the row's own delivery (the same rule the
 * thread's delivery line runs): Queued for a busy agent, Saved for one that
 * only reads the thread, Delivered (or read), then Working while the agent's
 * connection says it is busy, then Replied once the agent wrote again.
 */
export function afterSendOf(row: InboxListRow | undefined, sentAt: string, busy: boolean | null): AfterSend {
  if (row && row.last_author === 'agent' && row.last_agent_at !== null && row.last_agent_at !== undefined && row.last_agent_at > sentAt) return 'replied';
  const state = row?.delivery?.state;
  const delivered = state === 'delivered' || (row?.sent?.checked_at ?? null) !== null;
  if (delivered) return busy ? 'working' : 'delivered';
  if (state === 'queued' || state === 'saved' || state === 'undelivered') return state;
  return 'sending';
}

export const AFTER_SEND_ORDER: readonly AfterSend[] = ['sending', 'undelivered', 'queued', 'saved', 'delivered', 'working', 'replied'];

export const AFTER_SEND_WORDS: Record<AfterSend, string> = {
  sending: 'Sending',
  queued: 'Queued',
  saved: 'Saved',
  undelivered: 'Not delivered',
  delivered: 'Delivered',
  working: 'Working',
  replied: 'Replied',
};

/** A session key as an attribute value (the key holds a NUL between host and session). */
export function chipDomKey(key: string): string {
  return key.replace('\u0000', ':');
}

/** One chip of the progress strip: an agent session, a dot per decision. */
export interface SessionChip {
  key: string;
  host: string | null;
  name: string;
  /** The project, or the projects, its decisions are in. */
  label: string;
  dots: { id: string; state: 'done' | 'current' | 'open' | 'later' }[];
  groups: string[];
}

export function sessionChips(state: QueueState): SessionChip[] {
  const chips = new Map<string, SessionChip>();
  for (const id of state.order) {
    const decision = state.cache.get(id);
    if (!decision) continue;
    const reason = state.gone.get(id);
    if (reason === 'replaced' || reason === 'closed') continue;
    const key = decision.session.key;
    const chip =
      chips.get(key) ??
      ({
        key,
        host: decision.session.host,
        name: inboxAgentName(decision.message.author),
        label: decision.thread.project.name,
        dots: [],
        groups: [],
      } satisfies SessionChip);
    if (!chip.label.split(' · ').includes(decision.thread.project.name)) chip.label = `${chip.label} · ${decision.thread.project.name}`;
    const group = groupKeyOf(decision);
    if (!chip.groups.includes(group)) chip.groups.push(group);
    chip.dots.push({ id, state: id === state.current ? 'current' : isHandled(state, id) ? 'done' : state.later.has(id) ? 'later' : 'open' });
    chips.set(key, chip);
  }
  return [...chips.values()];
}

// ─────────────────────────────── Answers ───────────────────────────────

/** The answer kind a question takes (an action item takes none: it is marked, not answered). */
function answerKind(question: InboxQuestion): QuestionAnswer['kind'] {
  const kind = readInboxQuestionKind(question.kind);
  return kind === 'multi' || kind === 'text' ? kind : 'single';
}

/** An answer to build on: the saved one, else empty. */
export function baseAnswer(question: InboxQuestion): QuestionAnswer {
  return question.answer ?? { v: 1, key: question.key, kind: answerKind(question), prompt: capQuestionPrompt(question.prompt), selected: [] };
}

export function choiceAnswer(question: InboxQuestion, selected: readonly string[], note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [...selected], ...(note.trim() ? { note: note.trim() } : {}) };
}

export function otherAnswer(question: InboxQuestion, other: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { text: _t, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], other: other.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function textAnswer(question: InboxQuestion, text: string, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, skipped: _s, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], text: text.trim(), ...(note.trim() ? { note: note.trim() } : {}) };
}

export function skipAnswer(question: InboxQuestion, note: string): QuestionAnswer {
  const base = baseAnswer(question);
  const { other: _o, text: _t, by_reply: _b, note: _n, ...rest } = base;
  return { ...rest, selected: [], skipped: true, ...(note.trim() ? { note: note.trim() } : {}) };
}

/** The answer in the person's words, for the stamp, the live region and the review: "Retry with the same key", "Skipped". */
export function answerWords(answer: QuestionAnswer | null): string {
  if (!answer) return 'No answer';
  if (answer.skipped) return 'Skipped';
  const parts = [...answer.selected];
  if (answer.other?.trim()) parts.push(answer.other.trim());
  if (answer.text?.trim()) parts.push(answer.text.trim());
  const words = parts.join(', ') || (answer.note ? 'A note' : 'No answer');
  return words.length > 120 ? `${words.slice(0, 119)}…` : words;
}

/** The two-way choice a swipe answers: a single question with exactly two choices (brief §3: touch only, two-way only). */
export function swipeChoices(question: InboxQuestion): [string, string] | null {
  if (readInboxQuestionKind(question.kind) !== 'single' || question.choices.length !== 2) return null;
  return [question.choices[0]!.label, question.choices[1]!.label];
}

/** The head's line: "5 of 16 · 6 agents waiting". */
export function headLine(state: QueueState): string {
  const live = state.order.filter((id) => {
    const reason = state.gone.get(id);
    return reason !== 'replaced' && reason !== 'closed';
  });
  const at = state.current === null ? live.length : Math.max(1, live.indexOf(state.current) + 1);
  const waiting = new Set(
    state.order.filter((id) => !isHandled(state, id)).map((id) => state.cache.get(id)?.session.key).filter((k): k is string => !!k),
  ).size;
  return `${at} of ${live.length} · ${waiting} ${waiting === 1 ? 'agent' : 'agents'} waiting`;
}
