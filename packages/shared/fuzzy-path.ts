/**
 * Fuzzy path matching for Go to File (⌘P / Ctrl+P) in code review.
 *
 * Ported from the Pierre Computer Company code explorer
 * (`apps/code-explorer/lib/client/fuzzy.ts`), Copyright 2025 Pierre Computer
 * Company, licensed under the Apache License, Version 2.0
 * (http://www.apache.org/licenses/LICENSE-2.0). Changes: a bonus for how much of
 * the file name the query covers, the result carries the path itself, a caller may rank a set of paths first on ties (code review's
 * changed files), and the search takes an iterable of indexes so the client and
 * the server share one scan.
 *
 * Designed for scanning hundreds of thousands of paths per keystroke: a cheap
 * subsequence reject, then a single backward greedy pass that favors matches
 * in the file name and at word boundaries. No dynamic programming, so the cost
 * is O(path length).
 */

export interface FuzzyPathMatch {
  path: string;
  score: number;
  /** Matched character offsets in the path, ascending. */
  positions: number[];
}

const BOUNDARY_BONUS = 12;
const CONSECUTIVE_BONUS = 6;
const BASENAME_BONUS = 4;
const EXACT_BASENAME_BONUS = 60;
const BASENAME_PREFIX_BONUS = 30;
const BASENAME_COVERAGE_BONUS = 30;
/** Added to a preferred path's score: enough to win a tie, never a real gap. */
const PREFERRED_BONUS = 0.5;

function isSeparator(code: number): boolean {
  // / . _ - space
  return code === 47 || code === 46 || code === 95 || code === 45 || code === 32;
}

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function isLower(code: number): boolean {
  return code >= 97 && code <= 122;
}

/** Splits a query on whitespace into lowercase terms; empty terms dropped. */
export function prepareFuzzyQuery(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((term) => term !== '');
}

function scoreAlignment(path: string, lowerPath: string, term: string, matched: readonly number[], basenameStart: number): number {
  let score = 0;
  for (let index = 0; index < matched.length; index++) {
    const at = matched[index];
    const previous = at > 0 ? path.charCodeAt(at - 1) : 47;
    const current = path.charCodeAt(at);
    if (at === 0 || isSeparator(previous) || (isUpper(current) && isLower(previous))) {
      score += BOUNDARY_BONUS;
    }
    if (index > 0 && matched[index - 1] === at - 1) score += CONSECUTIVE_BONUS;
    if (at >= basenameStart) score += BASENAME_BONUS;
  }
  const basename = lowerPath.slice(basenameStart);
  // How much of the file name the term covers: `difftree` is most of
  // `diffFileTree.ts`, a little of `useDiffFileTreeExpansion.ts`.
  const inName = matched.filter((at) => at >= basenameStart).length;
  if (basename.length > 0) score += BASENAME_COVERAGE_BONUS * (inName / basename.length);
  if (basename === term) score += EXACT_BASENAME_BONUS;
  else if (basename.startsWith(term)) score += BASENAME_PREFIX_BONUS;
  return score;
}

// Scores one term against one path, or returns null when the term's
// characters do not all appear in order. Matched backwards so the last
// characters land in the file name.
function scoreTerm(path: string, lowerPath: string, term: string, positions: number[]): number | null {
  let cursor = 0;
  for (let index = 0; index < term.length; index++) {
    cursor = lowerPath.indexOf(term[index], cursor);
    if (cursor === -1) return null;
    cursor++;
  }

  const basenameStart = path.lastIndexOf('/') + 1;
  const backward: number[] = new Array(term.length);
  let position = lowerPath.length - 1;
  for (let index = term.length - 1; index >= 0; index--) {
    const char = term[index];
    while (position >= 0 && lowerPath[position] !== char) position--;
    if (position < 0) return null;
    backward[index] = position;
    position--;
  }
  const best = backward;
  const bestScore = scoreAlignment(path, lowerPath, term, backward, basenameStart);
  positions.push(...best);
  return bestScore;
}

/**
 * Scores a path against prepared terms. Every term must match; scores add up,
 * with a small penalty for long paths so `src/a.ts` beats `src/very/deep/a.ts`.
 */
export function scoreFuzzyPath(path: string, terms: readonly string[], lowerPath = path.toLowerCase()): FuzzyPathMatch | null {
  const positions: number[] = [];
  let score = 0;
  for (const term of terms) {
    const termScore = scoreTerm(path, lowerPath, term, positions);
    if (termScore == null) return null;
    score += termScore;
  }
  score -= path.length * 0.05;
  positions.sort((a, b) => a - b);
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
    if (result == null) continue;
    if (options.preferred?.has(path)) result.score += PREFERRED_BONUS;
    if (best.length >= limit && result.score <= floor) continue;
    let insertAt = best.length;
    while (insertAt > 0 && best[insertAt - 1].score < result.score) insertAt--;
    best.splice(insertAt, 0, result);
    if (best.length > limit) best.pop();
    if (best.length >= limit) floor = best[best.length - 1].score;
  }
  return best;
}
