/**
 * The onboarding tour's state machine, coach cards and fixture (approval
 * "inbox-onboarding-tour"). Pure: no DOM. The fixture is the shipped one
 * (packages/inbox/tour/content/fixture.json), checked as the brief asks:
 * every question block parses with core's parser, every referenced asset
 * exists, the content stays under its budget, and nothing private ships.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import {
  TOUR_SIDE_THREAD,
  TOUR_START,
  TOUR_STEPS,
  TOUR_THREAD,
  parseTourFixture,
  pickDiffers,
  replayTimings,
  tourCanBack,
  tourCoach,
  tourMessages,
  tourQuestion,
  tourReducer,
  tourSections,
  tourStateAt,
  tourTime,
  type TourAction,
  type TourState,
} from './model';

const CONTENT = join(import.meta.dir, 'content');
const raw = JSON.parse(readFileSync(join(CONTENT, 'fixture.json'), 'utf8'));
const fixture = parseTourFixture(raw);
const REAL = fixture.threads.find((t) => t.id === TOUR_THREAD)!.real_answer!;
const names = { developer: fixture.developer, agent: 'Claude Code' };
const run = (actions: TourAction[], from: TourState = TOUR_START) => actions.reduce(tourReducer, from);
const sectionOf = (state: TourState, id: string) => tourSections(fixture, state).find((s) => s.threads.some((r) => r.thread_id === id))?.id;

describe('the walk', () => {
  test('steps 1 to 6 advance on the real actions, and Next only where the brief puts it', () => {
    let s = TOUR_START;
    expect(s.step).toBe(1);
    expect(tourCoach(s, names)!.target).toBe('row');
    s = tourReducer(s, { type: 'open', thread: TOUR_THREAD });
    expect(s).toMatchObject({ step: 2, route: TOUR_THREAD });
    expect(tourCoach(s, names)!.target).toBe('choices');
    // Next does nothing until the step's own action happened.
    expect(tourReducer(s, { type: 'next' })).toBe(s);
    s = tourReducer(s, { type: 'pick', label: REAL });
    expect(s).toMatchObject({ step: 3, picked: REAL, sent: false });
    expect(tourCoach(s, names)!.target).toBe('send');
    s = tourReducer(s, { type: 'send' });
    expect(s).toMatchObject({ step: 4, sent: true, delivered: false, arrived: 0 });
    expect(tourCoach(s, names)!.wait).toBe(true);
    s = run([{ type: 'delivered' }, { type: 'arrive' }], s);
    expect(tourCoach(s, names)!.next).toBeUndefined();
    s = tourReducer(s, { type: 'arrive' });
    expect(s.arrived).toBe(2);
    expect(tourCoach(s, names)).toMatchObject({ key: '4-works', next: true, target: 'arrival' });
    s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: 5, mock: false });
    expect(tourCoach(s, names)!.target).toBe('mock-tile');
    expect(tourReducer(s, { type: 'next' })).toBe(s);
    s = tourReducer(s, { type: 'openMock' });
    expect(tourCoach(s, names)).toMatchObject({ key: '5-mock', next: true, target: 'file' });
    s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: TOUR_STEPS, mock: false });
    expect(tourCoach(s, names)).toBeNull();
  });

  test('Back on steps 2, 3 and 5; none on step 4, after the answer was sent', () => {
    expect(tourCanBack(TOUR_START)).toBe(false);
    for (const step of [2, 3, 5]) expect(tourCanBack(tourStateAt(step, REAL))).toBe(true);
    expect(tourCanBack(tourStateAt(4, REAL))).toBe(false);
    expect(tourReducer(tourStateAt(4, REAL), { type: 'back' })).toEqual(tourStateAt(4, REAL));
    expect(tourReducer(tourStateAt(2, REAL), { type: 'back' })).toMatchObject({ step: 1, route: 'list' });
    expect(tourReducer(tourStateAt(3, REAL), { type: 'back' })).toMatchObject({ step: 2, picked: REAL });
    expect(tourReducer(tourStateAt(5, REAL), { type: 'back' })).toMatchObject({ step: 4, sent: true });
  });

  test('Send needs a pick; a pick after Send changes nothing; unpicking goes back to step 2', () => {
    const s2 = tourStateAt(2, REAL);
    expect(tourReducer(s2, { type: 'send' })).toBe(s2);
    expect(tourReducer(tourStateAt(3, REAL), { type: 'pick', label: null })).toMatchObject({ step: 2, picked: null });
    const s4 = tourStateAt(4, REAL);
    expect(tourReducer(s4, { type: 'pick', label: 'B · Our reader beside a live native diff' })).toBe(s4);
    // A second Send never replays twice.
    expect(tourReducer(s4, { type: 'send' })).toBe(s4);
  });

  test('the replay arrives only after delivery, and at most twice', () => {
    const sent = run([{ type: 'open', thread: TOUR_THREAD }, { type: 'pick', label: REAL }, { type: 'send' }]);
    expect(tourReducer(sent, { type: 'arrive' }).arrived).toBe(0);
    const done = run([{ type: 'delivered' }, { type: 'arrive' }, { type: 'arrive' }, { type: 'arrive' }], sent);
    expect(done.arrived).toBe(2);
    expect(replayTimings(false)).toEqual({ delivered: 1100, first: 3000, second: 5600 });
    const reduced = replayTimings(true);
    expect(reduced.second).toBeLessThan(5600);
    expect(reduced.delivered).toBeLessThan(reduced.first);
  });

  test('leaving the thread mid-step points the way back to it, and keeps the pick', () => {
    const s = run([{ type: 'open', thread: TOUR_THREAD }, { type: 'pick', label: REAL }, { type: 'list' }]);
    expect(s).toMatchObject({ step: 3, picked: REAL, route: 'list' });
    expect(tourCoach(s, names)).toMatchObject({ target: 'row', title: 'The question is in this thread' });
    // The side thread can be read at any time, and is never the tour's question.
    const side = tourReducer(s, { type: 'open', thread: TOUR_SIDE_THREAD });
    expect(side).toMatchObject({ route: TOUR_SIDE_THREAD, step: 3 });
    expect(tourReducer(side, { type: 'open', thread: TOUR_THREAD })).toMatchObject({ route: TOUR_THREAD, step: 3 });
  });

  test('a step reached directly (#tour=N, a reload) has the walk up to it, with the real answer', () => {
    expect(tourStateAt(1, REAL)).toEqual(TOUR_START);
    expect(tourStateAt(3, REAL)).toMatchObject({ picked: REAL, sent: false });
    expect(tourStateAt(5, REAL)).toMatchObject({ sent: true, delivered: true, arrived: 2 });
    expect(tourStateAt(99, REAL).step).toBe(TOUR_STEPS);
    expect(tourStateAt(-3, REAL).step).toBe(1);
    expect(tourReducer(TOUR_START, { type: 'goto', step: 4, realAnswer: REAL })).toEqual(tourStateAt(4, REAL));
  });

  test('step 6 is the person own Inbox: nothing of the tour Inbox moves', () => {
    const s6 = tourStateAt(6, REAL);
    for (const action of [{ type: 'open', thread: TOUR_THREAD }, { type: 'list' }, { type: 'openMock' }] as TourAction[]) expect(tourReducer(s6, action)).toBe(s6);
  });
});

describe('the coach', () => {
  test('every card is at most two sentences plus its action', () => {
    const states = [TOUR_START, tourStateAt(2, REAL), tourStateAt(3, REAL), { ...tourStateAt(4, REAL), arrived: 0, delivered: false }, { ...tourStateAt(4, REAL), arrived: 1 }, tourStateAt(4, REAL), tourStateAt(5, REAL), { ...tourStateAt(5, REAL), mock: true }, { ...tourStateAt(3, REAL), route: 'list' as const }];
    const keys = new Set<string>();
    for (const s of states) {
      const c = tourCoach(s, names)!;
      keys.add(c.key);
      const sentences = c.text.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length).toBeLessThanOrEqual(2);
      expect(c.title.length).toBeGreaterThan(0);
      // Interactive steps advance on the real action; only 4 and 5 end with Next.
      if (c.next) expect(['4-works', '5-mock']).toContain(c.key);
    }
    expect(keys.size).toBe(states.length);
  });

  test('the cards are honest about the replay: never "nothing is sent" beside "delivered"', () => {
    const all = [TOUR_START, tourStateAt(2, REAL), tourStateAt(3, REAL), tourStateAt(4, REAL), tourStateAt(5, REAL)].map((s) => tourCoach(s, names)!);
    for (const c of all) expect(`${c.title} ${c.text} ${c.action ?? ''}`).not.toMatch(/nothing (here )?is sent|away/i);
    expect(tourCoach(tourStateAt(3, REAL), names)!.action).toBe('Press Send to replay it.');
  });
});

describe('what the window draws', () => {
  test('the tour thread moves Waiting on you → Sent → New since you looked; the side thread stays in New', () => {
    expect(sectionOf(TOUR_START, TOUR_THREAD)).toBe('waiting');
    const sent = { ...tourStateAt(4, REAL), delivered: false, arrived: 0 };
    expect(sectionOf(sent, TOUR_THREAD)).toBe('sent');
    expect(sectionOf(tourStateAt(4, REAL), TOUR_THREAD)).toBe('new');
    for (const s of [TOUR_START, sent, tourStateAt(5, REAL)]) expect(sectionOf(s, TOUR_SIDE_THREAD)).toBe('new');
    // A pick not sent reads as a draft on the row.
    const row = tourSections(fixture, tourStateAt(3, REAL)).flatMap((s) => s.threads).find((r) => r.thread_id === TOUR_THREAD)!;
    expect(row.unsent).toEqual({ reply_at: null, picks: 1, comments: 0 });
  });

  test('the messages follow the walk: the reply after Send, then the two replayed messages', () => {
    const ids = (s: TourState) => tourMessages(fixture, TOUR_THREAD, s).map((v) => (v.reply ? 'reply' : v.replay ? `replay` : v.wire.id));
    expect(ids(TOUR_START)).toEqual(['tour-vscode-1', 'tour-vscode-2', 'tour-vscode-3']);
    expect(ids({ ...tourStateAt(4, REAL), delivered: false, arrived: 0 })).toEqual(['tour-vscode-1', 'tour-vscode-2', 'tour-vscode-3', 'reply']);
    expect(ids(tourStateAt(4, REAL))).toEqual(['tour-vscode-1', 'tour-vscode-2', 'tour-vscode-3', 'reply', 'replay', 'replay']);
    const ask = tourMessages(fixture, TOUR_THREAD, tourStateAt(4, REAL)).find((v) => v.fixture?.asks)!;
    expect(ask.wire.questions![0]).toMatchObject({ state: 'sent', sent_reply_id: 'tour-vscode-reply' });
    expect(ask.wire.questions![0]!.answer!.selected).toEqual([REAL]);
  });

  test('the times are the real ones', () => {
    expect(tourTime('11:47')).toBe('11:47 AM');
    expect(tourTime('12:03')).toBe('12:03 PM');
    expect(tourTime('13:25')).toBe('1:25 PM');
    expect(tourTime('00:05')).toBe('12:05 AM');
  });

  test('a pick other than the real answer is replayed with a note, never as obeyed', () => {
    expect(pickDiffers(tourStateAt(4, REAL), REAL)).toBe(false);
    expect(pickDiffers({ ...tourStateAt(4, REAL), picked: 'B · Our reader beside a live native diff' }, REAL)).toBe(true);
  });
});

describe('the fixture', () => {
  test('every question block parses with core’s parser; the tour question has picture choices and its real answer', () => {
    for (const thread of fixture.threads) {
      for (const m of thread.messages) {
        const fenced = (m.body ?? '').match(/:::question/g)?.length ?? 0;
        expect(parseInboxQuestionBlocks(m.body ?? '').length).toBe(fenced);
      }
    }
    const q = tourQuestion(fixture)!;
    expect(q.question.parsed.choices.map((c) => c.label)).toContain(REAL);
    expect(q.question.parsed.choices.filter((c) => c.image).length).toBe(3);
    expect(q.question.parsed.recommendation).toBe(REAL);
  });

  test('every referenced asset ships, and the content stays under its budget', () => {
    const files = new Set(readdirSync(CONTENT));
    const referenced = new Set<string>(Object.entries(fixture.full).flat());
    for (const t of fixture.threads)
      for (const m of t.messages) {
        for (const p of m.gallery ?? []) [p.asset, p.full].filter(Boolean).forEach((a) => referenced.add(a!));
        for (const a of m.attachments ?? []) if (a.mock) referenced.add(a.mock);
        for (const img of (m.body ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) referenced.add(img[1]!);
      }
    for (const name of referenced) expect(files.has(name)).toBe(true);
    // Nothing ships that nothing uses (the fixture itself and the server's manifest list the rest).
    const manifest = readFileSync(join(import.meta.dir, '../../server/inbox-tour-content.ts'), 'utf8');
    for (const name of files) if (name !== 'fixture.json') expect(manifest).toContain(`"${name}"`);
    const total = [...files].reduce((n, f) => n + statSync(join(CONTENT, f)).size, 0);
    expect(total).toBeLessThan(800 * 1024);
  });

  test('privacy: no paths, ids, local addresses or emails in anything that ships', () => {
    for (const name of readdirSync(CONTENT)) {
      if (name.endsWith('.webp')) continue;
      const text = readFileSync(join(CONTENT, name), 'utf8');
      expect(text).not.toMatch(/\/Users\/|~\/|\bmsg_[0-9A-Z]{6,}|\batt_[0-9A-Z]{6,}|localhost:|127\.0\.0\.1|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      // The owner's name is never shown: the developer is "Plannotator's developer".
      expect(text).not.toMatch(/ramos|michael/i);
    }
  });

  test('a fixture that is not the tour’s is refused, never half drawn', () => {
    expect(() => parseTourFixture(null)).toThrow();
    expect(() => parseTourFixture({ ...raw, v: 2 })).toThrow();
    expect(() => parseTourFixture({ ...raw, threads: [] })).toThrow();
    const bad = structuredClone(raw);
    bad.threads[0].messages[2].gallery[0].asset = '../../etc/passwd';
    expect(() => parseTourFixture(bad)).toThrow();
  });
});
