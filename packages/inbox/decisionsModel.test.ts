/**
 * Decision mode's queue, pure (packages/inbox/decisions/model.ts): the
 * projection folded in without reordering or undoing a saved pick, Later,
 * Previous, when a session's reply may go, and which replies a Send makes.
 */
import { describe, expect, test } from 'bun:test';
import type { InboxDecision, InboxListRow, InboxMessageWire, InboxQuestion, InboxThread } from '@plannotator/core/inbox-types';
import {
  afterSendOf,
  answerWords,
  choiceAnswer,
  emptyQueue,
  groupHalfAnswered,
  groupKeyOf,
  groupReady,
  groupSendTargets,
  headLine,
  mergeDecisions,
  nextId,
  previousId,
  putOff,
  skipAnswer,
  swipeChoices,
} from './decisions/model';

function question(key: string, extra: Partial<InboxQuestion> = {}): InboxQuestion {
  return {
    key,
    position: 0,
    kind: 'single',
    prompt: `Prompt ${key}?`,
    context: null,
    choices: [
      { label: 'Yes', description: null, recommended: false, settled: false },
      { label: 'No', description: null, recommended: false, settled: false },
    ],
    recommendation: null,
    suggested_text: null,
    stopped: null,
    holds_up: [],
    asked_by_agent_id: null,
    orphaned: false,
    state: 'open',
    answer: null,
    revision: 0,
    sent_revision: 0,
    picked_by: null,
    picked_at: null,
    sent_reply_id: null,
    message_id: 'msg_a',
    superseded_by: null,
    ...extra,
  };
}

function decision(id: string, session: string, thread = 'msg_t1', extra: Partial<InboxQuestion> = {}): InboxDecision {
  const [message, key] = id.split('/') as [string, string];
  return {
    id,
    question: question(key, { message_id: message, ...extra }),
    message: { id: message, created_at: '2026-10-24T10:00:00.000Z', author: { kind: 'agent', host: 'claude-code', session, name: null }, excerpt: null },
    pictures: { inline: [], attachments: [] },
    thread: { id: thread, subject: 'Refunds', thread_name: null, project: { id: 'prj_1', name: 'billing' }, section: 'waiting' },
    session: { key: `s:claude-code\u0000${session}`, host: 'claude-code', session, name: null, wakes: true },
  };
}

const A1 = decision('msg_a/q-1', 'ses_a');
const A2 = decision('msg_a/q-2', 'ses_a');
const B1 = decision('msg_b/q-3', 'ses_b', 'msg_t2');

describe('the queue', () => {
  test('folds the projection in: order kept, new ones at the end, the ones that left marked', () => {
    let q = mergeDecisions(emptyQueue(), [A1, A2]);
    expect(q.order).toEqual([A1.id, A2.id]);
    expect(q.current).toBe(A1.id);
    q = mergeDecisions(q, [B1, A2]);
    expect(q.order).toEqual([A1.id, A2.id, B1.id]);
    expect(q.gone.get(A1.id)).toBe('closed');
    // A send group this sitting sent: what left with it reads as sent.
    const sent = mergeDecisions(mergeDecisions(emptyQueue(), [A1, A2, B1]), [B1], new Set([groupKeyOf(A1)]));
    expect(sent.gone.get(A1.id)).toBe('sent');
  });

  test('a read older than a saved pick, or one that crossed a pick on its way, never undoes it', () => {
    let q = mergeDecisions(emptyQueue(), [A1]);
    const picked = { ...A1, question: { ...A1.question, state: 'picked' as const, revision: 1, answer: choiceAnswer(A1.question, ['Yes'], '') } };
    q = mergeDecisions(q, [picked]);
    q = mergeDecisions(q, [A1]);
    expect(q.cache.get(A1.id)!.question.state).toBe('picked');
    // Optimistic (revision 0 still) but the pick is on its way.
    const optimistic = mergeDecisions(emptyQueue(), [{ ...A1, question: { ...A1.question, state: 'picked' } }]);
    expect(mergeDecisions(optimistic, [A1], new Set(), new Set([A1.id])).cache.get(A1.id)!.question.state).toBe('picked');
    expect(mergeDecisions(optimistic, [A1]).cache.get(A1.id)!.question.state).toBe('open');
  });

  test('Later puts a decision at the end, and it comes back once the rest are handled', () => {
    let q = mergeDecisions(emptyQueue(), [A1, A2, B1]);
    q = putOff(q, A1.id);
    expect(q.order).toEqual([A2.id, B1.id, A1.id]);
    expect(q.current).toBe(A2.id);
    const handled = (d: InboxDecision) => ({ ...d, question: { ...d.question, state: 'picked' as const, revision: 1 } });
    q = mergeDecisions(q, [A1, handled(A2), handled(B1)]);
    expect(nextId(q, B1.id)).toBe(A1.id);
    // A put off and still open keeps its session's reply back.
    expect(groupReady(q, groupKeyOf(A1))).toBe(false);
    expect(groupHalfAnswered(q, groupKeyOf(A1))).toBe(true);
    expect(groupReady(q, groupKeyOf(B1))).toBe(true);
    expect(previousId(q, A1.id)).toBe(B1.id);
    expect(headLine({ ...q, current: A1.id })).toBe('3 of 3 · 1 agent waiting');
  });

  test('a group of action items alone sends nothing (the actions route sends those)', () => {
    const act = decision('msg_c/a-1', 'ses_c', 'msg_t3', { kind: 'action', state: 'picked' });
    const q = mergeDecisions(emptyQueue(), [act]);
    expect(groupReady(q, groupKeyOf(act))).toBe(false);
  });
});

