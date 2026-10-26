import { useEffect, useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Menu } from '@base-ui/react/menu';
import { INBOX_CARD_COLUMN_LABELS, INBOX_CARD_REASON_MAX, INBOX_CARD_TITLE_MAX, type InboxCardColumn, type InboxCardWire } from '@plannotator/core/inbox-types';
import type { CardsModel, ProjectFolder } from '../api';
import { formatCount, fullTime, whenTime } from '../format';
import { AuthorMark, Icon } from '../icons';
import { Modal } from '../components/Updates';
import { Tip } from '../components/Tip';
import { SidebarTrigger } from '../shell/sidebar';
import {
  boardCounts,
  boardLanes,
  cardAge,
  cardLabel,
  cardLine,
  cardMoves,
  cardOwnerName,
  cardShowsUnread,
  moveSaid,
  unseenDrops,
  type BoardView,
  type CardMove,
} from './model';

/** A move the person makes on a card (the window's route `POST /api/inbox/cards/:id`). */
export type BoardMove = { op: 'move'; column: InboxCardColumn } | { op: 'icebox' } | { op: 'drop'; reason?: string | null } | { op: 'restore' };

export interface BoardPageProps {
  view: BoardView;
  model: CardsModel | null;
  error: string | null;
  /** The person's look when this visit began: cards an agent wrote to after it are bold. */
  visitLook: string | null;
  /** Cards the person opened or moved this visit: no longer bold. */
  handled: ReadonlySet<string>;
  /** Projects a New card can go in (the sidebar's), most recent first. */
  projects: readonly ProjectFolder[];
  /** Where a New card goes unless the person picks another. */
  defaultProject: string | null;
  phone: boolean;
  onView: (view: BoardView) => void;
  /** A card with a thread opens it in the normal Inbox view. */
  onOpenCard: (card: InboxCardWire) => void;
  onMove: (card: InboxCardWire, move: BoardMove) => Promise<InboxCardWire | null>;
  onCreate: (project: string, title: string) => Promise<boolean>;
  /** The person looked at the agents' drops ("Got it", or the Icebox page's Dropped). */
  onSeeDrops: () => void;
}

/**
 * The Board (approval "inbox-board", step 2): the five live columns as lanes
 * (Soft + Lanes), cards in variant C "Lean", Shipped and Icebox as links to
 * their own lists, the agents' unseen drops above the lanes. On a phone the
 * same order is one stacked list, with Shipped and Icebox folded at the end.
 * A card with a thread opens it in the Inbox; every move is on its Move menu
 * (the keyboard's way) and, on a desktop, by dragging it to another lane.
 */
