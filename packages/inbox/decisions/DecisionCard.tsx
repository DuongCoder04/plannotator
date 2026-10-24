/**
 * One decision card of decision mode (approval "inbox-decision-mode", the
 * Queue direction; experimental). Who and where, the prompt, why it waits,
 * the context, the pictures, the answers, then the secondary actions, in
 * that order (brief §7, the screen reader order).
 *
 * Only today's question grammar is drawn. The agent contract lines the brief
 * proposes (Stakes, Shows, Why, Reversible, picture choices) are not approved
 * yet: `cardFacts` is where they will be read, and the card already has a
 * place for each (the stakes line under the prompt, the hero picture, the
 * "Why" line under the answers, a confirm step for an irreversible answer).
 */
import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { Viewer } from '@plannotator/ui/components/Viewer';
import { InlineMarkdown } from '@plannotator/ui/components/InlineMarkdown';
import { parseMarkdownToBlocks } from '@plannotator/ui/utils/parser';
import type { InboxDecision, InboxQuestion } from '@plannotator/core/inbox-types';
import { readInboxQuestionKind } from '@plannotator/core/inbox-types';
import type { QuestionAnswer } from '@plannotator/core/question-block';
import { agentName, formatCount, shortTime } from '../format';
import { HostMark, Icon } from '../icons';
import { inboxMessageImageBase } from '../images';
import { Tip } from '../components/Tip';
import { answerWords, choiceAnswer, otherAnswer, skipAnswer, swipeChoices, textAnswer } from './model';

/**
 * The facts a card shows beyond today's grammar. Today every field is null:
 * the contract lines are not approved (question msg_01M5QP72AV0GBSQX7X8GH5KTJT
 * in the owner's Inbox). When they are, read them from the question here and
 * the card draws them where its comments say.
 */
export interface CardFacts {
  /** `Stakes:` — the bold line under the prompt. */
  stakes: string | null;
  /** `Why:` — under the answers. */
  why: string | null;
  /** `Reversible: no — <why>` — a confirm step, and never a swipe. */
  irreversible: string | null;
}

export function cardFacts(_decision: InboxDecision): CardFacts {
  return { stakes: null, why: null, irreversible: null };
}

/** A picture the card shows: a captured image of the message, or an image file it attached. */
export interface CardPicture {
  attachmentId: string;
  name: string;
  /** The src the context wrote it as, when it came from there (left out of the context, shown as the hero). */
  ref: string | null;
  src: string;
}

export function cardPictures(decision: InboxDecision): CardPicture[] {
  const out: CardPicture[] = decision.pictures.inline.map((image) => ({
    attachmentId: image.attachment_id,
    name: image.name,
    ref: image.ref,
    src: `/api/inbox/attachments/${encodeURIComponent(image.attachment_id)}/image`,
  }));
  for (const file of decision.pictures.attachments) {
    if (file.kind !== 'image') continue;
    out.push({ attachmentId: file.attachment_id, name: file.name, ref: null, src: `/api/inbox/attachments/${encodeURIComponent(file.attachment_id)}/image` });
  }
  return out;
}

/**
 * The context without what the card draws apart: the images (the hero and its
 * strip), and the `Stopped:` and `Holds up:` lines (drawn as their own lines
 * under the prompt; the server reads them from the context the same way).
 */
function contextWithout(context: string, refs: readonly string[]): string {
  let out = context
    .split('\n')
    .filter((line) => !/^\s*(?:stopped|holds up)\s*:/i.test(line))
    .join('\n');
  for (const ref of refs) {
    const escaped = ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`!\\[[^\\]]*\\]\\(\\s*<?${escaped}>?(?:\\s+"[^"]*")?\\s*\\)`, 'g'), '');
    out = out.replace(new RegExp(`<img\\b[^>]*\\bsrc=["']${escaped}["'][^>]*>`, 'gi'), '');
  }
  return out.trim();
}

const noop = () => {};
const NO_ANNOTATIONS: never[] = [];