describe('the Send', () => {
  const agent = (id: string, session: string, questions: InboxQuestion[]): InboxMessageWire =>
    ({ id, thread_id: 'msg_t1', project_id: 'prj_1', author: { kind: 'agent', host: 'claude-code', session, name: null }, subject: null, body: '', created_at: '2026-10-24T10:00:00.000Z', reply_to: null, questions }) as unknown as InboxMessageWire;
  test("is the thread's own Send targets, kept to the group's session and to replies that carry an answer", () => {
    const thread = {
      thread_id: 'msg_t1',
      messages: [
        agent('msg_1', 'ses_a', [question('q-1', { message_id: 'msg_1', state: 'picked', revision: 2 })]),
        agent('msg_2', 'ses_b', [question('q-2', { message_id: 'msg_2', state: 'picked', revision: 1 })]),
        agent('msg_3', 'ses_a', [question('q-3', { message_id: 'msg_3', state: 'picked', revision: 1 })]),
      ],
    } as unknown as InboxThread;
    const targets = groupSendTargets(thread, 's:claude-code\u0000ses_a');
    expect(targets).toHaveLength(1);
    expect(targets[0]!.message.id).toBe('msg_3');
    expect(targets[0]!.questions).toEqual([{ message_id: 'msg_1', key: 'q-1', revision: 2 }, { key: 'q-3', revision: 1 }]);
    expect(groupSendTargets(thread, 's:claude-code\u0000ses_z')).toEqual([]);
  });

  test('after it: Sending (or Queued, Saved), Delivered, Working, Replied', () => {
    const row = (extra: Partial<InboxListRow>) => ({ last_author: 'person', last_agent_at: '2026-10-24T10:00:00.000Z', delivery: null, sent: null, ...extra }) as unknown as InboxListRow;
    const at = '2026-10-24T10:05:00.000Z';
    expect(afterSendOf(row({}), at, null)).toBe('sending');
    expect(afterSendOf(row({ delivery: { state: 'queued' } as InboxListRow['delivery'] }), at, true)).toBe('queued');
    expect(afterSendOf(row({ delivery: { state: 'saved' } as InboxListRow['delivery'] }), at, null)).toBe('saved');
    expect(afterSendOf(row({ delivery: { state: 'delivered' } as InboxListRow['delivery'] }), at, false)).toBe('delivered');
    expect(afterSendOf(row({ delivery: { state: 'delivered' } as InboxListRow['delivery'] }), at, true)).toBe('working');
    expect(afterSendOf(row({ last_author: 'agent', last_agent_at: '2026-10-24T10:06:00.000Z' }), at, true)).toBe('replied');
  });
});

describe('answers', () => {
  test('in the person\'s words, and a swipe only for a two-way choice', () => {
    expect(answerWords(choiceAnswer(A1.question, ['Yes'], 'soon'))).toBe('Yes');
    expect(answerWords(skipAnswer(A1.question, ''))).toBe('Skipped');
    expect(skipAnswer(A1.question, 'later').note).toBe('later');
    expect(swipeChoices(A1.question)).toEqual(['Yes', 'No']);
    expect(swipeChoices({ ...A1.question, kind: 'multi' })).toBeNull();
  });
});
