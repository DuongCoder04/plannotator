import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Menu } from '@base-ui/react/menu';
import { Popover } from '@base-ui/react/popover';
import type { InboxMessageWire, InboxTidyPlan, InboxTidyRun, InboxTidyRunAgent } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { formatCount } from '../format';
import { HostMark, Icon } from '../icons';

/**
 * Tidy (owner-approved design, 2026-10-28): the ⋮ menu in the list's and the
 * Board's header holds "Tidy N" and "Refresh". Tidy opens a small popover
 * (a sheet on a phone): one checkbox per agent with its count, one Tidy
 * button, the reasons, ended sessions and unsent picks behind Details. A run
 * shows as one quiet line at the top of the list. No shortcut, no schedule.
 */

export type TidySurface = 'list' | 'board';

export interface TidyController {
  surface: TidySurface;
  scope: string | null;
  plan: InboxTidyPlan | null;
  /** The last run, unless the person closed its line. */
  run: InboxTidyRun | null;
  start: (sessions: readonly string[], key: string) => Promise<string | null>;
  dismiss: () => void;
  refresh: () => void;
}

const DISMISSED_KEY = 'plannotator-inbox-tidy-closed';
/** How long the window polls a run's progress. */
const TIDY_POLL_MS = 10 * 60_000;

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/** Reads who Tidy would ask in `scope` again whenever `version` changes (a list or Board read), and every few seconds while a run is under way. */
export function useTidy(scope: string | null, surface: TidySurface, version: unknown, enabled = true): TidyController {
  const [plan, setPlan] = useState<InboxTidyPlan | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(() => readDismissed());
  const seq = useRef(0);
  const refresh = useCallback(() => {
    const mine = ++seq.current;
    inboxApi
      .tidy(scope, surface)
      .then((next) => {
        if (mine === seq.current) setPlan(next);
      })
      .catch(() => {});
  }, [scope, surface]);
  useEffect(() => {
    if (!enabled) return;
    const timer = setTimeout(refresh, 250);
    return () => clearTimeout(timer);
  }, [refresh, version, enabled]);
  const run = plan?.run && plan.run.id !== dismissed ? plan.run : null;
  // Poll while a run goes, for 10 minutes at most: an agent that cannot say it
  // is done (Codex, MCP only) would otherwise keep it going all day. List and
  // Board reads (`version`) still read it after that.
  const underway = run !== null && run.done < run.agents.length;
  const runAt = run ? Date.parse(run.at) : 0;
  useEffect(() => {
    if (!underway || !enabled) return;
    const left = runAt + TIDY_POLL_MS - Date.now();
    if (left <= 0) return;
    const timer = setInterval(refresh, 5000);
    const stop = setTimeout(() => clearInterval(timer), left);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
  }, [underway, runAt, refresh, enabled]);
  const start = useCallback(
    async (sessions: readonly string[], key: string): Promise<string | null> => {
      try {
        const answer = await inboxApi.startTidy({ sessions, idempotency_key: key, project: scope, surface });
        setDismissed(null);
        setPlan((current) => (current ? { ...current, run: answer.run } : current));
        refresh();
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : 'Tidy did not start.';
      }
    },
    [scope, surface, refresh],
  );
  const dismiss = useCallback(() => {
    const id = plan?.run?.id ?? null;
    setDismissed(id);
    try {
      if (id) localStorage.setItem(DISMISSED_KEY, id);
    } catch {
      // Private mode: closed for this tab only.
    }
  }, [plan?.run?.id]);
  return { surface, scope, plan, run, start, dismiss, refresh };
}

/** The run the menu and the popover show: only while nothing new is offered (new work shows the plan, the run stays on the line). */
const shownRun = (tidy: TidyController): InboxTidyRun | null => (tidy.run && (tidy.plan?.count ?? 0) === 0 ? tidy.run : null);

/** "Tidy · 3/4" while a run shows. */
const runLabel = (run: InboxTidyRun) => `Tidy · ${run.done}/${run.agents.length}`;

/**
 * The header's ⋮: Tidy (with its count, or the run's progress) and Refresh.
 * `className` places it in its header (the list's or the Board's).
 */
