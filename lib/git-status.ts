/**
 * The presentation of a git change: a one-letter code plus a color, shared by
 * the tree badges and the diff viewer so the two can never drift apart.
 */

export type ChangeKind =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed";

export const CHANGE_KIND_LABEL: Record<ChangeKind, string> = {
  added: "A",
  copied: "C",
  deleted: "D",
  modified: "M",
  renamed: "R",
  type_changed: "T",
};

export const CHANGE_KIND_TONE: Record<ChangeKind, string> = {
  added: "text-emerald-400",
  deleted: "text-red-400",
  modified: "text-amber-400",
  renamed: "text-sky-400",
  copied: "text-violet-400",
  type_changed: "text-violet-400",
};

export function changeLabel(
  path: string,
  kind: ChangeKind,
  origin: "tracked" | "untracked",
): { label: string; tone: string } {
  // An untracked file has no diff letter, so it reads as "something new".
  if (origin === "untracked") {
    return { label: "?", tone: "text-muted-foreground" };
  }
  return { label: CHANGE_KIND_LABEL[kind], tone: CHANGE_KIND_TONE[kind] };
}