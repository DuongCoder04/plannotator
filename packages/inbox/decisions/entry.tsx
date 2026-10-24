/**
 * Decision mode's ways in and its pill (approval "inbox-decision-mode"; experimental).
 * The sidebar's "Decide N" row and the list header's button show only while
 * two or more decisions wait (brief §11 question 7); one decision is answered
 * in its thread as before.
 */
import { formatCount } from '../format';

/** The ways in show from two decisions up. */
export const DECIDE_ENTRY_MIN = 2;

export function decideEntryShown(count: number): boolean {
  return count >= DECIDE_ENTRY_MIN;
}

/** "Decide 5". */
export function decideLabel(count: number): string {
  return `Decide ${formatCount(count)}`;
}

/**
 * Open the thread tucks decision mode into this pill at the bottom of the
 * window, the thread behind it ("Decisions · 9 left · Resume").
 */
export function DecisionPill({ left, onResume }: { left: number; onResume: () => void }) {
  return (
    <div className="ib-dm-pill" role="region" aria-label="Decision mode" data-decision-pill="">
      <span>
        <b>Decisions</b> · {left === 0 ? 'nothing left' : `${formatCount(left)} left`}
      </span>
      <button type="button" className="ib-btn ib-pri ib-sm" data-decision-resume="" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