export function TidyMenu({
  tidy,
  phone,
  onRefresh,
  onSetAside,
  className,
}: {
  tidy: TidyController;
  phone: boolean;
  onRefresh: () => void;
  /** Ended sessions' threads: Mark read on them, with one Undo (the host's toast). Absent: not offered. */
  onSetAside?: (threadIds: readonly string[]) => void;
  className: string;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [popOpen, setPopOpen] = useState(false);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const { plan } = tidy;
  const count = plan?.count ?? 0;
  const run = shownRun(tidy);
  // Still reading (plan null): enabled, so the menu does not flash disabled on load.
  const canOpen = plan === null || run !== null || count > 0;
  return (
    <>
      <Menu.Root open={menuOpen} onOpenChange={setMenuOpen} modal={false}>
        <Menu.Trigger ref={trigger} className={`ib-tidytrig ${className}`} aria-label="More" data-tidy-menu="" data-open={popOpen ? '' : undefined}>
          <Icon name="dots" size={phone ? 20 : 18} />
        </Menu.Trigger>
        <Menu.Portal container={portal ?? undefined}>
          {phone && <Menu.Backdrop className="ib-pm-scrim" />}
          <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
            <Menu.Popup className="ib-pm" aria-label={tidy.surface === 'board' ? 'Board' : 'Inbox'} data-tidy-menu-popup="">
              <div className="ib-pm-title" aria-hidden="true">
                {tidy.surface === 'board' ? 'Board' : 'Inbox'}
              </div>
              <Menu.Item
                className="ib-pmi"
                label="Tidy"
                disabled={!canOpen}
                data-tidy-item=""
                onClick={() => {
                  setMenuOpen(false);
                  tidy.refresh();
                  setPopOpen(true);
                }}
              >
                <Icon name="todo" size={15} />
                {run ? runLabel(run) : 'Tidy'}
                {!run && count > 0 && <span className="ib-pmi-n">{formatCount(count)}</span>}
              </Menu.Item>
              <Menu.Item className="ib-pmi" label="Refresh" data-tidy-refresh="" onClick={onRefresh}>
                <Icon name="refresh" size={15} />
                Refresh
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <Popover.Root open={popOpen} onOpenChange={setPopOpen} modal={phone}>
        <Popover.Portal container={portal ?? undefined}>
          {phone && <Popover.Backdrop className="ib-pm-scrim" />}
          <Popover.Positioner className="ib-tidy-pos" anchor={trigger} side="bottom" align="end" sideOffset={6} data-phone={phone ? '' : undefined}>
            <Popover.Popup className="ib-tidy" aria-label="Tidy" finalFocus={trigger} data-tidy-popover="">
              {popOpen && <TidyPanel tidy={tidy} onSetAside={onSetAside} onDone={() => setPopOpen(false)} />}
            </Popover.Popup>
          </Popover.Positioner>
        </Popover.Portal>
      </Popover.Root>
    </>
  );
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`;

function TidyPanel({ tidy, onSetAside, onDone }: { tidy: TidyController; onSetAside?: (threadIds: readonly string[]) => void; onDone: () => void }) {
  const { plan } = tidy;
  const run = shownRun(tidy);
  const [details, setDetails] = useState(false);
  const [off, setOff] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // One key per opening: a second press (or a retry) answers the same run.
  const [key] = useState(() => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tidy-${Date.now()}-${Math.random()}`));
  if (run) return <RunPanel run={run} />;
  if (!plan) return <div className="ib-tidy-top"><b>Tidy</b></div>;
  if (plan.agents.length === 0)
    return (
      <div className="ib-tidy-top" data-tidy-empty="">
        <b>Tidy</b>
        <span>Nothing to ask</span>
      </div>
    );
  const agents = plan.agents;
  const picked = agents.filter((a) => !off.has(a.session));
  const allThreads = agents.every((a) => a.items.every((i) => i.thread_id !== null));
  const later = agents.filter((a) => a.reach === 'next_call');
  return (
    <>
      <div className="ib-tidy-top">
        <b>Tidy</b>
        <span>{plural(plan.count, allThreads ? 'thread' : 'item')}</span>
      </div>
      <ul className="ib-tidy-ags">
        {agents.map((agent) => (
          <li key={agent.session}>
            <label className="ib-tidy-ag" data-tidy-agent={agent.session}>
              <input
                type="checkbox"
                checked={!off.has(agent.session)}
                onChange={(event) =>
                  setOff((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.delete(agent.session);
                    else next.add(agent.session);
                    return next;
                  })
                }
              />
              <HostMark host={agent.host} />
              <span className="ib-tidy-nm">{agent.name}</span>
              <em>
                {agent.reach === 'next_call' && <Icon name="clock" size={13} />}
                {formatCount(agent.items.length)}
              </em>
            </label>
            {details && (
              <ul className="ib-tidy-det">
                {agent.items.map((item) => (
                  <li key={item.thread_id ?? item.subject}>
                    <b dir="auto">{item.subject}</b> · {item.reasons.join(' · ')}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      {details && (
        <>
          {plan.ended.length > 0 && (
            <div className="ib-tidy-note" data-tidy-ended="">
              {plural(plan.ended.length, 'thread')} · session ended
              {onSetAside && (
                <button
                  type="button"
                  className="ib-btn ib-sm"
                  onClick={() => {
                    onSetAside(plan.ended.map((t) => t.thread_id));
                    onDone();
                  }}
                >
                  Set aside
                </button>
              )}
            </div>
          )}
          {plan.unsent_picks > 0 && (
            <div className="ib-tidy-note" data-tidy-picks="">
              {plural(plan.unsent_picks, 'unsent pick')} · left for you
            </div>
          )}
          {later.map((agent) => (
            <div key={agent.session} className="ib-tidy-note">
              <Icon name="clock" size={13} /> {agent.name}: at its next Inbox call
            </div>
          ))}
        </>
      )}
      {error && (
        <p className="ib-tidy-err" role="alert">
          {error}
        </p>
      )}
      <div className="ib-tidy-bot">
        <button type="button" className="ib-tidy-more" aria-expanded={details} onClick={() => setDetails((d) => !d)} data-tidy-details="">
          <Icon name="chevR" size={14} />
          Details
        </button>
        <button
          type="button"
          className="ib-btn ib-pri ib-sm"
          disabled={picked.length === 0 || sending}
          data-tidy-go=""
          onClick={async () => {
            setSending(true);
            const failed = await tidy.start(
              picked.map((a) => a.session),
              key,
            );
            setSending(false);
            if (failed) setError(failed);
            else onDone();
          }}
        >
          Tidy
        </button>
      </div>
    </>
  );
}

/** Where each asked agent stands. */
function runState(agent: InboxTidyRunAgent): string {
  switch (agent.state) {
    case 'waiting':
      return agent.reach === 'next_call' ? 'At its next Inbox call' : 'Waiting';
    case 'delivered':
      return 'Delivered';
    case 'tidied':
      return agent.updated > 0 ? `${plural(agent.updated, 'thread')} updated` : 'Updated';
    case 'nothing':
      return 'Nothing to change';
  }
}

function RunPanel({ run }: { run: InboxTidyRun }) {
  return (
    <>
      <div className="ib-tidy-top">
        <b>{runLabel(run)}</b>
        <span>{plural(run.updated, 'thread')} updated</span>
      </div>
      <ul className="ib-tidy-ags">
        {run.agents.map((agent) => (
          <li key={agent.session} className="ib-tidy-ag ib-tidy-run" data-tidy-run-agent={agent.session} data-state={agent.state}>
            <span />
            <HostMark host={agent.host} />
            <span className="ib-tidy-nm">{agent.name}</span>
            <em>{runState(agent)}</em>
          </li>
        ))}
      </ul>
    </>
  );
}

/** The one quiet line at the top of the list while (and after) a run goes. */
export function TidyLine({ tidy }: { tidy: TidyController }) {
  const { run } = tidy;
  if (!run) return null;
  return (
    <div className="ib-tidyline" role="status" data-tidy-line="">
      <Icon name="todo" size={15} />
      <span className="ib-tidyline-t">
        {runLabel(run)}
        {run.updated > 0 && <span> · {plural(run.updated, 'thread')} updated</span>}
      </span>
      <button type="button" aria-label="Close" onClick={tidy.dismiss} data-tidy-line-close="">
        <Icon name="x" size={14} />
      </button>
    </div>
  );
}

/** A Tidy note in its thread: one quiet line, what was sent behind a fold. */
export function TidyNote({ message, agent }: { message: InboxMessageWire; agent: string }) {
  return (
    <div className="ib-reask" data-tidy-note="">
      <p className="ib-reask-l">
        <Icon name="todo" size={15} />
        <span>Tidy sent to {agent}</span>
      </p>
      <details className="ib-reask-d">
        <summary>What was sent</summary>
        <pre>{`Plannotator Inbox: Tidy (${message.id})\n${message.body}`}</pre>
      </details>
    </div>
  );
}
