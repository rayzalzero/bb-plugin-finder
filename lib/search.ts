/**
 * Content search: the query a user typed, and the matches one file yields.
 *
 * Kept free of IO so the matching rules — escaping, whole-word boundaries,
 * windowing a very long line — are testable on their own, and so the server can
 * reuse one compiled pattern across every file it scans.
 */

export interface SearchOptions {
  caseSensitive: boolean;
  regexp: boolean;
  wholeWord: boolean;
}

export interface SearchMatch {
  /** 1-based, like the editor's gutter. */
  line: number;
  /** 1-based column of the match within the real line, even when `text` is windowed. */
  column: number;
  /** The line as displayed, windowed around the match when it is very long. */
  text: string;
  /** Match offsets within `text`, for the highlight. */
  matchStart: number;
  matchEnd: number;
}

export type CompiledSearch =
  | { ok: true; pattern: RegExp }
  | { ok: false; reason: string };

/** A line longer than this is shown as a window around the match. */
const MAX_LINE_CHARS = 240;
/** How much of the line to keep before the match when windowing. */
const WINDOW_LEAD = 40;

/**
 * Turn the query and its options into one global pattern.
 *
 * A plain query is escaped rather than compiled, so a user searching for
 * `config[0]` gets that literal text instead of a character class. Whole-word
 * matching wraps the pattern in word boundaries rather than post-filtering,
 * which keeps it correct for alternations.
 */
export function compileSearch(query: string, options: SearchOptions): CompiledSearch {
  const body = options.regexp ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wrapped = options.wholeWord ? `(?<![A-Za-z0-9_])(?:${body})(?![A-Za-z0-9_])` : body;
  try {
    return { ok: true, pattern: new RegExp(wrapped, options.caseSensitive ? "g" : "gi") };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Show the match in context without handing the pane a megabyte-long line. */
function windowMatch(line: string, lineNumber: number, start: number, end: number): SearchMatch {
  if (line.length <= MAX_LINE_CHARS) {
    return { line: lineNumber, column: start + 1, text: line, matchStart: start, matchEnd: end };
  }
  const from = Math.max(0, start - WINDOW_LEAD);
  const to = Math.min(line.length, from + MAX_LINE_CHARS);
  const prefix = from > 0 ? "…" : "";
  const suffix = to < line.length ? "…" : "";
  const shift = prefix.length - from;
  return {
    line: lineNumber,
    column: start + 1,
    text: `${prefix}${line.slice(from, to)}${suffix}`,
    matchStart: start + shift,
    matchEnd: end + shift,
  };
}

/**
 * Every match in one file's text, capped at `limit`.
 *
 * Zero-length matches are dropped: an empty alternative (`a|`) or a bare `^`
 * would otherwise report a match at every position on the line.
 */
export function findLineMatches(content: string, pattern: RegExp, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const lines = content.split("\n");
  for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
    const line = lines[index] ?? "";
    if (line === "") continue;
    for (const found of line.matchAll(pattern)) {
      if (found[0] === "") continue;
      matches.push(windowMatch(line, index + 1, found.index, found.index + found[0].length));
      if (matches.length >= limit) break;
    }
  }
  return matches;
}