/** The context drawn as markdown, read only, with the message's images. */
function Context({ markdown, messageId, onImage }: { markdown: string; messageId: string; onImage: (src: string, alt: string) => void }) {
  const blocks = useMemo(() => parseMarkdownToBlocks(markdown, { frontmatter: false }), [markdown]);
  if (!markdown) return null;
  return (
    <div className="ib-body ib-dm-ctx" data-decision-context="">
      <Viewer
        blocks={blocks}
        markdown={markdown}
        annotations={NO_ANNOTATIONS}
        onAddAnnotation={noop}
        onSelectAnnotation={noop}
        selectedAnnotationId={null}
        mode="selection"
        taterMode={false}
        maxWidth={null}
        stickyActions={false}
        disableCodePathValidation
        imageBaseDir={inboxMessageImageBase(messageId)}
        onImageClick={onImage}
        questionDecisionLines={false}
        answerOnly
        readOnly
      />
    </div>
  );
}

export interface DecisionCardProps {
  decision: InboxDecision;
  /** The banner over the card when the agent replaced the question on screen. */
  banner?: ReactNode;
  /** The pick just made (the stamp): the card shows it while it leaves. */
  stamp: QuestionAnswer | 'done' | 'cant' | null;
  phone: boolean;
  touch: boolean;
  /** Answer the question (a pick, saved at once). */
  onAnswer: (answer: QuestionAnswer) => void;
  /** An action item's Done, or Can't do it with the reason. */
  onAction: (mark: { outcome: 'done' | 'cant'; note?: string }) => void;
  onLater: () => void;
  onOpenThread: (fileId?: string) => void;
  onImage: (pictures: CardPicture[], index: number) => void;
  /** Escape walked out of a field the card opened: report it so the dialog does not close too. */
  fieldOpenRef: { current: (() => boolean) | null };
}

