/**
 * The one place the Inbox window writes a server URL. Every `/api/inbox/...`
 * request, EventSource and attachment `src` goes through `inboxUrl`, so
 * routing another machine's threads touches this file alone.
 * `tests/inbox-url-helper.test.ts` fails on a raw `/api/inbox` string elsewhere.
 *
 * Linked machines (docs/agent-guides/inbox-machines.md): a thread lives on the
 * machine whose agent started it. Its routes go to that machine through this
 * Inbox's forward, `/api/inbox/m/<machine>/<door route>`; the door's routes are
 * the window's own paths after `/api/inbox/`. Which machine owns an id is
 * learned from what that machine sent (its list rows, its projects, its
 * thread reads): every id is a ULID, so an id names one machine's record.
 */

/** This Inbox's own machine id (`ibx_…`), from the merged list; null before it (or from an Inbox that cannot link). */
let selfMachine: string | null = null;
/** Ids that belong to another machine, and which. An id never seen here is this Inbox's. */
const owners = new Map<string, string>();
/**
 * Ids this Inbox's own answers named (its rows in the merged list, its own thread reads). Local evidence wins for
 * good: no other machine's answer can claim one of these, so a linked machine never takes over a local route.
 */
const local = new Set<string>();
/** Ids the merged list attributed to a machine. */
const listed = new Set<string>();

const MACHINE_ID = /^ibx_[0-9A-HJKMNP-TV-Z]{26}$/;

/** This Inbox's id, as the merged list names it. */
export function setSelfMachine(id: string | null | undefined): void {
  if (typeof id === 'string' && MACHINE_ID.test(id)) selfMachine = id;
}

/**
 * Remember that `ids` belong to `machine` (nothing for this Inbox's own, or for no machine). An id this Inbox named
 * stays this Inbox's, and an id another machine already holds stays with it: a linked machine can claim only ids
 * nobody else holds, never shadow a local one or another machine's.
 */
export function rememberMachine(ids: Iterable<string>, machine: string | null | undefined, fromList = false): void {
  if (!machine || machine === selfMachine || !MACHINE_ID.test(machine)) return;
  for (const id of ids) {
    if (!id || local.has(id)) continue;
    // The merged list (`fromList`) is this Inbox's own account of which link sent which row: it settles an earlier
    // claim from an answer or a frame.
    if (fromList ? listed.has(id) && owners.get(id) !== machine : owners.has(id)) continue;
    owners.set(id, machine);
    if (fromList) listed.add(id);
  }
}

/** Ids this Inbox's own answers named: theirs for good (an earlier claim by another machine is dropped). */
export function rememberLocal(ids: Iterable<string>): void {
  for (const id of ids) {
    if (!id) continue;
    local.add(id);
    owners.delete(id);
    listed.delete(id);
  }
}

/** The machine that owns `id`, or null for this Inbox. */
export function machineOf(id: string | null | undefined): string | null {
  return (id && owners.get(id)) ?? null;
}

/** Tests only: forget every machine. */
export function resetMachineRoutes(): void {
  selfMachine = null;
  owners.clear();
  local.clear();
  listed.clear();
}

/**
 * `path` is the part after `/api/inbox` and starts with `/` (it may carry its own `?query`); `query` is already
 * encoded, without the `?`. `machine`: another machine's id, for a route of one of its threads; null or this
 * Inbox's own id is this Inbox.
 */
export function inboxUrl(path: string, query?: string, machine?: string | null): string {
  const tail = `${path}${query ? `${path.includes('?') ? '&' : '?'}${query}` : ''}`;
  if (machine && machine !== selfMachine) return `/api/inbox/m/${machine}${tail}`;
  return `/api/inbox${tail}`;
}
