/**
 * Pins (approval "inbox-pinned-threads"): window furniture outside the event
 * log. What can regress: a pin writing a store line or taking a seq, a pin
 * moving a row, a section or the routing of a later send, an order dropping a
 * pin or keeping a duplicate, a pin of a missing or non-root thread, and the
 * file outliving its thread. The property runs a store with pins beside a
 * twin that never pins and checks the two never differ in anything but pins.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fc from "fast-check";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-store-pin-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "repo", root: "/work/repo" });
  return { dir, store, project };
}

const agent = (session: string) => ({ kind: "agent" as const, host: "claude-code", session, name: "Claude Code" });
const ASK = ":::question\nWhich index?\n\n- [ ] Pagefind\n- [ ] Orama\n:::";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof InboxError) return error.code;
    throw error;
  }
  return "ok";
}

describe("pins in the store", () => {
  test("pin, unpin and order; a reply is not a thread; an unknown id is refused", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One" }).message;
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "Two" }).message;
    const reply = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One, again" }).message;
    expect(reply.thread_id).toBe(a.thread_id);
    expect(code(() => store.setPinned(reply.id, true))).toBe("thread_not_found");
    expect(code(() => store.setPinned("msg_01K70000000000000000000099", true))).toBe("thread_not_found");
    store.setPinned(b.thread_id, true);
    store.setPinned(a.thread_id, true);
    expect(store.pins().map((p) => p.thread_id)).toEqual([b.thread_id, a.thread_id]);
    expect(store.pinnedAt(a.thread_id)).toEqual(expect.any(String));
    store.orderPins([a.thread_id]);
    expect(store.pins().map((p) => p.thread_id)).toEqual([a.thread_id, b.thread_id]);
    store.setPinned(a.thread_id, false);
    expect(store.pinnedAt(a.thread_id)).toBeNull();
    expect(code(() => store.orderPins([b.thread_id, b.thread_id]))).toBe("validation_error");
    expect(code(() => store.orderPins("x"))).toBe("validation_error");
  });

  test("the file is the pins in order; gone with the last pin; read again at open", () => {
    const { dir, store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One" }).message;
    const file = join(dir, "inbox", "pins.json");
    let told = 0;
    store.onPinsChange(() => told++);
    store.setPinned(a.thread_id, true);
    expect(told).toBe(1);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ v: 1, pins: [{ thread_id: a.thread_id, pinned_at: store.pinnedAt(a.thread_id) }] });
    expect(InboxStore.open(dir).pins().map((p) => p.thread_id)).toEqual([a.thread_id]);
    store.setPinned(a.thread_id, true);
    expect(told).toBe(1);
    store.setPinned(a.thread_id, false);
    expect(existsSync(file)).toBe(false);
  });

  test("a deleted thread leaves the pins, and the listeners hear it", () => {
    const { store, project } = open();
    const a = store.sendMessage({ project_id: project.id, author: agent("ses_a"), body: "One" }).message;
    const b = store.sendMessage({ project_id: project.id, author: agent("ses_b"), body: "Two" }).message;
    store.setPinned(a.thread_id, true);
    store.setPinned(b.thread_id, true);
    let told = 0;
    store.onPinsChange(() => told++);
    store.deleteThread(a.thread_id);
    expect(store.pins().map((p) => p.thread_id)).toEqual([b.thread_id]);
    expect(told).toBe(1);
  });

  test("property: pins never change a row, a section, the cursor or where a send lands", () => {
    type Op =
      | { kind: "send"; session: number; ask: boolean; name: number | null }
      | { kind: "pin"; thread: number }
      | { kind: "unpin"; thread: number }
      | { kind: "order"; picks: number[] }
      | { kind: "resolve"; thread: number };
    const op: fc.Arbitrary<Op> = fc.oneof(
      fc.record({ kind: fc.constant("send" as const), session: fc.nat(3), ask: fc.boolean(), name: fc.option(fc.nat(2), { nil: null }) }),
      fc.record({ kind: fc.constant("pin" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("unpin" as const), thread: fc.nat(12) }),
      fc.record({ kind: fc.constant("order" as const), picks: fc.uniqueArray(fc.nat(12), { maxLength: 6 }) }),
      fc.record({ kind: fc.constant("resolve" as const), thread: fc.nat(12) }),
    );
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 40 }), (ops) => {
        const pinned = open();
        const twin = open();
        const threads: [string[], string[]] = [[], []];
        /** A row as the twin would have it: thread ids replaced by their index. */
        const view = (store: InboxStore, ids: string[]) =>
          store.listRows().map((row) => {
            const { thread_id, project: _p, last_at: _l, waiting_since: _w, ...rest } = row as unknown as Record<string, unknown> & { thread_id: string };
            return JSON.stringify({ i: ids.indexOf(thread_id), section: rest.section, unread: rest.unread, unseen: rest.unseen, questions: rest.questions, resolved: rest.resolved_at !== null, pinned_at: (rest as { pinned_at?: unknown }).pinned_at });
          }).sort();
        for (const step of ops) {
          const cursorBefore = pinned.store.cursor();
          if (step.kind === "send") {
            const landed: number[] = [];
            for (const [k, w] of [pinned, twin].entries()) {
              const result = w.store.sendMessage({
                project_id: w.project.id,
                author: agent(`ses_${step.session}`),
                body: step.ask ? ASK : "News",
                ...(step.name !== null ? { thread: `lane-${step.name}` } : {}),
              }).message;
              if (!threads[k]!.includes(result.thread_id)) threads[k]!.push(result.thread_id);
              landed.push(threads[k]!.indexOf(result.thread_id));
            }
            expect(landed[0]).toBe(landed[1]);
            continue;
          }
          if (step.kind === "resolve") {
            for (const [k, w] of [pinned, twin].entries()) {
              const id = threads[k]![step.thread];
              if (id) w.store.resolveThread(id, true);
            }
            continue;
          }
          // Pin operations run on one store only.
          const ids = threads[0]!;
          if (step.kind === "pin" && ids[step.thread]) pinned.store.setPinned(ids[step.thread]!, true);
          if (step.kind === "unpin" && ids[step.thread]) pinned.store.setPinned(ids[step.thread]!, false);
          if (step.kind === "order") pinned.store.orderPins(step.picks.map((i) => ids[i]).filter((id): id is string => id !== undefined));
          // Nothing but the pins moved.
          expect(pinned.store.cursor()).toBe(cursorBefore);
          expect(view(pinned.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
          const pins = pinned.store.pins().map((p) => p.thread_id);
          expect(new Set(pins).size).toBe(pins.length);
          for (const id of pins) expect(pinned.store.thread(id)).not.toBeNull();
        }
        expect(view(pinned.store, threads[0]!)).toEqual(view(twin.store, threads[1]!));
        expect(pinned.store.cursor()).toBe(twin.store.cursor());
      }),
      { numRuns: 60 },
    );
  });
});
