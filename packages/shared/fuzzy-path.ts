/**
 * Fuzzy path matching for Go to File (⌘P / Ctrl+P) in code review.
 *
 * Plannotator's own matcher. A path matches a query when every term's
 * characters appear in the path in order. Each candidate alignment is built
 * greedily from a few starting points (word starts first) and scored; the
 * best one wins. Scores reward characters at word starts (after `/ . _ -`, a
 * space, or a lower-to-upper case change), runs of consecutive characters,
 * matches in the file name, and how much of the file name the query covers;
 * gaps and long paths cost a little. Linear in the path's length per
 * starting point, so a few hundred thousand paths fit a keystroke.
 */

export interface FuzzyPathMatch {
  path: string;
  score: number;
  /** Matched character offsets in the path, ascending. */
  positions: number[];
}

const WORD_START = 8;
const RUN = 5;
const IN_NAME = 2;
const PER_CHAR = 1;
const GAP_COST = 0.2;
const GAP_COST_MAX = 3;
const NAME_IS_TERM = 50;
const NAME_STARTS_WITH_TERM = 25;
const NAME_COVERAGE = 30;
const LENGTH_COST = 0.03;
/** Added to a preferred path's score: enough to win a tie, never a real gap. */
const PREFERRED = 0.5;
/** Starting points tried per term (word starts, then the first occurrence). */
const MAX_STARTS = 4;

/** Splits a query on whitespace into lowercase terms; empty terms dropped. */
export function prepareFuzzyQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term !== '');
}

function isWordStart(path: string, at: number): boolean {
  if (at === 0) return true;
  const before = path[at - 1];
  if (before === '/' || before === '.' || before === '_' || before === '-' || before === ' ') return true;
  const current = path[at];
  return current >= 'A' && current <= 'Z' && before >= 'a' && before <= 'z';
}

/** Whether `term` from `from` appears in `lower` from `at` onward, in order. */
function fits(lower: string, term: string, from: number, at: number): boolean {
  let cursor = at;
  for (let i = from; i < term.length; i++) {
    cursor = lower.indexOf(term[i], cursor);
    if (cursor === -1) return false;
    cursor++;
  }
  return true;
}

/**
 * One alignment from a first position: each next character is the very next
 * one when it matches (a run), else its next word-start occurrence when the
 * rest still fits after it, else its next occurrence.
 */
function align(path: string, lower: string, term: string, first: number): number[] | null {
  const positions = [first];
  let at = first + 1;
  for (let i = 1; i < term.length; i++) {
    const char = term[i];
    if (lower[at] === char) {
      positions.push(at++);
      continue;
    }
    let next = lower.indexOf(char, at);
    if (next === -1) return null;
    if (!isWordStart(path, next)) {
      let candidate = lower.indexOf(char, next + 1);
      while (candidate !== -1 && !isWordStart(path, candidate)) candidate = lower.indexOf(char, candidate + 1);
      if (candidate !== -1 && fits(lower, term, i + 1, candidate + 1)) next = candidate;
    }
    positions.push(next);
    at = next + 1;
  }
  return positions;
}

function scoreAlignment(path: string, positions: readonly number[], nameStart: number): number {
  let score = 0;
  for (let i = 0; i < positions.length; i++) {
    const at = positions[i];
    score += PER_CHAR;
    if (isWordStart(path, at)) score += WORD_START;
    if (at >= nameStart) score += IN_NAME;
    if (i > 0) {
      const gap = at - positions[i - 1] - 1;
      if (gap === 0) score += RUN;
      else score -= Math.min(GAP_COST_MAX, gap * GAP_COST);
    }
  }
  return score;
}

function scoreTerm(path: string, lower: string, term: string): { score: number; positions: number[] } | null {
  if (!fits(lower, term, 0, 0)) return null;
  const nameStart = path.lastIndexOf('/') + 1;
  // Starting points: word starts of the first character (file name first),
  // then its first occurrence in the file name and in the path.
  const starts: number[] = [];
  const add = (at: number) => {
    if (at !== -1 && !starts.includes(at) && starts.length < MAX_STARTS) starts.push(at);
  };
  for (let at = lower.indexOf(term[0], nameStart); at !== -1 && starts.length < MAX_STARTS - 2; at = lower.indexOf(term[0], at + 1)) {
    if (isWordStart(path, at)) add(at);
  }
  add(lower.indexOf(term[0], nameStart));
  for (let at = lower.indexOf(term[0]); at !== -1 && at < nameStart && starts.length < MAX_STARTS - 1; at = lower.indexOf(term[0], at + 1)) {
    if (isWordStart(path, at)) add(at);
  }
  add(lower.indexOf(term[0]));
  let best: { score: number; positions: number[] } | null = null;
  for (const first of starts) {
    const positions = align(path, lower, term, first);
    if (!positions) continue;
    const score = scoreAlignment(path, positions, nameStart);
    if (!best || score > best.score) best = { score, positions };
  }
  if (!best) return null;
  const name = lower.slice(nameStart);
  if (name === term) best.score += NAME_IS_TERM;
  else if (name.startsWith(term)) best.score += NAME_STARTS_WITH_TERM;
  return best;
}

/** Scores a path against prepared terms (every term must match), or null. */
export function scoreFuzzyPath(path: string, terms: readonly string[], lowerPath = path.toLowerCase()): FuzzyPathMatch | null {
  const nameStart = path.lastIndexOf('/') + 1;
  let positions: number[] = [];
  let score = 0;
  for (const term of terms) {
    const result = scoreTerm(path, lowerPath, term);
    if (!result) return null;
    score += result.score;
    positions = positions.length === 0 ? result.positions : positions.concat(result.positions);
  }
  if (terms.length > 1) positions = [...new Set(positions)].sort((a, b) => a - b);
  const nameLength = path.length - nameStart;
  if (nameLength > 0) {
    let inName = 0;
    for (const at of positions) if (at >= nameStart) inName++;
    score += NAME_COVERAGE * (inName / nameLength);
  }
  score -= path.length * LENGTH_COST;
  return { path, score, positions };
}

export interface FuzzyPathSearchOptions {
  limit?: number;
  /** Paths that win ties (code review: the files the diff changes). */
  preferred?: ReadonlySet<string>;
  /** `paths` lowercased, when the caller keeps them (a large list searched per keystroke). */
  lowerPaths?: readonly string[];
}

/** The best `limit` matches for `query` among `paths`, highest score first. */
export function fuzzySearchPaths(paths: readonly string[], query: string, options: FuzzyPathSearchOptions = {}): FuzzyPathMatch[] {
  const limit = options.limit ?? 50;
  const terms = prepareFuzzyQuery(query);
  if (terms.length === 0 || limit <= 0) return [];
  const best: FuzzyPathMatch[] = [];
  let floor = -Infinity;
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    if (path.endsWith('/')) continue;
    const result = scoreFuzzyPath(path, terms, options.lowerPaths?.[index]);
    if (!result) continue;
    if (options.preferred?.has(path)) result.score += PREFERRED;
    if (best.length >= limit && result.score <= floor) continue;
    let at = best.length;
    while (at > 0 && best[at - 1].score < result.score) at--;
    best.splice(at, 0, result);
    if (best.length > limit) best.pop();
    if (best.length >= limit) floor = best[best.length - 1].score;
  }
  return best;
}
