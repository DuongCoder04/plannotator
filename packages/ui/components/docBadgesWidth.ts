/** A box's viewport edges, as `getBoundingClientRect()` reports them. */
export interface BoxEdges {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Space kept between the badge cluster and the action cluster. */
const ACTIONS_GAP = 8;

/**
 * The widest the legacy (absolutely positioned) badge cluster may grow before
 * it runs under the document's action cluster, so a long file name truncates
 * where the buttons start rather than at a fixed width.
 *
 * Null leaves the cluster unbounded by the actions: there are none, they have
 * not been measured yet, or they sit on a row of their own (the phone layout
 * drops them below the badges).
 */
export function legacyBadgesMaxWidth(badges: BoxEdges, actions: BoxEdges | null): number | null {
  if (!actions || actions.right <= actions.left) return null;
  const sharesRow = actions.top < badges.bottom && actions.bottom > badges.top;
  if (!sharesRow) return null;
  return Math.max(0, actions.left - badges.left - ACTIONS_GAP);
}
