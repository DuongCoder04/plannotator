/**
 * The onboarding tour's state machine, coach cards and fixture (approval
 * "inbox-onboarding-tour", v2). Pure: no DOM. The fixture is the shipped one
 * (packages/inbox/tour/content/fixture.json), checked as the brief asks:
 * every question block parses with core's parser, every referenced asset
 * ships and is in the server's manifest, the content stays under its budget,
 * and nothing private ships.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseInboxQuestionBlocks } from '@plannotator/core/inbox-questions';
import { readInboxAttachmentKind } from '@plannotator/core/inbox-types';
import {
  TOUR_FILM_REPLY_ID,
  TOUR_FILM_THREAD,
  TOUR_NEW_THREAD,
  TOUR_REPLY_ID,
  TOUR_START,
  TOUR_STEPS,
  TOUR_THREAD,
  filmTimings,
  newThreadTimings,
  parseTourFixture,
  pickDiffers,
  replayTimings,
  tourAttachments,
  tourCanBack,
  tourCoach,
  tourMessages,
  tourQuestion,
  tourRecord,
  tourReducer,
  tourSections,
  tourStateAt,
  tourSuggestionFor,
  tourTime,
  type TourAction,
  type TourState,
  type TourUi,
} from './model';

const CONTENT = join(import.meta.dir, 'content');
const raw = JSON.parse(readFileSync(join(CONTENT, 'fixture.json'), 'utf8'));
const fixture = parseTourFixture(raw);
const REAL = fixture.threads.find((t) => t.id === TOUR_THREAD)!.real_answer!;
const names = { developer: fixture.developer, agent: 'Claude Code' };
const run = (actions: TourAction[], from: TourState = TOUR_START) => actions.reduce(tourReducer, from);
const sectionOf = (state: TourState, id: string) => tourSections(fixture, state).find((s) => s.threads.some((r) => r.thread_id === id))?.id;
const files = tourAttachments(fixture, tourStateAt(TOUR_STEPS, REAL, fixture));
const fileNamed = (name: string) => files.find((a) => a.name === name)!;
const ask = tourQuestion(fixture)!.message;

/** A comment the person saves in a viewer, as the tour's file source records it. */
function fileComment(name: string, annotation: Record<string, unknown> = {}) {
  const a = fileNamed(name);
  const thread = fixture.threads.find((t) => t.messages.some((m) => m.id === a.message_id))!.id;
  return tourRecord({ id: `ann-${name}`, thread, message: a.message_id, attachment: a, annotation: { id: `ann-${name}`, type: 'COMMENT', text: 'x', ...annotation } });
}
const wordsComment = tourRecord({ id: 'ann-words', thread: TOUR_THREAD, message: ask.id, messageAt: '2026-10-24T12:03:00Z', annotation: { id: 'ann-words', type: 'COMMENT', text: 'x', originalText: 'x' } });