export function BoardPage(props: BoardPageProps) {
  const { model, view, phone } = props;
  const cards = model?.cards ?? [];
  const counts = boardCounts(cards);
  const drops = unseenDrops(cards);
  const [creating, setCreating] = useState(false);
  const [dropping, setDropping] = useState<InboxCardWire | null>(null);
  const [said, setSaid] = useState('');
  const [failed, setFailed] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Ages move on by themselves ("5m ago" becomes "6m ago").
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const refocus = useRefocus(cards);

  const move = async (card: InboxCardWire, change: BoardMove) => {
    setFailed(null);
    refocus.expect(card);
    const moved = await props.onMove(card, change);
    if (!moved) {
      setFailed(`“${card.title}” did not move. Try again.`);
      return;
    }
    setSaid(moveSaid(card, moved));
  };
  const choose = (card: InboxCardWire, choice: CardMove) => {
    if (choice.kind === 'drop') setDropping(card);
    else if (choice.kind === 'restore') void move(card, { op: 'restore' });
    else if (choice.kind === 'icebox') void move(card, { op: 'icebox' });
    else if (choice.kind === 'ship') void move(card, { op: 'move', column: 'shipped' });
    else void move(card, { op: 'move', column: choice.column });
  };

  const common = { visitLook: props.visitLook, handled: props.handled, now, phone, onOpen: props.onOpenCard, onChoose: choose };

  let body: ReactNode;
  if (!model) body = props.error ? <div className="ib-error">{props.error}</div> : <div className="ib-bload" aria-busy="true" />;
  else if (phone) body = <PhoneBoard cards={cards} counts={counts} {...common} onRestore={(card) => void move(card, { op: 'restore' })} />;
  else if (view === 'shipped') body = <CardList title="Shipped" empty="Nothing shipped yet. A card goes here when its work is merged or live." cards={cards.filter((c) => c.column === 'shipped')} {...common} />;
  else if (view === 'icebox')
    body = (
      <IceboxPage
        cards={cards}
        {...common}
        onRestore={(card) => void move(card, { op: 'restore' })}
        onSeeDrops={props.onSeeDrops}
        unseen={drops.length}
      />
    );
  else body = <Lanes cards={cards} {...common} onMove={(card, column) => void move(card, { op: 'move', column })} />;

  const titleId = useId();
  return (
    <section className="ib-bpage" aria-labelledby={titleId} data-board-page="" data-board-view={phone ? 'phone' : view}>
      <div className="ib-bhead">
        <SidebarTrigger />
        {view !== 'lanes' && !phone ? (
          <>
            <button type="button" className="ib-bback" data-board-back="" onClick={() => props.onView('lanes')}>
              <Icon name="chevL" size={16} />
              Board
            </button>
            <h1 id={titleId} tabIndex={-1}>
              {view === 'shipped' ? 'Shipped' : 'Icebox'}
            </h1>
          </>
        ) : (
          <>
            <h1 id={titleId} tabIndex={-1}>
              Board
            </h1>
            {model && (
              <span className="ib-bsum" data-board-summary="">
                {formatCount(counts.inFlight)} in flight · <b>{formatCount(counts.onYou)} on you</b>
              </span>
            )}
          </>
        )}
        <span className="ib-bsp" />
        {!phone && view === 'lanes' && model && (
          <nav className="ib-blinks" aria-label="Cards out of the lanes">
            <a href="#board=shipped" data-board-link="shipped" onClick={(event) => (event.preventDefault(), props.onView('shipped'))}>
              Shipped {formatCount(counts.shipped)}
            </a>
            <span aria-hidden="true">·</span>
            <a href="#board=icebox" data-board-link="icebox" onClick={(event) => (event.preventDefault(), props.onView('icebox'))}>
              Icebox {formatCount(counts.icebox)}
            </a>
          </nav>
        )}
        {(view === 'lanes' || phone) && (
          <NewCardButton disabled={props.projects.length === 0} phone={phone} onOpen={() => setCreating(true)} />
        )}
      </div>
      {model && drops.length > 0 && view !== 'icebox' && (
        <DroppedNotice drops={drops} onRestore={(card) => void move(card, { op: 'restore' })} onSeen={props.onSeeDrops} onOpenIcebox={phone ? null : () => props.onView('icebox')} />
      )}
      {failed && (
        <div className="ib-error ib-bfail" role="alert">
          {failed}
        </div>
      )}
      {body}
      <div className="ib-sr" aria-live="polite" data-board-live="">
        {said}
      </div>
      {creating && (
        <NewCardDialog
          projects={props.projects}
          defaultProject={props.defaultProject}
          onClose={() => setCreating(false)}
          onCreate={async (project, title) => {
            const ok = await props.onCreate(project, title);
            if (ok) {
              setCreating(false);
              setSaid(`Added “${title}” to Backlog.`);
            }
            return ok;
          }}
        />
      )}
      {dropping && (
        <DropDialog
          card={dropping}
          onClose={() => setDropping(null)}
          onDrop={async (reason) => {
            const card = dropping;
            setDropping(null);
            await move(card, { op: 'drop', reason: reason || null });
          }}
        />
      )}
    </section>
  );
}

/**
 * After a move the card is drawn again in another list, so focus would fall
 * to the page: it goes back to the card's Move button where the card now is,
 * else (the card left this view) to the heading of the list it left.
 */
