/**
 * Decision mode (approval "inbox-decision-mode", direction A "Queue";
 * experimental, off unless Settings → General → Experimental turns it on).
 *
 * One decision at a time in a large dialog, the next peeking behind it, a
 * progress strip of one chip per agent session. Picks save at once through
 * the existing picks route. Once a session's decisions in a thread are all
 * handled, its chip says "Sending in 5 s · Hold", and then its reply goes
 * through the existing reply route: one reply per agent session per thread
 * (`sendTargetsOf`, the skip and supersede rules unchanged). After a Send
 * the chip goes Delivered, then Working, then Replied.
 *
 * No new keyboard shortcuts: Tab, Enter, Space, the arrows inside a choice
 * group, and Escape, which walks out one layer at a time (an open field, the
 * close question, the overview, then the dialog).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImageLightbox } from '@plannotator/ui/components/ImageLightbox';
import type { InboxDecision, InboxListRow, InboxQuestion } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { InboxApiError, inboxApi } from '../api';
import { agentName, formatCount } from '../format';
import { HostMark, Icon } from '../icons';
import { prefersReducedMotion } from '../settle';
import { Tip } from '../components/Tip';
import { DecisionCard, type CardPicture } from './DecisionCard';
import {
  AFTER_SEND_ORDER,
  AFTER_SEND_WORDS,
  afterSendOf,
  answerWords,
  emptyQueue,
  groupHalfAnswered,
  groupIds,
  groupKeyOf,
  groupKeys,
  groupReady,
  groupSendTargets,
  headLine,
  isActionDecision,
  isHandled,
  leftCount,
  markReplaced,
  mergeDecisions,
  nextId,
  placeAfter,
  previousId,
  putOff,
  replacementOf,
  sessionChips,
  chipDomKey,
  type GroupSend,
  type QueueState,
  type SessionChip,
} from './model';

/** How long a session's reply waits before it goes, so the person can hold it (brief §9). */
export const DECISION_HOLD_MS = 5000;
/** The answer lands as a stamp before the card leaves (brief §7). */
const STAMP_MS = 350;

export interface DecisionModeProps {
  /** The dialog is on screen (false while tucked into the pill behind an open thread). */
  open: boolean;
  /** The latest projection (`GET /api/inbox/decisions`), null until read. */
  decisions: readonly InboxDecision[] | null;
  /** The list rows, by thread id: where a sent reply is (Delivered, Replied). */
  rows: ReadonlyMap<string, InboxListRow>;
  /** Start on this decision (a Stopped notification). */
  start?: string | null;
  phone: boolean;
  /** Read the projection again now. */
  refresh: () => void;
  /** The event stream's question lines (a replaced question swaps on screen). */
  subscribeQuestions: (listener: (question: InboxQuestion) => void) => () => void;
  /** Open the thread behind the dialog: decision mode tucks into a pill. */
  onTuck: (threadId: string, fileId?: string) => void;
  /** The sitting ends. */
  onClose: () => void;
  /** Tells the pill how many are left. */
  onLeft?: (left: number) => void;
}

interface UndoEntry {
  id: string;
  kind: 'pick' | 'action' | 'later';
  before: QuestionAnswer | null;
}

interface Banner {
  agent: string;
  withdrawn: boolean;
}

function isSuperseded(error: unknown): boolean {
  return error instanceof InboxApiError && (error.code === 'question_superseded' || error.status === 422);
}