export function DecisionCard(props: DecisionCardProps) {
  const { decision } = props;
  const q = decision.question;
  const kind = readInboxQuestionKind(q.kind);
  const facts = cardFacts(decision);
  const pictures = cardPictures(decision);
  const promptId = useId();
  const promptRef = useRef<HTMLHeadingElement>(null);
  const saved = q.state === 'picked' ? q.answer : null;
  const [selected, setSelected] = useState<string[]>(() => initialSelection(q));
  const [field, setField] = useState<'none' | 'other' | 'note' | 'cant'>(() => (saved?.other ? 'other' : saved?.note ? 'note' : 'none'));
  const [other, setOther] = useState(saved?.other ?? '');
  const [note, setNote] = useState(saved?.note ?? '');
  const [text, setText] = useState(saved?.text ?? '');
  const [reason, setReason] = useState('');
  const pointer = useRef(false);
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const [drag, setDrag] = useState(0);
  const choices2 = facts.irreversible ? null : swipeChoices(q);

  // Escape inside a field the card opened closes the field first.
  props.fieldOpenRef.current = () => {
    if (field === 'none') return false;
    setField('none');
    return true;
  };

  useEffect(() => {
    promptRef.current?.focus({ preventScroll: true });
  }, [decision.id]);

  const commitChoice = (labels: readonly string[]) => {
    if (labels.length === 0) return;
    props.onAnswer(choiceAnswer(q, labels, note));
  };

  const author = decision.message.author;
  const name = agentName(author);
  const badge = q.stopped !== null ? <span className="ib-badge ib-b-stop">Stopped</span> : q.holds_up.length > 0 ? <span className="ib-badge ib-b-hold">Holds up {formatCount(q.holds_up.length)}</span> : null;
  const heroRefs = pictures.map((p) => p.ref).filter((r): r is string => r !== null);
  const context = contextWithout(q.context ?? '', heroRefs);
  const files = decision.pictures.attachments.filter((f) => f.kind !== 'image');

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!choices2 || event.pointerType !== 'touch' || props.stamp) return;
    swipe.current = { x: event.clientX, y: event.clientY, id: event.pointerId };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    if (!start || start.id !== event.pointerId) return;
    const dx = event.clientX - start.x;
    if (Math.abs(event.clientY - start.y) > Math.abs(dx) && Math.abs(dx) < 12) return;
    setDrag(dx);
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = swipe.current;
    swipe.current = null;
    if (!start || start.id !== event.pointerId || !choices2) return setDrag(0);
    const dx = event.clientX - start.x;
    setDrag(0);
    if (Math.abs(dx) < 90) return;
    commitChoice([dx > 0 ? choices2[0] : choices2[1]]);
  };

  return (
    <article
      className="ib-dm-card"
      aria-labelledby={promptId}
      data-decision-card={decision.id}
      data-kind={kind}
      data-has-picture={pictures.length > 0 ? '' : undefined}
      data-stamped={props.stamp ? '' : undefined}
      style={drag ? { translate: `${drag}px 0`, rotate: `${drag / 40}deg` } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={() => {
        swipe.current = null;
        setDrag(0);
      }}
    >
      {props.banner}
      {pictures.length > 0 && (
        <div className="ib-dm-pics" data-decision-pictures="">
          <button type="button" className="ib-dm-hero" onClick={() => props.onImage(pictures, 0)} aria-label={`Open ${pictures[0]!.name} large`}>
            <img src={pictures[0]!.src} alt="" />
            <span className="ib-dm-zoom" aria-hidden="true">
              <Icon name="expand" size={14} />
              Open large
            </span>
          </button>
          {pictures.length > 1 && (
            <div className="ib-dm-thumbs">
              {pictures.slice(1).map((p, i) => (
                <button key={p.attachmentId} type="button" className="ib-dm-thumb" onClick={() => props.onImage(pictures, i + 1)} aria-label={`Open ${p.name} large`}>
                  <img src={p.src} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="ib-dm-main">
        {/* Who and where. */}
        <div className="ib-dm-who">
          <HostMark host={author.kind === 'agent' ? author.host : null} />
          <b>{name}</b>
          <span>· {decision.thread.project.name}</span>
          {decision.thread.subject && (
            <Tip content={decision.thread.subject} cut>
              <span className="ib-dm-subj">· {decision.thread.subject}</span>
            </Tip>
          )}
          <span>· {shortTime(decision.message.created_at)}</span>
          {badge}
        </div>
        <h2 id={promptId} ref={promptRef} tabIndex={-1} className="ib-dm-prompt" data-decision-prompt="">
          <InlineMarkdown text={q.prompt} />
        </h2>
        {/* The stakes line (`Stakes:`) goes here once the contract lines are approved. */}
        {facts.stakes && (
          <p className="ib-dm-stakes">
            <Icon name="warn" size={16} />
            {facts.stakes}
          </p>
        )}
        {q.stopped !== null && (
          <p className="ib-dm-stop" data-decision-stopped="">
            <Icon name="warn" size={16} />
            <span>Stopped{q.stopped ? `: ${q.stopped}` : ''}</span>
          </p>
        )}
        {q.holds_up.length > 0 && (
          <p className="ib-dm-hold">
            <Icon name="clock" size={16} />
            <span>Holds up {q.holds_up.join(', ')}</span>
          </p>
        )}
        {decision.message.excerpt && <p className="ib-dm-excerpt">{decision.message.excerpt}</p>}
        <Context markdown={context} messageId={decision.message.id} onImage={(src, alt) => props.onImage([{ attachmentId: '', name: alt || 'image', ref: null, src }], 0)} />
        <div className="ib-dm-refs">
          {files.map((file) => (
            <button key={file.attachment_id} type="button" className="ib-dm-file" onClick={() => props.onOpenThread(file.attachment_id)}>
              <Icon name="doc" size={15} />
              <span>{file.name}</span>
            </button>
          ))}
          <button type="button" className="ib-dm-open" data-decision-open-thread="" onClick={() => props.onOpenThread()}>
            <Icon name="comment" size={15} />
            Open the thread
          </button>
        </div>

        {/* The answers. */}
        <div className="ib-dm-answers" onPointerDownCapture={() => (pointer.current = true)} onKeyDownCapture={() => (pointer.current = false)}>
          {kind === 'single' && (
            <fieldset className={`ib-dm-choices${q.choices.length === 2 ? ' ib-dm-two' : ''}`} aria-labelledby={promptId}>
              {q.choices.map((choice) => {
                const on = selected.includes(choice.label);
                const isSaved = saved?.selected.includes(choice.label) === true;
                return (
                  <label key={choice.label} className="ib-dm-choice" data-on={on ? '' : undefined} data-recommended={choice.recommended ? '' : undefined} data-saved={isSaved ? '' : undefined}>
                    <input
                      type="radio"
                      name={`ib-dm-${decision.id}`}
                      value={choice.label}
                      checked={on}
                      onChange={() => setSelected([choice.label])}
                      // A click (or a tap) answers at once; the arrow keys only move the choice, Enter or Space answers.
                      onClick={() => {
                        if (pointer.current) commitChoice([choice.label]);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          commitChoice([choice.label]);
                        }
                      }}
                    />
                    <span className="ib-dm-dot" aria-hidden="true" />
                    <span className="ib-dm-ch">
                      <span className="ib-dm-chl">
                        <InlineMarkdown text={choice.label} />
                      </span>
                      {choice.description && (
                        <span className="ib-dm-chd">
                          <InlineMarkdown text={choice.description} />
                        </span>
                      )}
                    </span>
                    {choice.recommended && <span className="ib-dm-rec">Recommended</span>}
                  </label>
                );
              })}
            </fieldset>
          )}
          {kind === 'multi' && (
            <fieldset className="ib-dm-choices" aria-labelledby={promptId}>
              {q.choices.map((choice) => {
                const on = selected.includes(choice.label);
                return (
                  <label key={choice.label} className="ib-dm-choice ib-dm-check" data-on={on ? '' : undefined} data-recommended={choice.recommended ? '' : undefined}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setSelected((current) => (current.includes(choice.label) ? current.filter((l) => l !== choice.label) : [...current, choice.label]))}
                    />
                    <span className="ib-dm-box" aria-hidden="true" />
                    <span className="ib-dm-ch">
                      <span className="ib-dm-chl">
                        <InlineMarkdown text={choice.label} />
                      </span>
                      {choice.description && (
                        <span className="ib-dm-chd">
                          <InlineMarkdown text={choice.description} />
                        </span>
                      )}
                    </span>
                    {choice.recommended && <span className="ib-dm-rec">Recommended</span>}
                  </label>
                );
              })}
            </fieldset>
          )}
          {kind === 'multi' && (
            <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" disabled={selected.length === 0} onClick={() => commitChoice(selected)}>
              Answer with {formatCount(selected.length)}
            </button>
          )}
          {kind === 'single' && selected.length > 0 && !(saved && sameSet(saved.selected, selected) && !saved.other) && (
            <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" onClick={() => commitChoice(selected)}>
              Answer
            </button>
          )}
          {kind === 'text' && (
            <div className="ib-dm-text">
              {q.suggested_text && (
                <div className="ib-dm-suggest">
                  <span>
                    <b>Suggested:</b> {q.suggested_text}
                  </span>
                  <button type="button" className="ib-btn ib-sm" onClick={() => setText(q.suggested_text ?? '')}>
                    Use
                  </button>
                </div>
              )}
              <textarea className="ib-dm-ta" aria-labelledby={promptId} value={text} rows={3} onChange={(event) => setText(event.target.value)} />
              <button type="button" className="ib-btn ib-pri ib-dm-go" data-decision-answer="" disabled={!text.trim()} onClick={() => props.onAnswer(textAnswer(q, text, note))}>
                Answer
              </button>
            </div>
          )}
          {kind === 'action' && (
            <div className="ib-dm-action">
              {q.action?.where_url && (
                <a className="ib-btn" href={q.action.where_url} target="_blank" rel="noopener noreferrer">
                  Open {q.action.where ?? 'link'}
                  <Icon name="external" size={14} />
                </a>
              )}
              {q.action?.run && (
                <div className="ib-dm-run">
                  <code>{q.action.run}</code>
                  <button type="button" className="ib-btn ib-sm" onClick={() => void navigator.clipboard?.writeText(q.action?.run ?? '')}>
                    Copy
                  </button>
                </div>
              )}
              <div className="ib-dm-actbtns">
                <button type="button" className="ib-btn ib-pri" data-decision-done="" onClick={() => props.onAction({ outcome: 'done' })}>
                  Done
                </button>
                <button type="button" className="ib-btn" data-decision-cant="" aria-expanded={field === 'cant'} onClick={() => setField(field === 'cant' ? 'none' : 'cant')}>
                  Can&apos;t do it…
                </button>
              </div>
              {field === 'cant' && (
                <div className="ib-dm-field">
                  <label className="ib-dm-flabel" htmlFor={`${promptId}-cant`}>
                    Why can&apos;t you? {name} gets this word for word.
                  </label>
                  <textarea id={`${promptId}-cant`} className="ib-dm-ta" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus />
                  <button type="button" className="ib-btn ib-pri ib-sm" disabled={!reason.trim()} onClick={() => props.onAction({ outcome: 'cant', note: reason.trim() })}>
                    Send
                  </button>
                </div>
              )}
            </div>
          )}
          {facts.why && (
            <p className="ib-dm-why">
              <b>Why {name} recommends it:</b> {facts.why}
            </p>
          )}
          {/* Swipe is touch only, for a two-way choice, and always has its buttons (the choices above). */}
          {choices2 && props.touch && (
            <p className="ib-dm-swipehint" aria-hidden="true">
              Swipe right for {choices2[0]}, left for {choices2[1]}.
            </p>
          )}
        </div>

        {/* The secondary actions: Other, Add a note, Later, Skip. */}
        {kind !== 'action' && (
          <>
            {field === 'other' && kind !== 'text' && (
              <div className="ib-dm-field">
                <label className="ib-dm-flabel" htmlFor={`${promptId}-other`}>
                  Your own answer
                </label>
                <textarea id={`${promptId}-other`} className="ib-dm-ta" rows={2} value={other} onChange={(event) => setOther(event.target.value)} autoFocus />
                <button type="button" className="ib-btn ib-pri ib-sm" data-decision-other-answer="" disabled={!other.trim()} onClick={() => props.onAnswer(otherAnswer(q, other, note))}>
                  Answer
                </button>
              </div>
            )}
            {field === 'note' && (
              <div className="ib-dm-field">
                <label className="ib-dm-flabel" htmlFor={`${promptId}-note`}>
                  A note with your answer
                </label>
                <textarea id={`${promptId}-note`} className="ib-dm-ta" rows={2} value={note} onChange={(event) => setNote(event.target.value)} autoFocus />
              </div>
            )}
            <div className="ib-dm-more">
              {kind !== 'text' && (
                <button type="button" className="ib-dm-lnk" aria-expanded={field === 'other'} data-decision-other="" onClick={() => setField(field === 'other' ? 'none' : 'other')}>
                  Other…
                </button>
              )}
              <button type="button" className="ib-dm-lnk" aria-expanded={field === 'note'} data-decision-note="" onClick={() => setField(field === 'note' ? 'none' : 'note')}>
                Add a note
              </button>
              <button type="button" className="ib-dm-lnk" data-decision-later="" onClick={props.onLater}>
                <Icon name="clock" size={15} />
                Later
              </button>
              <button type="button" className="ib-dm-lnk" data-decision-skip="" onClick={() => props.onAnswer(skipAnswer(q, note))}>
                Skip
              </button>
            </div>
          </>
        )}
        {kind === 'action' && (
          <div className="ib-dm-more">
            <button type="button" className="ib-dm-lnk" data-decision-later="" onClick={props.onLater}>
              <Icon name="clock" size={15} />
              Later
            </button>
          </div>
        )}
      </div>
      {props.stamp && (
        <div className="ib-dm-stamp" aria-hidden="true">
          <Icon name="check" size={18} />
          {props.stamp === 'done' ? 'Done' : props.stamp === 'cant' ? "Can't do it" : answerWords(props.stamp)}
        </div>
      )}
    </article>
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** What the card starts with: the saved pick, else (multi) the recommendation ticked, else nothing. */
function initialSelection(q: InboxQuestion): string[] {
  if (q.state === 'picked' && q.answer) return [...q.answer.selected];
  if (readInboxQuestionKind(q.kind) === 'multi') return q.choices.filter((c) => c.recommended).map((c) => c.label);
  return [];
}