function useRefocus(cards: readonly InboxCardWire[]) {
  const pending = useRef<{ id: string; column: InboxCardColumn; focused: boolean } | null>(null);
  useLayoutEffect(() => {
    const want = pending.current;
    if (!want) return;
    const card = cards.find((c) => c.id === want.id);
    if (!card || card.column === want.column) return;
    pending.current = null;
    if (!want.focused) return;
    const root = document.querySelector('[data-board-page]');
    const target =
      root?.querySelector<HTMLElement>(`[data-card-id="${want.id}"] [data-card-move]`) ??
      root?.querySelector<HTMLElement>(`[data-lane="${want.column}"] h2`) ??
      root?.querySelector<HTMLElement>('h1');
    target?.focus();
  }, [cards]);
  return {
    expect(card: InboxCardWire) {
      const active = document.activeElement;
      // Only a move made from the card (its menu, its row) brings focus back; a drag leaves the pointer where it is.
      const focused = active instanceof HTMLElement && (active === document.body || !!active.closest(`[data-card-id="${card.id}"]`) || !!active.closest('[data-card-menu]'));
      pending.current = { id: card.id, column: card.column, focused };
    },
  };
}

function NewCardButton({ disabled, phone, onOpen }: { disabled: boolean; phone: boolean; onOpen: () => void }) {
  const button = (
    <button type="button" className="ib-btn ib-sm ib-bnew" data-board-new="" disabled={disabled} aria-haspopup="dialog" onClick={onOpen} aria-label={phone ? 'New card' : undefined}>
      <Icon name="plus" size={15} />
      {!phone && 'New card'}
    </button>
  );
  return disabled ? <Tip content="A card needs a project: an agent's first message makes one.">{button}</Tip> : button;
}

interface CardCommon {
  visitLook: string | null;
  handled: ReadonlySet<string>;
  now: number;
  phone: boolean;
  onOpen: (card: InboxCardWire) => void;
  onChoose: (card: InboxCardWire, choice: CardMove) => void;
}