export function DecisionMode(props: DecisionModeProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [queue, setQueue] = useState<QueueState>(emptyQueue);
  const queueRef = useRef(queue);
  queueRef.current = queue;
  const [sends, setSends] = useState<Map<string, GroupSend>>(new Map());
  const sendsRef = useRef(sends);
  sendsRef.current = sends;
  const sentGroups = useRef(new Set<string>());
  const sendKeys = useRef(new Map<string, string>());
  const [undo, setUndo] = useState<UndoEntry[]>([]);
  const [stamp, setStamp] = useState<{ id: string; value: QuestionAnswer | 'done' | 'cant' } | null>(null);
  const [banner, setBanner] = useState<Banner | null>(null);
  const pendingSwap = useRef<{ old: string; replacement: string } | null>(null);
  const [overview, setOverview] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [said, setSaid] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState<Map<string, boolean>>(new Map());
  const [lightbox, setLightbox] = useState<{ pictures: CardPicture[]; index: number } | null>(null);
  const pickChain = useRef<Promise<void>>(Promise.resolve());
  const revisions = useRef(new Map<string, number>());
  /** Decisions whose pick is on its way to the server. */
  const pendingPicks = useRef(new Set<string>());
  const fieldOpenRef = useRef<(() => boolean) | null>(null);
  const started = useRef(false);
  const escapedAt = useRef(0);
  const [touch, setTouch] = useState(false);
  const reduced = prefersReducedMotion();

  // ── The dialog itself: a native modal <dialog>, shown while open. ──
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      try {
        dialog.showModal();
      } catch {
        dialog.setAttribute('open', '');
      }
    } else if (!props.open && dialog.open) dialog.close();
  }, [props.open]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(hover: none) and (pointer: coarse)');
    setTouch(query.matches);
  }, []);

  // ── The projection folded in. ──
  useEffect(() => {
    if (!props.decisions) return;
    // The card on screen left the projection without the person's answer: ask its thread why
    // (the agent replaced it, or the thread was archived or answered elsewhere).
    const shown = queueRef.current.current;
    if (shown && !props.decisions.some((d) => d.id === shown) && !queueRef.current.gone.has(shown) && !isHandled(queueRef.current, shown)) void checkGone(shown);
    setQueue((current) => {
      let next = mergeDecisions(current, props.decisions!, sentGroups.current, pendingPicks.current);
      for (const d of props.decisions!) revisions.current.set(d.id, Math.max(revisions.current.get(d.id) ?? 0, d.question.revision));
      if (!started.current) {
        started.current = true;
        if (props.start && next.order.includes(props.start)) next = { ...next, current: props.start };
      }
      const swap = pendingSwap.current;
      if (swap && next.cache.has(swap.replacement)) {
        pendingSwap.current = null;
        next = placeAfter(next, swap.replacement, swap.old);
        if (next.current === swap.old || next.current === null || isHandled(next, next.current)) next = { ...next, current: swap.replacement };
      }
      const leftUnanswered = shown !== null && next.current === shown && next.gone.get(shown) === 'closed' && !isHandled(current, shown);
      if (!leftUnanswered && next.current !== null && isHandled(next, next.current) && !stampRef.current) next = { ...next, current: nextId(next, next.current) };
      return next;
    });
  }, [props.decisions, props.start]);

  const stampRef = useRef(stamp);
  stampRef.current = stamp;

  useEffect(() => props.onLeft?.(leftCount(queue)), [queue, props.onLeft]);

  // ── A question the agent replaced while the queue held it. ──
  const onReplaced = useCallback(
    (question: InboxQuestion) => {
      if (question.state !== 'superseded') return;
      const id = `${question.message_id}/${question.key}`;
      const state = queueRef.current;
      if (!state.order.includes(id) || state.gone.get(id) === 'replaced') return;
      const replacement = replacementOf(question);
      const old = state.cache.get(id);
      setQueue((current) => markReplaced(current, question));
      if (state.current === id) {
        setBanner({ agent: old ? agentLabel(old) : 'The agent', withdrawn: replacement === null });
        if (replacement) pendingSwap.current = { old: id, replacement };
        else setQueue((current) => ({ ...current, current: nextId(current, id) }));
      }
      props.refresh();
    },
    [props.refresh],
  );
  useEffect(() => props.subscribeQuestions(onReplaced), [props.subscribeQuestions, onReplaced]);

  /** Why the card on screen left: replaced (the banner and the swap), else the next card. */
  const checkGone = async (id: string) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    try {
      const { thread } = await inboxApi.thread(decision.thread.id);
      const question = thread.messages.flatMap((m) => [...(m.questions ?? []), ...(m.actions ?? [])]).find((q) => `${q.message_id}/${q.key}` === id);
      if (question?.state === 'superseded') return onReplaced(question);
    } catch {
      // The thread is gone (deleted): the next card.
    }
    setQueue((current) => (current.current === id ? { ...current, current: nextId(current, id) } : current));
  };

  // ── Each send group: ready → a 5 s Hold → its reply. ──
  useEffect(() => {
    setSends((current) => {
      let changed = false;
      const next = new Map(current);
      for (const key of groupKeys(queue)) {
        const state = next.get(key) ?? { kind: 'waiting' as const };
        const ready = groupReady(queue, key);
        if (ready && state.kind === 'waiting') {
          next.set(key, { kind: 'hold', until: Date.now() + DECISION_HOLD_MS });
          changed = true;
        } else if (!ready && (state.kind === 'hold' || state.kind === 'held')) {
          next.set(key, { kind: 'waiting' });
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [queue]);

  const holding = [...sends.values()].some((s) => s.kind === 'hold');
  useEffect(() => {
    if (!holding) return;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [holding]);

  const setSend = (key: string, value: GroupSend) => setSends((current) => new Map(current).set(key, value));

  const sendGroup = useCallback(async (key: string) => {
    const state = queueRef.current;
    const first = groupIds(state, key).map((id) => state.cache.get(id)).find((d): d is InboxDecision => d !== undefined);
    if (!first) return;
    const at = sendsRef.current.get(key);
    if (at?.kind === 'sending' || at?.kind === 'sent') return;
    setSend(key, { kind: 'sending' });
    try {
      await pickChain.current;
      const { thread } = await inboxApi.thread(first.thread.id);
      const targets = groupSendTargets(thread, first.session.key);
      for (const target of targets) {
        const keyId = `${key}\u0002${target.message.id}`;
        const idempotency = sendKeys.current.get(keyId) ?? crypto.randomUUID();
        sendKeys.current.set(keyId, idempotency);
        await inboxApi.reply(target.message.id, {
          idempotency_key: idempotency,
          words: '',
          questions: target.questions,
          ...(target.skip.length > 0 ? { skip: target.skip } : {}),
        });
      }
      sentGroups.current.add(key);
      setSend(key, { kind: 'sent', at: new Date().toISOString() });
      setSaid(`Sent ${agentLabel(first)} your answers.`);
      props.refresh();
    } catch (cause) {
      setSend(key, { kind: 'failed', error: cause instanceof InboxApiError ? cause.message : 'The reply was not sent.' });
      props.refresh();
    }
  }, [props.refresh]);

  // A Hold that ran out sends.
  useEffect(() => {
    for (const [key, state] of sends) if (state.kind === 'hold' && state.until <= now) void sendGroup(key);
  }, [now, sends, sendGroup]);

  // ── After a Send: is the agent working on it? (its connection, every 3 s while open) ──
  useEffect(() => {
    if (!props.open) return;
    const watch = () => {
      for (const [key, state] of sendsRef.current) {
        if (state.kind !== 'sent') continue;
        const first = groupIds(queueRef.current, key).map((id) => queueRef.current.cache.get(id)).find(Boolean);
        if (!first || !first.session.session) continue;
        const row = props.rows.get(first.thread.id);
        if (afterSendOf(row, state.at, null) === 'replied') continue;
        void inboxApi
          .sessions(first.thread.id, first.session.session)
          .then((model) => setBusy((current) => new Map(current).set(key, model.asker?.connection?.busy === true)))
          .catch(() => {});
      }
    };
    watch();
    const timer = setInterval(watch, 3000);
    return () => clearInterval(timer);
  }, [props.open, props.rows]);

  // ── Moving through the queue. ──
  const advance = (from: string) => {
    setQueue((current) => ({ ...current, current: nextId(current, from) }));
  };

  const land = (id: string, value: QuestionAnswer | 'done' | 'cant', words: string) => {
    setStamp({ id, value });
    setBanner(null);
    const left = leftCount(queueRef.current) - (isHandled(queueRef.current, id) ? 0 : 1);
    setSaid(`Answered: ${words}. ${left === 0 ? 'Nothing left.' : `${formatCount(Math.max(0, left))} left.`}`);
    setTimeout(
      () => {
        setStamp((current) => (current?.id === id ? null : current));
        advance(id);
      },
      reduced ? 0 : STAMP_MS,
    );
  };

  const savePick = (id: string, answer: QuestionAnswer | null) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    // Optimistic: the card is handled now; the saved copy replaces it.
    setQueue((current) => {
      const cache = new Map(current.cache);
      cache.set(id, { ...decision, question: { ...decision.question, state: answer ? 'picked' : 'open', answer } });
      return { ...current, cache, later: answer ? new Set([...current.later].filter((l) => l !== id)) : current.later };
    });
    setError(null);
    pendingPicks.current.add(id);
    pickChain.current = pickChain.current.then(async () => {
      const revision = Math.max(revisions.current.get(id) ?? 0, queueRef.current.cache.get(id)?.question.revision ?? 0);
      try {
        const result = await inboxApi.pick(decision.message.id, decision.question.key, revision, answer);
        const saved = result.questions.find((q) => q.key === decision.question.key);
        if (saved) {
          revisions.current.set(id, saved.revision);
          setQueue((current) => {
            const known = current.cache.get(id);
            if (!known) return current;
            return { ...current, cache: new Map(current.cache).set(id, { ...known, question: saved }) };
          });
        }
      } catch (cause) {
        if (!isSuperseded(cause)) setError(cause instanceof InboxApiError ? cause.message : 'The pick was not saved.');
        props.refresh();
      } finally {
        pendingPicks.current.delete(id);
      }
    });
  };

  const answer = (id: string, value: QuestionAnswer) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    setUndo((stack) => [...stack, { id, kind: 'pick', before: decision.question.state === 'picked' ? decision.question.answer : null }]);
    savePick(id, value);
    land(id, value, answerWords(value));
  };

  const act = (id: string, mark: { outcome: 'done' | 'cant'; note?: string }) => {
    const decision = queueRef.current.cache.get(id);
    if (!decision) return;
    setUndo((stack) => [...stack, { id, kind: 'action', before: null }]);
    setQueue((current) => {
      const cache = new Map(current.cache);
      cache.set(id, { ...decision, question: { ...decision.question, state: 'picked' } });
      return { ...current, cache, later: new Set([...current.later].filter((l) => l !== id)) };
    });
    pickChain.current = pickChain.current.then(async () => {
      try {
        await inboxApi.markAction(decision.message.id, decision.question.key, mark);
      } catch (cause) {
        setError(cause instanceof InboxApiError ? cause.message : 'That was not saved.');
        props.refresh();
      }
    });
    land(id, mark.outcome, mark.outcome === 'done' ? 'Done' : "Can't do it");
  };

  const later = (id: string) => {
    setUndo((stack) => [...stack, { id, kind: 'later', before: null }]);
    setBanner(null);
    setQueue((current) => putOff(current, id));
    setSaid('Put off until the end.');
  };

  const undoLast = () => {
    const entry = undo.at(-1);
    if (!entry) return;
    setUndo((stack) => stack.slice(0, -1));
    const decision = queueRef.current.cache.get(entry.id);
    if (!decision) return;
    const key = groupKeyOf(decision);
    if (sends.get(key)?.kind === 'sent' || sends.get(key)?.kind === 'sending') return;
    if (entry.kind === 'pick') savePick(entry.id, entry.before);
    if (entry.kind === 'action') {
      setQueue((current) => {
        const cache = new Map(current.cache);
        cache.set(entry.id, { ...decision, question: { ...decision.question, state: 'open' } });
        return { ...current, cache };
      });
      pickChain.current = pickChain.current.then(() => inboxApi.markAction(decision.message.id, decision.question.key, null).then(() => {}, () => {}));
    }
    if (entry.kind === 'later') setQueue((current) => ({ ...current, later: new Set([...current.later].filter((l) => l !== entry.id)) }));
    setStamp(null);
    setQueue((current) => ({ ...current, current: entry.id }));
    setSaid('Undone.');
  };

  // ── Closing: a session half answered asks first. ──
  const unsentGroups = () => groupKeys(queue).filter((key) => {
    const state = sends.get(key)?.kind;
    if (state === 'sent' || state === 'sending') return false;
    return groupHalfAnswered(queue, key) || state === 'hold' || state === 'held';
  });

  const requestClose = () => {
    if (unsentGroups().length > 0) setConfirm(true);
    else props.onClose();
  };

  const sendAnswered = async () => {
    setClosing(true);
    const keys = groupKeys(queue).filter((key) => {
      const state = sends.get(key)?.kind;
      if (state === 'sent' || state === 'sending') return false;
      return groupIds(queue, key).some((id) => !queue.gone.has(id) && queue.cache.get(id)?.question.state === 'picked' && !isActionDecision(queue.cache.get(id)!));
    });
    await Promise.all(keys.map((key) => sendGroup(key)));
    setClosing(false);
    props.onClose();
  };

  const keepDraft = () => {
    setSends((current) => {
      const next = new Map(current);
      for (const [key, state] of next) if (state.kind === 'hold' || state.kind === 'held') next.set(key, { kind: 'waiting' });
      return next;
    });
    props.onClose();
  };

  /** Escape: one layer at a time. */
  const escape = () => {
    if (lightbox) return;
    if (confirm) return setConfirm(false);
    if (fieldOpenRef.current?.()) return;
    if (overview) return setOverview(false);
    requestClose();
  };

  const chips = useMemo(() => sessionChips(queue), [queue]);
  const current = queue.current ? queue.cache.get(queue.current) ?? null : null;
  const peek = current ? nextId({ ...queue, later: new Set([...queue.later, current.id]) }, current.id) : null;
  const peekDecision = peek && peek !== current?.id ? queue.cache.get(peek) ?? null : null;
  const prev = previousId(queue, queue.current);
  const after = queue.order.filter((id) => id !== queue.current && !isHandled(queue, id)).length;
  const lastUndo = undo.at(-1);
  const undoable = lastUndo !== undefined && (() => {
    const d = queue.cache.get(lastUndo.id);
    const state = d ? sends.get(groupKeyOf(d))?.kind : undefined;
    return state !== 'sent' && state !== 'sending';
  })();
  const loaded = props.decisions !== null;
  const done = loaded && queue.current === null;

  return (
    <dialog
      ref={dialogRef}
      className="ib-dm"
      data-decision-mode=""
      data-phone={props.phone ? '' : undefined}
      aria-labelledby="ib-dm-title"
      onCancel={(event) => {
        // The browser's own cancel (Escape, a phone's back): one layer, once (the keydown below may have taken it).
        event.preventDefault();
        if (Date.now() - escapedAt.current > 100) escape();
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        escapedAt.current = Date.now();
        escape();
      }}
    >
      <div className="ib-dm-head">
        <h1 id="ib-dm-title">Decide</h1>
        <span className="ib-dm-count" data-decision-head="">
          {loaded ? headLine(queue) : 'Reading what waits on you…'}
        </span>
        <span className="ib-dm-headacts">
          {undoable && (
            <button type="button" className="ib-dm-lnk" data-decision-undo="" onClick={undoLast}>
              <Icon name="reply" size={15} />
              Undo
            </button>
          )}
          {!done && loaded && (
            <button type="button" className="ib-dm-lnk" aria-pressed={overview} data-decision-overview="" onClick={() => setOverview((v) => !v)}>
              All
            </button>
          )}
          <Tip content="Close">
            <button type="button" className="ib-dm-x" aria-label="Close decision mode" data-decision-close="" onClick={requestClose}>
              <Icon name="x" size={18} />
            </button>
          </Tip>
        </span>
      </div>
      <Strip chips={chips} sends={sends} rows={props.rows} busy={busy} now={now} queue={queue} onHold={(key) => setSend(key, { kind: 'held' })} onSendNow={(key) => void sendGroup(key)} />
      {error && (
        <div className="ib-error ib-dm-error" role="alert">
          {error}
        </div>
      )}
      <div className="ib-dm-stage">
        {overview ? (
          <Overview
            queue={queue}
            onPick={(id) => {
              setOverview(false);
              setQueue((state) => ({ ...state, current: id }));
            }}
          />
        ) : done ? (
          <EndScreen queue={queue} sends={sends} rows={props.rows} busy={busy} onClose={requestClose} />
        ) : current ? (
          <div className="ib-dm-deck" data-reduced={reduced ? '' : undefined}>
            {/* The next card peeks behind this one: an edge, nothing to read. */}
            {peekDecision && <div className="ib-dm-peek" aria-hidden="true" data-decision-peek="" />}
            <DecisionCard
              key={current.id}
              decision={current}
              phone={props.phone}
              touch={touch}
              stamp={stamp?.id === current.id ? stamp.value : null}
              fieldOpenRef={fieldOpenRef}
              banner={
                banner ? (
                  <div className="ib-dm-banner" role="status" data-decision-replaced="">
                    <Icon name="warn" size={16} />
                    <span>
                      <b>{banner.withdrawn ? `${banner.agent} withdrew the last question.` : `${banner.agent} replaced this question just now.`}</b> Your pick, if any, wasn&apos;t sent.
                    </span>
                  </div>
                ) : undefined
              }
              onAnswer={(value) => answer(current.id, value)}
              onAction={(mark) => act(current.id, mark)}
              onLater={() => later(current.id)}
              onOpenThread={(fileId) => props.onTuck(current.thread.id, fileId)}
              onImage={(pictures, index) => setLightbox({ pictures, index })}
            />
            <div className="ib-dm-nav">
              <button
                type="button"
                className="ib-dm-lnk"
                data-decision-previous=""
                disabled={prev === null}
                onClick={() => {
                  if (prev) {
                    setBanner(null);
                    setQueue((state) => ({ ...state, current: prev }));
                  }
                }}
              >
                <Icon name="back" size={15} />
                Previous
              </button>
              <span className="ib-dm-after">{after === 0 ? 'The last one' : `${formatCount(after)} more after this`}</span>
            </div>
          </div>
        ) : (
          <div className="ib-dm-loading">Reading what waits on you…</div>
        )}
      </div>
      {confirm && (
        <div className="ib-dm-confirm" role="alertdialog" aria-labelledby="ib-dm-confirm-t" aria-describedby="ib-dm-confirm-d" data-decision-confirm="">
          <h2 id="ib-dm-confirm-t">Some agents are half answered</h2>
          <p id="ib-dm-confirm-d">Send what you answered now, or keep it as a draft in each thread. Nothing you picked is lost either way.</p>
          <div className="ib-dm-confirm-acts">
            <button type="button" className="ib-btn" onClick={() => setConfirm(false)}>
              Keep deciding
            </button>
            <button type="button" className="ib-btn" data-decision-keep-draft="" onClick={keepDraft}>
              Keep as a draft
            </button>
            <button type="button" className="ib-btn ib-pri" data-decision-send-answered="" disabled={closing} autoFocus onClick={() => void sendAnswered()}>
              {closing ? 'Sending…' : 'Send what you answered'}
            </button>
          </div>
        </div>
      )}
      <div className="ib-sr" aria-live="polite" data-decision-live="">
        {said}
      </div>
      {lightbox &&
        createPortal(
          <ImageLightbox
            src={lightbox.pictures[lightbox.index]!.src}
            alt={lightbox.pictures[lightbox.index]!.name}
            images={lightbox.pictures.length > 1 ? lightbox.pictures.map((p) => ({ src: p.src, alt: p.name })) : undefined}
            onClose={() => setLightbox(null)}
          />,
          dialogRef.current ?? document.body,
        )}
    </dialog>
  );
}

function agentLabel(decision: InboxDecision): string {
  return agentName(decision.message.author);
}

/** What a chip says about its session's reply. */
function chipSend(chip: SessionChip, sends: ReadonlyMap<string, GroupSend>, rows: ReadonlyMap<string, InboxListRow>, busy: ReadonlyMap<string, boolean>, queue: QueueState, now: number):
  | { kind: 'none' }
  | { kind: 'hold'; key: string; seconds: number }
  | { kind: 'held'; key: string }
  | { kind: 'failed'; key: string; error: string }
  | { kind: 'words'; text: string; tone: 'quiet' | 'ok' } {
  for (const key of chip.groups) {
    const state = sends.get(key);
    if (state?.kind === 'hold') return { kind: 'hold', key, seconds: Math.max(1, Math.ceil((state.until - now) / 1000)) };
    if (state?.kind === 'held') return { kind: 'held', key };
    if (state?.kind === 'failed') return { kind: 'failed', key, error: state.error };
  }
  const sent = chip.groups.map((key) => ({ key, state: sends.get(key) })).filter((g) => g.state?.kind === 'sent' || g.state?.kind === 'sending');
  if (sent.length === 0) return { kind: 'none' };
  if (sent.some((g) => g.state!.kind === 'sending')) return { kind: 'words', text: 'Sending', tone: 'quiet' };
  const stages = sent.map((g) => {
    const first = groupIds(queue, g.key).map((id) => queue.cache.get(id)).find(Boolean);
    return afterSendOf(first ? rows.get(first.thread.id) : undefined, (g.state as { at: string }).at, busy.get(g.key) ?? null);
  });
  const least = stages.reduce((a, b) => (AFTER_SEND_ORDER.indexOf(a) <= AFTER_SEND_ORDER.indexOf(b) ? a : b));
  return { kind: 'words', text: AFTER_SEND_WORDS[least], tone: least === 'replied' || least === 'delivered' || least === 'working' ? 'ok' : 'quiet' };
}

function Strip(props: {
  chips: SessionChip[];
  sends: ReadonlyMap<string, GroupSend>;
  rows: ReadonlyMap<string, InboxListRow>;
  busy: ReadonlyMap<string, boolean>;
  now: number;
  queue: QueueState;
  onHold: (key: string) => void;
  onSendNow: (key: string) => void;
}) {
  return (
    <ol className="ib-dm-strip" aria-label="Agents waiting" data-decision-strip="">
      {props.chips.map((chip) => {
        const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue, props.now);
        const on = chip.dots.some((d) => d.state === 'current');
        const handled = chip.dots.filter((d) => d.state === 'done').length;
        return (
          <li key={chip.key} className="ib-dm-chip" data-on={on ? '' : undefined} data-decision-chip={chipDomKey(chip.key)} data-send={send.kind === 'words' ? send.text.toLowerCase() : send.kind}>
            <HostMark host={chip.host} />
            <span className="ib-dm-chipname">{chip.label}</span>
            <span className="ib-dm-dots" role="img" aria-label={`${chip.name}: ${formatCount(handled)} of ${formatCount(chip.dots.length)} answered`}>
              {chip.dots.map((dot) => (
                <i key={dot.id} data-state={dot.state} />
              ))}
            </span>
            {send.kind === 'hold' && (
              <span className="ib-dm-hold-l" data-decision-hold="">
                Sending in {send.seconds} s ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onHold(send.key)}>
                  Hold
                </button>
              </span>
            )}
            {send.kind === 'held' && (
              <span className="ib-dm-hold-l" data-decision-held="">
                Held ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onSendNow(send.key)}>
                  Send
                </button>
              </span>
            )}
            {send.kind === 'failed' && (
              <span className="ib-dm-hold-l ib-dm-bad">
                Not sent ·{' '}
                <button type="button" className="ib-dm-lnk" onClick={() => props.onSendNow(send.key)}>
                  Try again
                </button>
              </span>
            )}
            {send.kind === 'words' && (
              <span className={`ib-dm-state${send.tone === 'ok' ? ' ib-dm-ok' : ''}`} data-decision-chip-state={send.text.toLowerCase()}>
                {send.text}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The read-only overview ("All"): every decision of the sitting, by agent; a row jumps to its card. No bulk accept. */
function Overview({ queue, onPick }: { queue: QueueState; onPick: (id: string) => void }) {
  const chips = sessionChips(queue);
  return (
    <div className="ib-dm-all" data-decision-all="">
      {chips.map((chip) => (
        <section key={chip.key} className="ib-dm-allg" aria-label={`${chip.name} · ${chip.label}`}>
          <h2>
            <HostMark host={chip.host} />
            {chip.name} <span>· {chip.label}</span>
          </h2>
          <ul>
            {chip.dots.map((dot) => {
              const d = queue.cache.get(dot.id)!;
              const state = queue.gone.get(dot.id) === 'sent' || d.question.state === 'sent' ? 'Sent' : isHandled(queue, dot.id) ? answerWordsOf(d) : queue.later.has(dot.id) ? 'Later' : d.question.stopped !== null ? 'Stopped' : 'Open';
              return (
                <li key={dot.id}>
                  <button type="button" className="ib-dm-allrow" data-on={dot.state === 'current' ? '' : undefined} onClick={() => onPick(dot.id)}>
                    <span className="ib-dm-allp">{d.question.prompt}</span>
                    <span className="ib-dm-alls">{state}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function answerWordsOf(decision: InboxDecision): string {
  if (isActionDecision(decision)) return decision.question.action_result?.outcome === 'cant' ? "Can't do it" : 'Done';
  return answerWords(decision.question.answer);
}

/** The end: nothing waits, and what each agent did with its reply. */
function EndScreen(props: { queue: QueueState; sends: ReadonlyMap<string, GroupSend>; rows: ReadonlyMap<string, InboxListRow>; busy: ReadonlyMap<string, boolean>; onClose: () => void }) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  const chips = sessionChips(props.queue);
  const handled = props.queue.order.filter((id) => {
    const reason = props.queue.gone.get(id);
    return reason !== 'replaced' && reason !== 'closed';
  }).length;
  return (
    <div className="ib-dm-end" data-decision-end="">
      <span className="ib-dm-endmark" aria-hidden="true">
        <Icon name="check" size={28} />
      </span>
      <h2 ref={ref} tabIndex={-1}>
        Nothing waits on you
      </h2>
      <p>
        {formatCount(handled)} {handled === 1 ? 'decision' : 'decisions'}. Each agent gets one reply per thread.
      </p>
      {chips.length > 0 && (
        <ul className="ib-dm-endlist">
          {chips.map((chip) => {
            const send = chipSend(chip, props.sends, props.rows, props.busy, props.queue, Date.now());
            const words = send.kind === 'words' ? send.text : send.kind === 'hold' ? `Sending in ${send.seconds} s` : send.kind === 'held' ? 'Held' : send.kind === 'failed' ? 'Not sent' : 'Nothing to send';
            return (
              <li key={chip.key} data-decision-end-row={chipDomKey(chip.key)}>
                <HostMark host={chip.host} />
                <span>
                  <b>{chip.name}</b> · {chip.label}
                </span>
                <span className="ib-dm-endstate">{words}</span>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="ib-btn ib-pri" data-decision-back="" onClick={props.onClose}>
        Back to the Inbox
      </button>
    </div>
  );
}