describe('the walk', () => {
  test('1 to 9 advance on the real actions; Next only where the brief puts it', () => {
    let s = TOUR_START;
    // Step 1 opens on "How it's organised", then the question's row.
    expect(tourCoach(s, names)).toMatchObject({ key: '1-orient', picture: 'orient', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '1', target: 'row' });
    s = tourReducer(s, { type: 'open', thread: TOUR_THREAD });
    expect(s).toMatchObject({ step: 2, route: TOUR_THREAD });
    expect(tourReducer(s, { type: 'next' })).toBe(s);
    s = tourReducer(s, { type: 'pick', label: REAL });
    expect(s).toMatchObject({ step: 3, picked: REAL });
    expect(tourCoach(s, names)!.target).toBe('phrase');
    expect(tourCoach(s, names, {}, { composing: true })!.key).toBe('3-box');
    s = tourReducer(s, { type: 'comment', record: wordsComment });
    expect(s.step).toBe(4);
    expect(tourCoach(s, names)!.target).toBe('eval-tile');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('EVALUATION.md').id, full: false });
    expect(tourCoach(s, names)!.target).toBe('eval-line');
    s = tourReducer(s, { type: 'comment', record: fileComment('EVALUATION.md') });
    expect(s.step).toBe(5);
    // Send before step 5 does nothing; at 5 it sends the pick and both comments in one reply.
    expect(tourCoach(s, names)!.target).toBe('reply');
    s = tourReducer(s, { type: 'reply', open: true });
    expect(tourCoach(s, names)!.key).toBe('5-box');
    s = tourReducer(s, { type: 'send' });
    expect(s).toMatchObject({ step: 6, sent: true, delivered: false, arrived: 0 });
    expect(s.comments.every((r) => r.sent_reply_id === TOUR_REPLY_ID)).toBe(true);
    expect(tourCoach(s, names)!.wait).toBe(true);
    s = run([{ type: 'delivered' }, { type: 'arrive' }, { type: 'arrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '6', target: 'inline-img' });
    s = tourReducer(s, { type: 'openFile', id: fileNamed('a1.png').id, full: true });
    expect(tourCoach(s, names)!.key).toBe('6-file');
    expect(tourCoach(s, names, {}, { drawn: true })!.key).toBe('6-drawn-unsaved');
    s = tourReducer(s, { type: 'comment', record: fileComment('a1.png') });
    expect(tourCoach(s, names)).toMatchObject({ key: '6-drawn', next: true });
    // The Artifacts part: the card, the grid, a tile, Next.
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '6-art', target: 'art-button' });
    s = tourReducer(s, { type: 'artifacts', open: true });
    expect(tourCoach(s, names)!.key).toBe('6-art-grid');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('EVALUATION.md').id, full: false });
    expect(tourCoach(s, names)).toMatchObject({ key: '6-art-open', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(s).toMatchObject({ step: 7, artifactsOpen: false, file: null });
    expect(tourCoach(s, names)!.target).toBe('film-row');
    s = tourReducer(s, { type: 'open', thread: TOUR_FILM_THREAD });
    expect(tourCoach(s, names)!.target).toBe('film-tile');
    s = tourReducer(s, { type: 'openFile', id: fileNamed('guides-vscode.mp4').id, full: false });
    expect(tourCoach(s, names, {}, { pinnedAt: '0:07' } satisfies TourUi)!.text).toContain('Pinned at 0:07');
    s = tourReducer(s, { type: 'comment', record: fileComment('guides-vscode.mp4', { inboxVideo: { time: 7.2 } }) });
    expect(tourCoach(s, names)!.key).toBe('7-send');
    s = tourReducer(s, { type: 'filmSend' });
    expect(s.comments.find((r) => r.thread_id === TOUR_FILM_THREAD)!.sent_reply_id).toBe(TOUR_FILM_REPLY_ID);
    s = run([{ type: 'filmDelivered' }, { type: 'filmArrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '7-done', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(s.step).toBe(8);
    expect(tourCoach(s, names)!.target).toBe('compose-btn');
    s = tourReducer(s, { type: 'compose', open: true });
    expect(tourCoach(s, names)!.target).toBe('compose-to');
    expect(tourCoach(s, names, {}, { toChosen: true })!.target).toBe('compose-send');
    s = tourReducer(s, { type: 'composeSend' });
    expect(s).toMatchObject({ compose: 'sent', route: TOUR_NEW_THREAD });
    s = run([{ type: 'newDelivered' }, { type: 'newArrive' }], s);
    expect(tourCoach(s, names)).toMatchObject({ key: '8-loop', next: true });
    s = tourReducer(s, { type: 'next' });
    expect(tourCoach(s, names)).toMatchObject({ key: '8-also', nextLabel: 'Connect my agents' });
    expect(tourCoach(s, names)!.items!.map((i) => i.title)).toEqual(['Pin a thread', 'Looks good', 'Re-ask', 'Send now']);
    s = tourReducer(s, { type: 'next' });
    expect(s.step).toBe(TOUR_STEPS);
    expect(tourCoach(s, names)).toBeNull();
  });

  test('Back on steps 2, 3, 4 and 7 before its Send; none on 5, 6, 8 or after a Send', () => {
    expect(tourCanBack(TOUR_START)).toBe(false);
    for (const step of [2, 3, 4, 7]) expect(tourCanBack(tourStateAt(step, REAL, fixture)), String(step)).toBe(true);
    for (const step of [5, 6, 8, 9]) expect(tourCanBack(tourStateAt(step, REAL, fixture)), String(step)).toBe(false);
    expect(tourCanBack({ ...tourStateAt(7, REAL, fixture), filmSent: true })).toBe(false);
    expect(tourReducer(tourStateAt(4, REAL, fixture), { type: 'back' }).step).toBe(3);
    expect(tourReducer(tourStateAt(7, REAL, fixture), { type: 'back' })).toMatchObject({ step: 6, route: TOUR_THREAD });
  });

  test('Send needs a pick and step 5; never twice; a pick after Send changes nothing', () => {
    expect(tourReducer(tourStateAt(4, REAL, fixture), { type: 'send' }).sent).toBe(false);
    const s6 = tourStateAt(6, REAL, fixture);
    expect(tourReducer(s6, { type: 'send' })).toBe(s6);
    expect(tourReducer(s6, { type: 'pick', label: 'B · Our reader beside a live native diff' })).toBe(s6);
    // The film's Send needs a comment waiting.
    const s7 = tourStateAt(7, REAL, fixture);
    expect(tourReducer(s7, { type: 'filmSend' })).toBe(s7);
  });

  test('the replays arrive only after delivery; reduced motion is about 60% of each', () => {
    const sent = run([{ type: 'open', thread: TOUR_THREAD }, { type: 'pick', label: REAL }, { type: 'comment', record: wordsComment }, { type: 'comment', record: fileComment('EVALUATION.md') }, { type: 'send' }]);
    expect(tourReducer(sent, { type: 'arrive' }).arrived).toBe(0);
    expect(run([{ type: 'delivered' }, { type: 'arrive' }, { type: 'arrive' }, { type: 'arrive' }], sent).arrived).toBe(2);
    expect(replayTimings(false)).toEqual({ delivered: 1100, first: 3000, second: 5600 });
    expect(filmTimings(false)).toEqual({ delivered: 1100, reply: 2400 });
    expect(newThreadTimings(false)).toEqual({ delivered: 1100, reply: 3200 });
    for (const [full, reduced] of [
      [replayTimings(false), replayTimings(true)],
      [filmTimings(false), filmTimings(true)],
      [newThreadTimings(false), newThreadTimings(true)],
    ] as const)
      for (const key of Object.keys(full) as (keyof typeof full)[]) expect(Math.abs(reduced[key] / full[key] - 0.6)).toBeLessThan(0.02);
  });

  test('tourStateAt(n) is the walk with every suggestion kept, for 1 to 9 (and out of range)', () => {
    expect(tourStateAt(1, REAL, fixture)).toEqual(TOUR_START);
    expect(tourStateAt(3, REAL, fixture)).toMatchObject({ picked: REAL, comments: [] });
    expect(tourStateAt(4, REAL, fixture).comments.map((r) => r.annotation.text)).toEqual([ask.suggest!.comment]);
    expect(tourStateAt(5, REAL, fixture).comments).toHaveLength(2);
    expect(tourStateAt(6, REAL, fixture)).toMatchObject({ sent: true, arrived: 2 });
    expect(tourStateAt(7, REAL, fixture)).toMatchObject({ artifactsTour: 2 });
    expect(tourStateAt(8, REAL, fixture)).toMatchObject({ filmArrived: true, step: 8 });
    expect(tourStateAt(9, REAL, fixture)).toMatchObject({ compose: 'sent', newArrived: true, step: 9 });
    for (let n = 1; n <= TOUR_STEPS; n++) {
      const s = tourStateAt(n, REAL, fixture);
      expect(s.step).toBe(n);
      // Every state reached directly draws a coach card (9 none) and its lists.
      if (n < TOUR_STEPS) expect(tourCoach(s, names)).not.toBeNull();
      expect(tourSections(fixture, s).length).toBeGreaterThan(0);
    }
    expect(tourStateAt(99, REAL, fixture).step).toBe(TOUR_STEPS);
    expect(tourStateAt(-3, REAL, fixture).step).toBe(1);
  });

  test('step 9 is the person’s own Inbox: nothing of the tour moves', () => {
    const s9 = tourStateAt(9, REAL, fixture);
    for (const action of [{ type: 'open', thread: TOUR_THREAD }, { type: 'list' }, { type: 'next' }, { type: 'compose', open: true }] as TourAction[]) expect(tourReducer(s9, action)).toBe(s9);
  });
});

describe('the coach', () => {
  test('every card is at most two sentences plus its action, and only positive', () => {
    const ui: TourUi[] = [{}, { composing: true }, { drawn: true }, { pinnedAt: '0:07' }, { toChosen: true }];
    const states: TourState[] = [];
    for (let n = 1; n < TOUR_STEPS; n++) {
      const s = tourStateAt(n, REAL, fixture);
      states.push(s, { ...s, route: 'list' }, { ...s, file: { id: 'x', full: false } }, { ...s, replyOpen: true }, { ...s, artifactsOpen: true });
    }
    states.push(TOUR_START, { ...tourStateAt(6, REAL, fixture), arrived: 0, delivered: false }, { ...tourStateAt(8, REAL, fixture), compose: 'sent' }, { ...tourStateAt(9, REAL, fixture), step: 8, also: false });
    const seen = new Set<string>();
    for (const s of states)
      for (const u of ui) {
        const c = tourCoach(s, names, {}, u);
        if (!c || seen.has(c.key)) continue;
        seen.add(c.key);
        expect(c.text.split(/(?<=[.!?])\s+/).filter(Boolean).length, c.key).toBeLessThanOrEqual(2);
        expect(`${c.title} ${c.text} ${c.action ?? ''}`, c.key).not.toMatch(/could not|couldn’t|error|failed|missing|try again|nothing (here )?is sent/i);
      }
    expect(seen.size).toBeGreaterThan(20);
  });
});

describe('what the window draws', () => {
  test('A: Waiting → Sent → New; B: New → Sent → New; C appears in Sent once sent, then New', () => {
    expect(sectionOf(TOUR_START, TOUR_THREAD)).toBe('waiting');
    expect(sectionOf(TOUR_START, TOUR_FILM_THREAD)).toBe('new');
    expect(sectionOf(TOUR_START, TOUR_NEW_THREAD)).toBeUndefined();
    const s6 = tourStateAt(6, REAL, fixture);
    expect(sectionOf({ ...s6, delivered: false, arrived: 0 }, TOUR_THREAD)).toBe('sent');
    expect(sectionOf(s6, TOUR_THREAD)).toBe('new');
    const s7 = tourStateAt(7, REAL, fixture);
    expect(sectionOf({ ...s7, filmSent: true }, TOUR_FILM_THREAD)).toBe('sent');
    const s8 = tourStateAt(8, REAL, fixture);
    expect(sectionOf({ ...s8, compose: 'sent' }, TOUR_NEW_THREAD)).toBe('sent');
    expect(sectionOf(tourStateAt(9, REAL, fixture), TOUR_NEW_THREAD)).toBe('new');
    // A pick and comments not sent read as a draft on the row.
    const row = tourSections(fixture, tourStateAt(5, REAL, fixture)).flatMap((s) => s.threads).find((r) => r.thread_id === TOUR_THREAD)!;
    expect(row.unsent).toEqual({ reply_at: null, picks: 1, comments: 2 });
  });

  test('the messages follow the walk; the replayed reply carries the pick and its comments', () => {
    const ids = (s: TourState) => tourMessages(fixture, TOUR_THREAD, s).map((v) => (v.reply ? 'reply' : v.replay ? 'replay' : v.wire.id));
    expect(ids(TOUR_START)).toEqual(['tour-vscode-1', 'tour-vscode-2', 'tour-vscode-3']);
    expect(ids(tourStateAt(6, REAL, fixture))).toEqual(['tour-vscode-1', 'tour-vscode-2', 'tour-vscode-3', 'reply', 'replay', 'replay']);
    const reply = tourMessages(fixture, TOUR_THREAD, tourStateAt(6, REAL, fixture)).find((v) => v.reply)!;
    expect(reply.wire.sent_annotations).toBe(2);
    const asking = tourMessages(fixture, TOUR_THREAD, tourStateAt(6, REAL, fixture)).find((v) => v.fixture?.asks)!;
    expect(asking.wire.questions![0]).toMatchObject({ state: 'sent', sent_reply_id: TOUR_REPLY_ID });
    // The PR message shows its screenshots in its text, as captured images of the thread.
    const pr = tourMessages(fixture, TOUR_THREAD, tourStateAt(6, REAL, fixture)).at(-1)!;
    expect(pr.wire.body).toContain('](built-a1.webp)');
    expect(pr.wire.inline_images!.map((i) => i.id)).toEqual(['tour-img-built-a1', 'tour-img-built-a2']);
    // C: the person's message, then the agent's answer.
    const c = tourMessages(fixture, TOUR_NEW_THREAD, tourStateAt(9, REAL, fixture));
    expect(c.map((v) => v.wire.author.kind)).toEqual(['person', 'agent']);
  });

  test('files: every kind the fixture writes is one the window reads; current is what was sent', () => {
    expect(files.map((a) => a.name)).toEqual(['prototype.html', 'EVALUATION.md', 'd1-clean.png', 'a1.png', 'a2.png', 'guides-vscode.mp4']);
    for (const a of files) {
      expect(readInboxAttachmentKind(a.kind)).toBe(a.kind);
      expect(a.changed_since_sent).toBe(false);
      expect(a.current!.size).toBe(a.size);
    }
    expect(tourSuggestionFor(fixture, fileNamed('guides-vscode.mp4'))!.at).toBe(7.2);
    expect(tourSuggestionFor(fixture, fileNamed('a1.png'))!.comment).toContain('should go on the site');
  });

  test('the times are the real ones', () => {
    expect(tourTime('11:47')).toBe('11:47 AM');
    expect(tourTime('13:25')).toBe('1:25 PM');
    expect(tourTime('18:11')).toBe('6:11 PM');
  });

  test('a pick other than the real answer is replayed with a note, as a fact', () => {
    expect(pickDiffers(tourStateAt(6, REAL, fixture), REAL)).toBe(false);
    expect(pickDiffers({ ...tourStateAt(6, REAL, fixture), picked: 'B · Our reader beside a live native diff' }, REAL)).toBe(true);
  });
});

describe('the fixture', () => {
  test('every question block parses with core’s parser; the tour question has picture choices and its real answer', () => {
    for (const thread of fixture.threads)
      for (const m of thread.messages) expect(parseInboxQuestionBlocks(m.body ?? '').length).toBe((m.body ?? '').match(/:::question/g)?.length ?? 0);
    const q = tourQuestion(fixture)!;
    expect(q.question.parsed.choices.map((c) => c.label)).toContain(REAL);
    expect(q.question.parsed.choices.filter((c) => c.image).length).toBe(3);
    // The suggestions name words that are on screen.
    expect(ask.body).toContain(ask.suggest!.phrase!);
    expect(readFileSync(join(CONTENT, 'evaluation.md'), 'utf8')).toContain(ask.attachments!.find((a) => a.name === 'EVALUATION.md')!.suggest!.phrase!);
  });

  test('every v2 asset ships and is in the manifest; the content stays under its 1.25 MB budget (cap 1.3 MB)', () => {
    const shipped = new Set(readdirSync(CONTENT));
    const referenced = new Set<string>(Object.entries(fixture.full).flat());
    for (const t of fixture.threads)
      for (const m of t.messages) {
        for (const a of m.attachments ?? []) [a.asset, a.poster].filter(Boolean).forEach((x) => referenced.add(x!));
        for (const i of m.inline_images ?? []) referenced.add(i.ref);
        for (const img of (m.body ?? '').matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) referenced.add(img[1]!);
      }
    for (const name of referenced) expect(shipped.has(name), name).toBe(true);
    const manifest = readFileSync(join(import.meta.dir, '../../server/inbox-tour-content.ts'), 'utf8');
    for (const name of shipped) if (name !== 'fixture.json' && name !== 'README') expect(manifest, name).toContain(`"${name}"`);
    for (const name of ['film-clip.mp4', 'film-poster.webp', 'evaluation.md']) expect(shipped.has(name), name).toBe(true);
    for (const gone of ['g1-thumb.webp', 'graphite-inbox.webp']) expect(shipped.has(gone)).toBe(false);
    const total = [...shipped].reduce((n, f) => n + statSync(join(CONTENT, f)).size, 0);
    expect(total).toBeLessThan(1.3 * 1024 * 1024);
  });

  test('privacy: no paths, ids, local addresses or emails in anything that ships (EVALUATION.md included)', () => {
    for (const name of readdirSync(CONTENT)) {
      if (/\.(webp|mp4)$/.test(name)) continue;
      const text = readFileSync(join(CONTENT, name), 'utf8');
      expect(text, name).not.toMatch(/\/Users\/|~\/|\bmsg_[0-9A-Z]{6,}|\batt_[0-9A-Z]{6,}|localhost:|127\.0\.0\.1|[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
      expect(text, name).not.toMatch(/ramos|michael/i);
    }
  });

  test('a fixture that is not the tour’s is refused, never half drawn', () => {
    expect(() => parseTourFixture(null)).toThrow();
    expect(() => parseTourFixture({ ...raw, v: 1 })).toThrow();
    expect(() => parseTourFixture({ ...raw, threads: raw.threads.slice(0, 2) })).toThrow();
    const bad = structuredClone(raw);
    bad.threads[0].messages[2].attachments[0].asset = '../../etc/passwd';
    expect(() => parseTourFixture(bad)).toThrow();
    const badKind = structuredClone(raw);
    badKind.threads[0].messages[2].attachments[0].kind = 'spreadsheet';
    expect(() => parseTourFixture(badKind)).toThrow();
  });
});
