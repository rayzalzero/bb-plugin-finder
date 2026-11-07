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
