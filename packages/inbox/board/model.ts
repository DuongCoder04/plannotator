/**
 * The Board page's rules, pure (approval "inbox-board", step 2; the look in
 * "inbox-board-look", the unread signal in "inbox-board-signal").
 *
 * - Lanes: the five live columns in COLUMNS.md set d order (Backlog,
 *   Designing, Your look, Building, Your review). Shipped and Icebox are links
 *   to their own lists; Dropped is listed on the Icebox page.
 * - A card (variant C "Lean") is two lines: the title, then "You: …" in the
 *   person's columns or the agent's last word otherwise, and its last-heard
 *   age on the right ("2d ago"). No counts on a card, no amber.
 * - Unread ("type: bold when unread, like mail"): an agent wrote to the card
 *   after the person's last look at the Board (isInboxCardUnread). The look
 *   moves when the Board is opened; the page keeps the marks it opened with
 *   for the visit, and a card the person opens or moves stops being bold.
 * - The person's moves: any live column, Ship, Icebox, Drop (reason), Restore.
 *   The store decides what is allowed; these say what the menu offers.
 */

import {
  INBOX_CARD_COLUMN_LABELS,
  INBOX_CARD_LIVE_COLUMNS,
  inboxAgentName,
  inboxCardLine,
  isInboxCardDropUnseen,
  isInboxCardPersonColumn,
  isInboxCardUnread,
  type InboxCardColumn,
  type InboxCardWire,
} from '@plannotator/core/inbox-types';

export type BoardView = 'lanes' | 'shipped' | 'icebox';

/** The Board's list a hash names (`#board=shipped`); anything else is the lanes. */
export function boardViewOf(value: string | null): BoardView {
  return value === 'shipped' || value === 'icebox' ? value : 'lanes';
}

/** One lane: a live column and its cards, latest move first (the server's order). */
export interface BoardLane {
  column: InboxCardColumn;
  label: string;
  /** Your look and Your review: the person owes the next move. */
  onYou: boolean;
  cards: InboxCardWire[];
}

export function boardLanes(cards: readonly InboxCardWire[]): BoardLane[] {
  return INBOX_CARD_LIVE_COLUMNS.map((column) => ({
    column,
    label: INBOX_CARD_COLUMN_LABELS[column],
    onYou: isInboxCardPersonColumn(column),
    cards: cards.filter((card) => card.column === column),
  }));
}

/** The header's facts: cards in the live lanes, those on the person, and the two links' counts. */
export function boardCounts(cards: readonly InboxCardWire[]) {
  let inFlight = 0;
  let onYou = 0;
  let shipped = 0;
  let icebox = 0;
  let dropped = 0;
  for (const card of cards) {
    if (INBOX_CARD_LIVE_COLUMNS.includes(card.column)) inFlight += 1;
    if (isInboxCardPersonColumn(card.column)) onYou += 1;
    if (card.column === 'shipped') shipped += 1;
    if (card.column === 'icebox') icebox += 1;
    if (card.column === 'dropped') dropped += 1;
  }
  return { inFlight, onYou, shipped, icebox, dropped };
}

/** An agent's drops the person has not seen, newest first: the Board's "N dropped by an agent". */
export function unseenDrops(cards: readonly InboxCardWire[]): InboxCardWire[] {
  return cards.filter(isInboxCardDropUnseen).sort((a, b) => (b.dropped?.at ?? '').localeCompare(a.dropped?.at ?? ''));
}

/** The card's second line: "You: …" in the person's columns, the agent's last word otherwise (or nothing). */
export function cardLine(card: InboxCardWire): { you: boolean; text: string } | null {
  const line = inboxCardLine(card);
  if (!line) return null;
  if (isInboxCardPersonColumn(card.column) && card.you) return { you: true, text: card.you };
  return { you: false, text: line };
}

/**
 * How long ago anyone last wrote to the card, short: "now", "5m ago", "3h
 * ago", "2d ago", "5w ago". The words for a screen reader: "just now", "5
 * minutes ago", … (`long`).
 */
