import type { ScopeRef } from "./route";

/**
 * A 1-based inclusive span of lines. CodeMirror selections become one of these
 * when the user attaches only part of a file to the prompt.
 */
export interface LineRange {
  start: number;
  end: number;
}

/** `10-20`, or `10` for a single line. */
export function formatLineRange(range: LineRange): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

export function isLineRange(value: unknown): value is LineRange {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<LineRange>;
  return (
    typeof candidate.start === "number" &&
    typeof candidate.end === "number" &&
    Number.isInteger(candidate.start) &&
    Number.isInteger(candidate.end) &&
    candidate.start >= 1 &&
    candidate.end >= candidate.start
  );
}

/**
 * A mention item id has to survive in a saved composer draft, so it carries the
 * workspace reference and the path together: `<kind>:<id>\u0000<relative path>`,
 * with an optional third segment `\u0000<start>-<end>` when the pill stands for
 * a line selection rather than the whole file. The server's `parseMentionId`
 * reads the same format, and a two-segment id from an older draft still parses.
 */
export function mentionId(scope: ScopeRef, path: string, range?: LineRange): string {
  const base = `${scope.kind}:${scope.id}\u0000${path}`;
  return range === undefined ? base : `${base}\u0000${range.start}-${range.end}`;
}

export function parseMentionId(
  itemId: string,
): { scope: ScopeRef; path: string; range: LineRange | null } | null {
  const parts = itemId.split("\u0000");
  if (parts.length < 2 || parts.length > 3) return null;
  const reference = parts[0];
  const path = parts[1];
  const colon = reference.indexOf(":");
  if (colon === -1 || path === "") return null;
  const kind = reference.slice(0, colon);
  const id = reference.slice(colon + 1);
  if (kind !== "thread" && kind !== "environment" && kind !== "project") return null;
  if (id === "") return null;
  if (parts.length === 2) return { scope: { kind, id }, path, range: null };

  const segment = /^(\d+)-(\d+)$/.exec(parts[2]);
  if (segment === null) return null;
  const start = Number(segment[1]);
  const end = Number(segment[2]);
  if (start < 1 || end < start) return null;
  return { scope: { kind, id }, path, range: { start, end } };
}

/**
 * The selected lines, or null when the range starts past the end of the content.
 * A range past the last line is clamped rather than refused: the file may have
 * lost trailing lines between attaching the pill and sending the message.
 */
export function sliceLineRange(content: string, range: LineRange): string | null {
  const lines = content.split("\n");
  if (range.start > lines.length) return null;
  const end = Math.min(range.end, lines.length);
  return lines.slice(range.start - 1, end).join("\n");
}

/**
 * The source lines a rendered-text selection most likely covers. Rendered
 * markdown keeps the visible words but drops the markup, so an exact substring
 * match is tried first; where whitespace or entities differ, the selection's
 * first and last non-empty lines are matched in order instead. `hint` is the
 * selection's approximate position as a 0..1 fraction of the rendered document,
 * used only to choose among several identical matches.
 */
export function rangeForSelectedText(
  source: string,
  selected: string,
  hint = 0,
): LineRange | null {
  const needle = selected.replace(/\n\s*$/, "");
  if (needle.trim() === "") return null;

  const offset = nearestIndexOf(source, needle, hint);
  if (offset !== -1) return linesSpanning(source, offset, offset + needle.length - 1);

  // Rendered markdown drops the source's markers (list bullets, `**`, `[`, URL
  // targets, heading `#`) but keeps the words in order — and a link target can
  // interleave extra words (the URL) that the rendered text omits. Match the
  // selection's words as a subsequence of the source's word stream, anchored
  // near where the selection sits, and refuse rather than guess when it can't.
  const sourceWords = wordsWithOffsets(source);
  const selectedWords = needle.match(/[A-Za-z0-9_]+/g) ?? [];
  if (sourceWords.length === 0 || selectedWords.length === 0) return null;

  const anchor = Math.round((Number.isFinite(hint) ? hint : 0) * sourceWords.length);
  const match = mapSubsequence(sourceWords, selectedWords, anchor);
  if (match === null) {
    // Last resort: the longest selected word is the most distinctive and is
    // preserved verbatim by the renderer, so it anchors at least the one line
    // it sits on — narrower than the selection, but never a dead end.
    let longest = "";
    for (const word of selectedWords) {
      if (word.length > longest.length) longest = word;
    }
    const wordIndex = nearestWordIndex(sourceWords, longest, anchor);
    if (wordIndex === -1) return null;
    const span = sourceWords[wordIndex];
    return linesSpanning(source, span.start, span.end - 1);
  }
  return linesSpanning(source, sourceWords[match.start].start, sourceWords[match.end].end - 1);
}

interface WordSpan {
  text: string;
  start: number;
  end: number;
}

/** Word tokens and their source offsets; markdown punctuation is skipped. */
function wordsWithOffsets(source: string): WordSpan[] {
  const words: WordSpan[] = [];
  const re = /[A-Za-z0-9_]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    words.push({ text: match[0], start: match.index, end: match.index + match[0].length });
  }
  return words;
}

/**
 * The first and last source-word index of the first full occurrence of
 * `selected` as a subsequence of `source`, starting the search nearest
 * `anchorIndex`; null when no subsequence covers every selected word.
 */
function mapSubsequence(
  source: WordSpan[],
  selected: string[],
  anchorIndex: number,
): { start: number; end: number } | null {
  // Candidate starts nearest the anchor first, so the first full match wins and
  // the scan stays bounded no matter how large the file is.
  const order: number[] = [];
  const seen = new Set<number>();
  const push = (i: number) => {
    if (i >= 0 && i < source.length && !seen.has(i)) {
      seen.add(i);
      order.push(i);
    }
  };
  push(anchorIndex);
  for (let d = 1; d < source.length; d += 1) {
    push(anchorIndex - d);
    push(anchorIndex + d);
    if (order.length >= 2000) break;
  }

  for (const start of order) {
    let matched = 0;
    let first = -1;
    let last = -1;
    for (let p = start; p < source.length && matched < selected.length; p += 1) {
      if (source[p].text === selected[matched]) {
        if (first === -1) first = p;
        last = p;
        matched += 1;
      }
    }
    if (matched === selected.length) return { start: first, end: last };
  }
  return null;
}

/** The occurrence of `needle` closest to `hint * source.length`. */
function nearestIndexOf(source: string, needle: string, hint: number): number {
  if (needle === "") return -1;
  const target = Math.round((Number.isFinite(hint) ? hint : 0) * source.length);
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  let from = 0;
  for (;;) {
    const index = source.indexOf(needle, from);
    if (index === -1) break;
    const distance = Math.abs(index - target);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
    from = index + 1;
  }
  return best;
}

/** The index of `target` in `words` nearest to `anchorIndex`; -1 when absent. */
function nearestWordIndex(words: WordSpan[], target: string, anchorIndex: number): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < words.length; i += 1) {
    if (words[i].text !== target) continue;
    const distance = Math.abs(i - anchorIndex);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

/** The 1-based inclusive lines spanned by a character range. */
function linesSpanning(source: string, start: number, end: number): LineRange {
  return { start: lineNumberAt(source, start), end: lineNumberAt(source, end) };
}

/** The 1-based line of a character offset; newlines are line separators. */
function lineNumberAt(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) line += 1;
  }
  return line;
}