function Lanes({ cards, onMove, ...common }: CardCommon & { cards: readonly InboxCardWire[]; onMove: (card: InboxCardWire, column: InboxCardColumn) => void }) {
  const [dragging, setDragging] = useState<InboxCardWire | null>(null);
  const [over, setOver] = useState<InboxCardColumn | null>(null);
  return (
    <div className="ib-blanes" data-dragging={dragging ? '' : undefined}>
      {boardLanes(cards).map((lane) => {
        const target = dragging !== null && dragging.column !== lane.column;
        const dragOver = (event: DragEvent) => {
          if (!target) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          if (over !== lane.column) setOver(lane.column);
        };
        return (
          <section
            key={lane.column}
            className="ib-lane"
            aria-labelledby={`ib-lane-${lane.column}`}
            data-lane={lane.column}
            data-drop={target ? '' : undefined}
            data-over={target && over === lane.column ? '' : undefined}
            onDragOver={dragOver}
            onDragEnter={dragOver}
            onDragLeave={(event) => {
              if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) setOver((current) => (current === lane.column ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const card = dragging;
              setDragging(null);
              setOver(null);
              if (card && card.column !== lane.column) onMove(card, lane.column);
            }}
          >
            <h2 className="ib-lane-h" id={`ib-lane-${lane.column}`} tabIndex={-1}>
              <span className="ib-lane-dot" data-col={lane.column} aria-hidden="true" />
              <span className="ib-lane-l">{lane.label}</span>
              <span className="ib-lane-n">{formatCount(lane.cards.length)}</span>
              {lane.onYou && <span className="ib-onyou">on you</span>}
            </h2>
            {lane.cards.length > 0 ? (
              <ul className="ib-lane-cards" aria-labelledby={`ib-lane-${lane.column}`}>
                {lane.cards.map((card) => (
                  <BoardCard
                    key={card.id}
                    card={card}
                    {...common}
                    draggable
                    dragging={dragging?.id === card.id}
                    onDragStart={() => setDragging(card)}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                  />
                ))}
              </ul>
            ) : (
              <p className="ib-lane-empty">{LANE_EMPTY[lane.column]}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

const LANE_EMPTY: Partial<Record<InboxCardColumn, string>> = {
  backlog: 'Nothing waiting. A card here is not sent to any agent.',
  designing: 'No agent is designing anything.',
  your_look: 'Nothing waits on your look.',
  building: 'No agent is building anything.',
  your_review: 'Nothing waits on your review.',
};

/**
 * One card, variant C "Lean": the agent's mark and the title; then "You: …"
 * (the person's columns) or the agent's last word, and how long ago anyone
 * last wrote to it. Bold while unread. A card with a thread is a link to it;
 * its Move menu sits beside it (a sibling, never inside the link).
 */
function BoardCard({
  card,
  visitLook,
  handled,
  now,
  phone,
  onOpen,
  onChoose,
  draggable = false,
  dragging = false,
  onDragStart,
  onDragEnd,
}: CardCommon & { card: InboxCardWire; draggable?: boolean; dragging?: boolean; onDragStart?: () => void; onDragEnd?: () => void }) {
  const unread = cardShowsUnread(card, visitLook, handled);
  const line = cardLine(card);
  const age = cardAge(card.heard_at, now);
  const thread = card.threads[0] ?? null;
  const label = cardLabel(card, unread, now) + (thread ? '. Opens its thread' : '');
  const inner = (
    <>
      <span className="ib-bc-top">
        {card.agent ? <AuthorMark author={card.agent} /> : <span className="ib-mk ib-bc-you" aria-hidden="true"><Icon name="user" size={14} /></span>}
        <Tip content={card.title} cut>
          <span className="ib-bc-t" dir="auto">
            {card.title}
          </span>
        </Tip>
      </span>
      <span className="ib-bc-bot">
        <span className="ib-bc-line" dir="auto">
          {line ? (
            line.you ? (
              <>
                <b className="ib-bc-youw">You:</b> {line.text}
              </>
            ) : (
              line.text
            )
          ) : null}
        </span>
        <Tip content={`Last heard ${fullTime(card.heard_at)}`}>
          <span className="ib-bc-age">{age.short}</span>
        </Tip>
      </span>
    </>
  );
  return (
    <li
      className="ib-bcard"
      data-card-id={card.id}
      data-column={card.column}
      data-unread={unread ? '' : undefined}
      data-dragging={dragging ? '' : undefined}
      draggable={draggable && !phone ? true : undefined}
      onDragStart={(event) => {
        if (!draggable || phone) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', card.title);
        onDragStart?.();
      }}
      onDragEnd={onDragEnd}
    >
      {thread ? (
        <a
          className="ib-bc-main"
          href={`#thread=${encodeURIComponent(thread)}`}
          draggable={false}
          aria-label={label}
          data-card-open=""
          onClick={(event) => {
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
            event.preventDefault();
            onOpen(card);
          }}
        >
          {inner}
        </a>
      ) : (
        <div className="ib-bc-main" role="group" aria-label={label}>
          {inner}
        </div>
      )}
      <MoveMenu card={card} phone={phone} onChoose={(choice) => onChoose(card, choice)} />
    </li>
  );
}

/** The card's Move menu: every move the person may make, the keyboard's way to drag. */
function MoveMenu({ card, phone, onChoose }: { card: InboxCardWire; phone: boolean; onChoose: (choice: CardMove) => void }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [portal, setPortal] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => setPortal(trigger.current?.closest<HTMLElement>('.pn-inbox') ?? null), []);
  const moves = cardMoves(card);
  const columns = moves.filter((m) => m.kind === 'column');
  const rest = moves.filter((m) => m.kind !== 'column');
  return (
    <Menu.Root open={open} onOpenChange={setOpen} modal={false}>
      <Tip content="Move">
        <Menu.Trigger ref={trigger} className="ib-bc-more" aria-label={`Move “${card.title}”`} data-card-move="" data-open={open ? '' : undefined}>
          <Icon name="dots" size={16} />
        </Menu.Trigger>
      </Tip>
      <Menu.Portal container={portal ?? undefined}>
        {phone && <Menu.Backdrop className="ib-pm-scrim" />}
        <Menu.Positioner className="ib-pm-pos" side="bottom" align="end" sideOffset={4} data-phone={phone ? '' : undefined}>
          <Menu.Popup className="ib-pm" aria-label={`Move “${card.title}”`} data-card-menu={card.id}>
            <div className="ib-pm-title" dir="auto" aria-hidden="true">
              {card.title}
            </div>
            {columns.map((choice) => (
              <Menu.Item key={choice.label} className="ib-pmi" label={choice.label} onClick={() => onChoose(choice)} data-card-move-to={choice.kind === 'column' ? choice.column : undefined}>
                <span className="ib-lane-dot" data-col={choice.kind === 'column' ? choice.column : undefined} aria-hidden="true" />
                {choice.label}
              </Menu.Item>
            ))}
            {columns.length > 0 && rest.length > 0 && <Menu.Separator className="ib-pm-sep" />}
            {rest.map((choice) => (
              <Menu.Item key={choice.label} className="ib-pmi" label={choice.label} onClick={() => onChoose(choice)} data-card-action={choice.kind}>
                <Icon name={MOVE_ICONS[choice.kind]} size={15} />
                {choice.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const MOVE_ICONS = { column: 'forward', ship: 'check', icebox: 'pause', drop: 'trash', restore: 'replay' } as const;

/** "2 dropped by an agent", with each title and reason, until the person has looked. */
function DroppedNotice({
  drops,
  onRestore,
  onSeen,
  onOpenIcebox,
}: {
  drops: readonly InboxCardWire[];
  onRestore: (card: InboxCardWire) => void;
  onSeen: () => void;
  onOpenIcebox: (() => void) | null;
}) {
  const headingId = useId();
  return (
    <section className="ib-bdrops" aria-labelledby={headingId} data-dropped-notice={drops.length}>
      <div className="ib-bdrops-h">
        <Icon name="warn" size={16} />
        <h2 id={headingId}>
          {formatCount(drops.length)} dropped by {drops.length === 1 ? 'an agent' : 'agents'}
        </h2>
        <span className="ib-bsp" />
        {onOpenIcebox && (
          <button type="button" className="ib-lnk" onClick={onOpenIcebox}>
            See Dropped
          </button>
        )}
        <button type="button" className="ib-btn ib-sm" data-dropped-seen="" onClick={onSeen}>
          Got it
        </button>
      </div>
      <ul>
        {drops.map((card) => (
          <li key={card.id} data-dropped-card={card.id}>
            <span className="ib-bdrops-t" dir="auto">
              <b>{card.title}</b>
              {' · '}
              {card.dropped?.by.kind === 'agent' ? cardOwnerName({ ...card, agent: card.dropped.by }) : 'An agent'}
              {card.dropped?.reason ? `: ${card.dropped.reason}` : ''}
            </span>
            <button type="button" className="ib-btn ib-sm" data-card-restore={card.id} onClick={() => onRestore(card)} aria-label={`Restore “${card.title}”`}>
              Restore
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** A list of cards (Shipped, Icebox), newest move first. */
function CardList({ title, empty, cards, ...common }: CardCommon & { title: string; empty: string; cards: readonly InboxCardWire[] }) {
  const id = useId();
  return (
    <section className="ib-blist" aria-labelledby={id}>
      <h2 id={id} className="ib-blist-h" tabIndex={-1}>
        {title} <span className="ib-lane-n">{formatCount(cards.length)}</span>
      </h2>
      {cards.length > 0 ? (
        <ul className="ib-lane-cards">
          {cards.map((card) => (
            <BoardCard key={card.id} card={card} {...common} />
          ))}
        </ul>
      ) : (
        <p className="ib-lane-empty">{empty}</p>
      )}
    </section>
  );
}

/**
 * The Icebox page: cards the person put aside (nothing happens to them: no
 * agent is told, nothing moves them), then Dropped with the date, who dropped
 * it, the reason and Restore. Opening it is the person looking at Dropped.
 */
function IceboxPage({
  cards,
  onRestore,
  onSeeDrops,
  unseen,
  ...common
}: CardCommon & { cards: readonly InboxCardWire[]; onRestore: (card: InboxCardWire) => void; onSeeDrops: () => void; unseen: number }) {
  useEffect(() => {
    if (unseen > 0) onSeeDrops();
  }, [unseen, onSeeDrops]);
  const iced = cards.filter((c) => c.column === 'icebox');
  const dropped = cards.filter((c) => c.column === 'dropped').sort((a, b) => (b.dropped?.at ?? b.moved_at).localeCompare(a.dropped?.at ?? a.moved_at));
  return (
    <div className="ib-blists">
      <CardList title="Icebox" empty="Nothing on ice. Put a card here to set it aside: no agent is told and nothing moves it." cards={iced} {...common} />
      <DroppedList cards={dropped} onRestore={onRestore} />
    </div>
  );
}

function DroppedList({ cards, onRestore }: { cards: readonly InboxCardWire[]; onRestore: (card: InboxCardWire) => void }) {
  const id = useId();
  return (
    <section className="ib-blist" aria-labelledby={id} data-dropped-list="">
      <h2 id={id} className="ib-blist-h" tabIndex={-1}>
        Dropped <span className="ib-lane-n">{formatCount(cards.length)}</span>
      </h2>
      {cards.length > 0 ? (
        <ul className="ib-drops">
          {cards.map((card) => {
            const by = card.dropped?.by.kind === 'agent' ? cardOwnerName({ ...card, agent: card.dropped.by }) : 'You';
            return (
              <li key={card.id} className="ib-drop" data-dropped-row={card.id}>
                <span className="ib-drop-t">
                  <span className="ib-drop-title" dir="auto">
                    {card.title}
                  </span>
                  <span className="ib-drop-meta" dir="auto">
                    {card.dropped ? `Dropped ${whenTime(card.dropped.at)} by ${by}` : 'Dropped'}
                    {card.dropped?.reason ? `: ${card.dropped.reason}` : ''}
                  </span>
                </span>
                <button type="button" className="ib-btn ib-sm" data-card-restore={card.id} onClick={() => onRestore(card)} aria-label={`Restore “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[card.aside_from ?? 'backlog']}`}>
                  Restore
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="ib-lane-empty">Nothing dropped. A dropped card is kept here and can be restored.</p>
      )}
    </section>
  );
}

/**
 * A phone: the lanes as one stacked list in column order, each foldable,
 * with Shipped and Icebox (Dropped inside it) folded at the end. No drag:
 * every move is on the card's Move menu, a sheet from the bottom edge.
 */
function PhoneBoard({
  cards,
  counts,
  onRestore,
  ...common
}: CardCommon & { cards: readonly InboxCardWire[]; counts: ReturnType<typeof boardCounts>; onRestore: (card: InboxCardWire) => void }) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set(['shipped', 'icebox']));
  const toggle = (key: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const groups: { key: string; label: string; count: number; onYou?: boolean; body: ReactNode }[] = boardLanes(cards).map((lane) => ({
    key: lane.column,
    label: lane.label,
    count: lane.cards.length,
    onYou: lane.onYou,
    body:
      lane.cards.length > 0 ? (
        <ul className="ib-lane-cards">
          {lane.cards.map((card) => (
            <BoardCard key={card.id} card={card} {...common} />
          ))}
        </ul>
      ) : (
        <p className="ib-lane-empty">{LANE_EMPTY[lane.column]}</p>
      ),
  }));
  const shipped = cards.filter((c) => c.column === 'shipped');
  const iced = cards.filter((c) => c.column === 'icebox');
  const dropped = cards.filter((c) => c.column === 'dropped');
  groups.push({
    key: 'shipped',
    label: 'Shipped',
    count: counts.shipped,
    body: shipped.length ? (
      <ul className="ib-lane-cards">
        {shipped.map((card) => (
          <BoardCard key={card.id} card={card} {...common} />
        ))}
      </ul>
    ) : (
      <p className="ib-lane-empty">Nothing shipped yet.</p>
    ),
  });
  groups.push({
    key: 'icebox',
    label: 'Icebox',
    count: counts.icebox,
    body: (
      <>
        {iced.length ? (
          <ul className="ib-lane-cards">
            {iced.map((card) => (
              <BoardCard key={card.id} card={card} {...common} />
            ))}
          </ul>
        ) : (
          <p className="ib-lane-empty">Nothing on ice.</p>
        )}
        {dropped.length > 0 && <DroppedList cards={dropped} onRestore={onRestore} />}
      </>
    ),
  });
  return (
    <div className="ib-bstack">
      {groups.map((group) => {
        const open = !folded.has(group.key);
        const bodyId = `ib-bstack-${group.key}`;
        return (
          <section key={group.key} className="ib-bgroup" data-lane={group.key} aria-labelledby={`${bodyId}-h`}>
            <h2 className="ib-bgroup-h" id={`${bodyId}-h`}>
              <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={() => toggle(group.key)} data-board-fold={group.key}>
                <span className="ib-lane-dot" data-col={group.key} aria-hidden="true" />
                <span className="ib-lane-l">{group.label}</span>
                <span className="ib-lane-n">{formatCount(group.count)}</span>
                {group.onYou && <span className="ib-onyou">on you</span>}
                <span className="ib-bsp" />
                <Icon name={open ? 'chevU' : 'chevD'} size={16} />
              </button>
            </h2>
            <div id={bodyId} hidden={!open}>
              {group.body}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** New card: a title, and the project when there is more than one; it lands in Backlog, sent to no agent. */
function NewCardDialog({
  projects,
  defaultProject,
  onClose,
  onCreate,
}: {
  projects: readonly ProjectFolder[];
  defaultProject: string | null;
  onClose: () => void;
  onCreate: (project: string, title: string) => Promise<boolean>;
}) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState<string>(defaultProject ?? projects[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);
  const submit = async () => {
    const text = title.replace(/\s+/g, ' ').trim();
    if (!text) {
      setError('Give the card a title.');
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    const ok = await onCreate(project, text);
    setBusy(false);
    if (!ok) setError('The card was not added. Try again.');
  };
  return (
    <Modal labelledBy="ib-newcard-title" describedBy="ib-newcard-desc" testId="new-card" onClose={onClose} ownKeys>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <h2 id="ib-newcard-title">New card</h2>
        <p className="ib-sub" id="ib-newcard-desc">
          It goes in Backlog. No agent is told about it.
        </p>
        <label className="ib-bfield">
          <span>Title</span>
          <input
            ref={input}
            type="text"
            value={title}
            maxLength={INBOX_CARD_TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'ib-newcard-error' : undefined}
            data-new-card-title=""
          />
        </label>
        {projects.length > 1 && (
          <fieldset className="ib-bprojects">
            <legend>Project</legend>
            {projects.map((p) => (
              <label key={p.id} className="ib-bproject">
                <input type="radio" name="ib-newcard-project" value={p.id} checked={project === p.id} onChange={() => setProject(p.id)} />
                <span dir="auto">{p.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {error && (
          <p className="ib-error ib-bfield-err" id="ib-newcard-error" role="alert">
            {error}
          </p>
        )}
        <div className="ib-acts-row">
          <button type="button" className="ib-btn ib-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri" disabled={busy} data-new-card-add="">
            Add to Backlog
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Drop…: an optional reason, kept with the card under Icebox, Dropped. */
function DropDialog({ card, onClose, onDrop }: { card: InboxCardWire; onClose: () => void; onDrop: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => area.current?.focus(), []);
  return (
    <Modal labelledBy="ib-dropcard-title" describedBy="ib-dropcard-desc" testId="drop-card" onClose={onClose} ownKeys>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void onDrop(reason.replace(/\s+/g, ' ').trim());
        }}
      >
        <h2 id="ib-dropcard-title" dir="auto">
          Drop “{card.title}”?
        </h2>
        <p className="ib-sub" id="ib-dropcard-desc">
          It is kept under Icebox, Dropped, and can be restored.
        </p>
        <label className="ib-bfield">
          <span>Reason (optional)</span>
          <textarea ref={area} rows={2} value={reason} maxLength={INBOX_CARD_REASON_MAX} onChange={(event) => setReason(event.target.value)} data-drop-reason="" />
        </label>
        <div className="ib-acts-row">
          <button type="button" className="ib-btn ib-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="ib-btn ib-pri" data-drop-confirm="">
            Drop
          </button>
        </div>
      </form>
    </Modal>
  );
}