export function cardAge(iso: string, now: number = Date.now()): { short: string; long: string } {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return { short: '', long: '' };
  const minutes = Math.max(0, Math.floor((now - then) / 60_000));
  if (minutes < 1) return { short: 'now', long: 'just now' };
  const unit = (n: number, s: string, word: string) => ({ short: `${n}${s} ago`, long: `${n} ${word}${n === 1 ? '' : 's'} ago` });
  if (minutes < 60) return unit(minutes, 'm', 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return unit(hours, 'h', 'hour');
  const days = Math.floor(hours / 24);
  if (days < 14) return unit(days, 'd', 'day');
  return unit(Math.floor(days / 7), 'w', 'week');
}

/** Whether a card shows bold: unread at the visit's look, and not opened or moved by the person this visit. */
export function cardShowsUnread(card: InboxCardWire, visitLook: string | null, handled: ReadonlySet<string>): boolean {
  return !handled.has(card.id) && isInboxCardUnread(card, visitLook);
}

/** The newest `heard_at` among the cards: how far a look at the Board runs. */
export function newestHeard(cards: readonly InboxCardWire[]): string | null {
  let newest: string | null = null;
  for (const card of cards) if (newest === null || card.heard_at > newest) newest = card.heard_at;
  return newest;
}

/** One thing the Move menu offers for a card. */
export type CardMove =
  | { kind: 'column'; column: InboxCardColumn; label: string }
  | { kind: 'ship'; label: string }
  | { kind: 'icebox'; label: string }
  | { kind: 'drop'; label: string }
  | { kind: 'restore'; label: string };

/**
 * The Move menu's items for a card. A live card: every other live column,
 * then Ship, Icebox and Drop…. A shipped card: back to a live column, Icebox,
 * Drop…. In the Icebox or Dropped: Restore (where it was), then Drop… for an
 * iceboxed one. The store refuses nothing the person may do here.
 */
export function cardMoves(card: InboxCardWire): CardMove[] {
  if (card.column === 'icebox' || card.column === 'dropped') {
    const back = card.aside_from ?? 'backlog';
    const out: CardMove[] = [{ kind: 'restore', label: `Restore to ${INBOX_CARD_COLUMN_LABELS[back]}` }];
    if (card.column === 'icebox') out.push({ kind: 'drop', label: 'Drop…' });
    return out;
  }
  const out: CardMove[] = INBOX_CARD_LIVE_COLUMNS.filter((column) => column !== card.column).map((column) => ({
    kind: 'column' as const,
    column,
    label: `Move to ${INBOX_CARD_COLUMN_LABELS[column]}`,
  }));
  if (card.column !== 'shipped') out.push({ kind: 'ship', label: 'Ship' });
  out.push({ kind: 'icebox', label: 'Move to Icebox' });
  out.push({ kind: 'drop', label: 'Drop…' });
  return out;
}

/** What the live region says after a move. */
export function moveSaid(card: InboxCardWire, moved: InboxCardWire): string {
  if (moved.column === 'dropped') return `Dropped “${card.title}”. It is kept under Icebox, Dropped.`;
  if (card.column === 'icebox' || card.column === 'dropped') return `Restored “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
  if (moved.column === 'shipped') return `Shipped “${card.title}”.`;
  return `Moved “${card.title}” to ${INBOX_CARD_COLUMN_LABELS[moved.column]}.`;
}

/** The agent's name a card belongs to, or "You" for a card the person made. */
export function cardOwnerName(card: InboxCardWire): string {
  return card.agent?.kind === 'agent' ? inboxAgentName(card.agent) : 'You';
}

/**
 * A card's whole accessible name: the title, its line, the lane, the age,
 * whether it is new, and where a click goes.
 */
export function cardLabel(card: InboxCardWire, unread: boolean, now: number = Date.now()): string {
  const parts = [card.title];
  const line = cardLine(card);
  if (line) parts.push(line.you ? `You: ${line.text}` : line.text);
  parts.push(INBOX_CARD_COLUMN_LABELS[card.column]);
  const age = cardAge(card.heard_at, now).long;
  if (age) parts.push(`last heard ${age}`);
  if (unread) parts.push(`new from ${cardOwnerName(card)}`);
  return parts.join('. ');
}
