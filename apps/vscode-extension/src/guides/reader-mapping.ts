/**
 * Where a token the reader's diff reports is in the file on disk. The diff
 * is the guide's patch; the head side's file is the real one, which may have
 * moved on since (local changes edited after the guide was written). No
 * `vscode`: the caller passes the lines it read.
 */

export interface TokenSpot {
  /** 1-based. */
  line: number;
  /** 0-based. */
  character: number;
  /** The token was not exactly where the diff said: the file changed since. */
  stale: boolean;
}

/** How far up and down a moved token is looked for. */
const SEARCH_LINES = 40;

function isWordChar(c: string | undefined): boolean {
  return !!c && /[\p{L}\p{N}_$]/u.test(c);
}

/** Every column of `token` on `text` as a whole word (when the token is a word). */
function occurrences(text: string, token: string): number[] {
  const out: number[] = [];
  const word = isWordChar(token[0]) && isWordChar(token[token.length - 1]);
  let i = text.indexOf(token);
  while (i >= 0) {
    if (!word || (!isWordChar(text[i - 1]) && !isWordChar(text[i + token.length]))) out.push(i);
    i = text.indexOf(token, i + 1);
  }
  return out;
}

/**
 * The token's spot in the file: exactly where the diff says when it is still
 * there; else the nearest occurrence on the same line; else the nearest
 * occurrence within SEARCH_LINES lines (marked stale). Null when the file has
 * no such token near there, or when the token is empty.
 */
export function locateToken(lineAt: (line: number) => string | undefined, line: number, character: number, token: string): TokenSpot | null {
  if (!token || line < 1) return null;
  const text = lineAt(line);
  if (text !== undefined) {
    if (text.startsWith(token, character)) return { line, character, stale: false };
    const same = occurrences(text, token);
    if (same.length) {
      const nearest = same.reduce((a, b) => (Math.abs(b - character) < Math.abs(a - character) ? b : a));
      return { line, character: nearest, stale: true };
    }
  }
  for (let d = 1; d <= SEARCH_LINES; d++) {
    for (const l of [line - d, line + d]) {
      if (l < 1) continue;
      const t = lineAt(l);
      if (t === undefined) continue;
      const hits = occurrences(t, token);
      if (hits.length) {
        const nearest = hits.reduce((a, b) => (Math.abs(b - character) < Math.abs(a - character) ? b : a));
        return { line: l, character: nearest, stale: true };
      }
    }
  }
  return null;
}

export type HoverBlock = { kind: "code"; language: string; text: string } | { kind: "markdown"; text: string };

/**
 * A language server's hover markdown split into code blocks (signatures) and
 * prose, in order. Prose is kept as markdown; the reader renders it through
 * its sanitizing markdown renderer. Command links (`command:`) are dropped:
 * the reader cannot run them.
 */
export function splitHoverMarkdown(markdown: string): HoverBlock[] {
  const blocks: HoverBlock[] = [];
  const fence = /```([\w+-]*)[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  const pushProse = (text: string) => {
    const cleaned = text
      .replace(/\[([^\]]*)\]\(command:[^)]*\)/g, "$1")
      .replace(/^\s*---\s*$/gm, "")
      .trim();
    if (cleaned) blocks.push({ kind: "markdown", text: cleaned });
  };
  for (let m = fence.exec(markdown); m; m = fence.exec(markdown)) {
    pushProse(markdown.slice(last, m.index));
    const text = m[2].replace(/\n$/, "");
    if (text.trim()) blocks.push({ kind: "code", language: m[1] || "text", text });
    last = m.index + m[0].length;
  }
  pushProse(markdown.slice(last));
  return blocks;
}
