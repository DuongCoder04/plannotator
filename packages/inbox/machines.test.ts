/**
 * Linked machines in the window (docs/agent-guides/inbox-machines.md), the
 * pure half: a window routes another machine's thread through
 * `/api/inbox/m/<machine>/…` and its own through `/api/inbox/…`; nothing is
 * labelled, greyed or filtered while no machine is linked; the same folder on
 * two machines reads as two machines, not as a clash; a filter keeps one
 * machine's rows and "Hide offline machines" drops only the away ones; a held
 * answer says "Sending…" or "Will send when … is back" and never anything
 * like delivered before that machine answered (PLAN.md section 12).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { idsIn, inboxApi, type MachineView, type OutboxView } from './api';
import { inboxUrl, machineOf, rememberMachine, resetMachineRoutes, setSelfMachine } from './inboxUrl';
import { filterMachineRows, machineCounts, machineProjectNames, machinesModel, outboxLine, threadAwayLine, threadOutbox } from './machines';

const SELF = `ibx_01K${'0'.repeat(22)}S`;
const MAC = `ibx_01K${'0'.repeat(22)}M`;
const MINI = `ibx_01K${'0'.repeat(22)}N`;

function machine(id: string, name: string, state: MachineView['state'], extra: Partial<MachineView> = {}): MachineView {
  return { id, name, self: id === SELF, state, since: '2026-10-30T10:42:00.000Z', reason: null, version: '0.28.39', address: null, both_ways: true, waiting: 0, ...extra };
}

function row(id: string, section: InboxListSection['id'], owner?: string): InboxListRow {
  return { thread_id: id, section, project: { id: `prj_${id}`, name: 'billing-svc' }, ...(owner ? { machine: owner } : {}) } as unknown as InboxListRow;
}

function outbox(key: string, route: string, state: OutboxView['state'], extra: Partial<OutboxView> = {}): OutboxView {
  return { key, machine: MAC, route, state, queued_at: `2026-10-30T10:4${key.length % 10}:00.000Z`, settled_at: null, status: null, answer: null, notice: null, dismissed: false, words: 'Ship it', ...extra };
}

afterEach(() => resetMachineRoutes());

describe('routing', () => {
  test("another machine's ids go through its forward; this machine's and unknown ids stay local", () => {
    setSelfMachine(SELF);
    rememberMachine(['msg_01KREMOTE00000000000000001', 'thr_01KREMOTE00000000000000001'], MAC);
    // This machine's own id never becomes a forward, even when a frame names it.
    rememberMachine(['msg_01KLOCAL000000000000000001'], SELF);
    expect(machineOf('msg_01KREMOTE00000000000000001')).toBe(MAC);
    expect(machineOf('msg_01KLOCAL000000000000000001')).toBeNull();
    expect(inboxUrl('/messages/msg_01KREMOTE00000000000000001/reply', undefined, machineOf('msg_01KREMOTE00000000000000001'))).toBe(
      `/api/inbox/m/${MAC}/messages/msg_01KREMOTE00000000000000001/reply`,
    );
    expect(inboxUrl('/threads/x', 'a=1', MAC)).toBe(`/api/inbox/m/${MAC}/threads/x?a=1`);
    expect(inboxUrl('/threads/x', undefined, SELF)).toBe('/api/inbox/threads/x');
    expect(inboxUrl('/threads/x', undefined, null)).toBe('/api/inbox/threads/x');
  });
});

describe('never linked', () => {
  const sections: InboxListSection[] = [{ id: 'waiting', label: 'Waiting on you', threads: [row('a', 'waiting'), row('b', 'waiting')] }];

  test('the model is empty: no machine to label, grey or filter, and the list and names are what they were', () => {
    for (const machines of [undefined, null, [], [machine(SELF, 'Studio', 'online')]]) {
      const model = machinesModel(machines);
      expect(model.linked).toEqual([]);
      expect(model.all).toEqual([]);
      expect(model.away.size).toBe(0);
      expect(filterMachineRows(sections, model, null, true)).toBe(sections);
      expect(filterMachineRows(sections, model, MAC, false)).toBe(sections);
      const names = machineProjectNames({ projects: [{ id: 'prj_a', root: '/w/billing-svc', name: 'billing-svc' }], sidebar: [{ id: 'prj_a' }], sections: [] }, model, true);
      expect(names.get('prj_a')).toBe('billing-svc');
    }
  });
});

describe('linked', () => {
  const machines = [machine(SELF, 'Studio', 'online'), machine(MAC, 'MacBook', 'offline'), machine(MINI, 'Mini', 'online')];
  const model = machinesModel(machines);
  const sections: InboxListSection[] = [
    { id: 'waiting', label: 'Waiting on you', threads: [row('own', 'waiting'), row('mac', 'waiting', MAC), row('mini', 'waiting', MINI)] },
    { id: 'quiet', label: 'Quiet', threads: [row('mac2', 'quiet', MAC)] },
  ];
  const ids = (out: InboxListSection[]) => out.map((s) => s.threads.map((t) => t.thread_id));

  test('the same folder on two machines carries the other machine\'s name, not a clash; one machine\'s list drops it', () => {
    const projects = [
      { id: 'prj_own', root: '/work/billing-svc', name: 'billing-svc' },
      { id: 'prj_mac', root: '/work/billing-svc', name: 'billing-svc', machine: MAC },
    ];
    const labelled = machineProjectNames({ projects, sidebar: projects, sections: [] }, model, true);
    expect(labelled.get('prj_own')).toBe('billing-svc');
    expect(labelled.get('prj_mac')).toBe('billing-svc · MacBook');
    expect(machineProjectNames({ projects, sidebar: projects, sections: [] }, model, false).get('prj_mac')).toBe('billing-svc');
  });

  test('a machine filter keeps its rows (this machine: rows with no machine); Hide offline machines drops only the away ones', () => {
    expect(model.away).toEqual(new Set([MAC]));
    expect(ids(filterMachineRows(sections, model, MAC, false))).toEqual([['mac'], ['mac2']]);
    expect(ids(filterMachineRows(sections, model, SELF, false))).toEqual([['own'], []]);
    expect(ids(filterMachineRows(sections, model, null, true))).toEqual([['own', 'mini'], []]);
    expect(ids(filterMachineRows(sections, model, null, false))).toEqual([['own', 'mac', 'mini'], ['mac2']]);
    // The sidebar counts what waits on the person per machine, as Projects counts do.
    expect(machineCounts(sections, model)).toEqual(new Map([[SELF, 1], [MAC, 1], [MINI, 1]]));
  });

  test("an away machine's thread that cannot open says so; one that is there says nothing", () => {
    expect(threadAwayLine(machines[1])).toStartWith('MacBook asleep since ');
    expect(threadAwayLine(machines[1])).toEndWith('This thread opens when it is back.');
    expect(threadAwayLine(machine(MAC, 'MacBook', 'needs_update'))).toBe('Update Plannotator on MacBook to see its threads here.');
    expect(threadAwayLine(machines[2])).toBeNull();
    expect(threadAwayLine(undefined)).toBeNull();
  });
});

describe('held answers', () => {
  const asleep = machine(MAC, 'MacBook', 'offline');
  const online = machine(MAC, 'MacBook', 'online');

  test('waiting reads "Sending to …" while it is there and "Will send when … is back" while it sleeps; a delivered one says nothing', () => {
    const held = outbox('k1', 'messages/msg_1/reply', 'queued');
    expect(outboxLine(held, asleep)).toEqual({ tone: 'waiting', text: 'Will send when MacBook is back' });
    expect(outboxLine(outbox('k1', 'messages/msg_1/reply', 'sending'), online)).toEqual({ tone: 'waiting', text: 'Sending to MacBook…' });
    expect(outboxLine(outbox('k1', 'messages/msg_1/reply', 'delivered'), online)).toBeNull();
    for (const state of ['queued', 'sending'] as const) {
      for (const m of [asleep, online]) expect(outboxLine(outbox('k', 'messages/msg_1/reply', state), m)!.text).not.toMatch(/deliver/i);
    }
  });

  test('a write that did not land says why, until dismissed', () => {
    const refused = outbox('k2', 'messages/msg_1/reply', 'refused', { notice: { kind: 'refused', at: 'x' }, answer: { error: 'The question was already answered.' } });
    expect(outboxLine(refused, online)).toEqual({ tone: 'failed', text: 'Not delivered: The question was already answered.' });
    expect(outboxLine({ ...refused, notice: { kind: 'may_have_been_delivered', at: 'x' } }, online)!.text).toBe('May have been delivered. Check on MacBook.');
    expect(outboxLine({ ...refused, dismissed: true }, online)).toBeNull();
  });

  test("a thread shows its own held words and failures, oldest first; not other threads', not a delivered one, not a read mark", () => {
    const entries = new Map<string, OutboxView>(
      [
        outbox('k-reply', 'messages/msg_1/reply', 'queued', { queued_at: '2026-10-30T10:45:00.000Z' }),
        outbox('k-msg', 'threads/thr_1/message', 'sending', { queued_at: '2026-10-30T10:44:00.000Z' }),
        outbox('k-read', 'threads/thr_1/read', 'queued'),
        outbox('k-done', 'messages/msg_1/reask', 'delivered'),
        outbox('k-other', 'messages/msg_9/reply', 'queued'),
        outbox('k-fail', 'messages/msg_1/reply', 'refused', { notice: { kind: 'refused', at: 'x' }, queued_at: '2026-10-30T10:40:00.000Z' }),
      ].map((e) => [e.key, e]),
    );
    const shown = threadOutbox(entries, { thread_id: 'thr_1', messages: [{ id: 'msg_1' }] });
    expect(shown.map((e) => e.key)).toEqual(['k-fail', 'k-msg', 'k-reply']);
  });
});

describe('held answers by state', () => {
  test('connecting is on its way, out of date waits for an update, removed there says it will not go; none says delivered', () => {
    const held = outbox('k', 'messages/msg_1/reply', 'queued');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'connecting'))!.text).toBe('Sending to MacBook…');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'needs_update'))!.text).toBe('Will send when MacBook is updated');
    expect(outboxLine(held, machine(MAC, 'MacBook', 'revoked'))!.text).toMatch(/^Not sent: MacBook removed the link/);
    for (const state of ['connecting', 'needs_update', 'revoked', 'offline', 'online'] as const) {
      expect(outboxLine(held, machine(MAC, 'MacBook', state))!.text).not.toMatch(/deliver/i);
    }
  });

  test('a held answer the window tied to its thread shows while the thread cannot be read (no messages yet), and only there', () => {
    const entries = new Map<string, OutboxView>(
      [outbox('k-mine', 'messages/msg_1/reply', 'queued', { thread: 'thr_1' }), outbox('k-other', 'messages/msg_9/reply', 'queued', { thread: 'thr_9' })].map((e) => [e.key, e]),
    );
    expect(threadOutbox(entries, { thread_id: 'thr_1', messages: [] }).map((e) => e.key)).toEqual(['k-mine']);
  });
});

describe("thread ids: a linked machine never takes over this machine's", () => {
  const LOCAL = 'thr_01KLOCAL00000000000000001';
  const REMOTE = 'thr_01KREMOTE0000000000000001';
  const LOCAL_PROJECT = 'prj_01KLOCAL00000000000000001';
  const REMOTE_PROJECT = 'prj_01KREMOTE0000000000000001';
  const listModel = {
    self: SELF,
    sections: [
      {
        id: 'needs_you',
        threads: [
          { thread_id: LOCAL, section: 'needs_you', project: { id: LOCAL_PROJECT, name: 'billing-svc' } },
          // MacBook sends a row with this machine's own thread id, and one of its own.
          { thread_id: LOCAL, section: 'needs_you', project: { id: REMOTE_PROJECT, name: 'billing-svc' }, machine: MAC },
          { thread_id: REMOTE, section: 'needs_you', project: { id: REMOTE_PROJECT, name: 'billing-svc' }, machine: MAC },
        ],
      },
    ],
    projects: [
      { id: LOCAL_PROJECT, name: 'billing-svc' },
      { id: REMOTE_PROJECT, name: 'billing-svc', machine: MAC },
    ],
    machines: [],
  };

  test('a colliding id in the merged list stays local; a later answer or event from a linked machine cannot claim it either', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify(listModel), { headers: { 'Content-Type': 'application/json' } })) as unknown as typeof fetch;
    try {
      await inboxApi.list();
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(machineOf(LOCAL)).toBeNull();
    expect(machineOf(LOCAL_PROJECT)).toBeNull();
    expect(machineOf(REMOTE)).toBe(MAC);
    // A forwarded answer or a `machine` frame naming the local id: still local, so a reply to it stays here.
    rememberMachine([LOCAL], MAC);
    rememberMachine([LOCAL], MINI, true);
    expect(machineOf(LOCAL)).toBeNull();
    expect(inboxUrl(`/threads/${LOCAL}/read`, undefined, machineOf(LOCAL))).toBe(`/api/inbox/threads/${LOCAL}/read`);
    // Nor can one linked machine take another's thread: Mini naming MacBook's id leaves it with MacBook.
    rememberMachine([REMOTE], MINI);
    rememberMachine([REMOTE], MINI, true);
    expect(machineOf(REMOTE)).toBe(MAC);
  });

  test('a forwarded answer teaches only its routed id fields, never any string under a key ending in _id', () => {
    const ids = idsIn({
      thread: { id: REMOTE, messages: [{ message_id: 'msg_01KREMOTE00000000000000001' }] },
      x_id: LOCAL,
      session_id: 'ses_01KREMOTE0000000000000001',
    });
    expect([...ids].sort()).toEqual(['msg_01KREMOTE00000000000000001', REMOTE]);
  });
});
