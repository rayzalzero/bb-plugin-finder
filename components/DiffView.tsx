import { useMemo } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { splitPatch, type SplitRow } from "@/lib/diff-parse";

/** One column of the diff: unified is a single column, split is two. */
export type DiffLayout = "unified" | "split";

export interface DiffViewProps {
  path: string;
  patch: string | null;
  /** "loading" while the single file's patch is in flight. */
  status: "idle" | "loading" | "ready" | "error";
  /** Why the patch could not be fetched, when status is "error". */
  message: string | null;
  layout: DiffLayout;
  onLayoutChange(layout: DiffLayout): void;
  onOpenFile(path: string): void;
  onClose(): void;
}

const TONE = {
  added: "text-emerald-300 bg-emerald-500/10",
  removed: "text-red-300 bg-red-500/10",
  meta: "text-muted-foreground",
  plain: "text-foreground/80",
} as const;

function toneOf(line: string): string {
  if (line.startsWith("+")) return TONE.added;
  if (line.startsWith("-")) return TONE.removed;
  if (line.startsWith("@@")) return TONE.meta;
  return TONE.plain;
}

function PatchLine({ line }: { line: string }) {
  return (
    <div className={cn("px-2", toneOf(line))}>
      {/* A blank context line is a single space in a unified diff; a truly
          empty string only appears as the dropped trailing newline, but an
          NBSP keeps the row's height so rare blank lines stay visible. */}
      {line === "" ? "\u00A0" : line}
    </div>
  );
}

/** A gutter number, right-aligned so the columns line up. */
function LineNo({ value }: { value: number | null }) {
  return (
    <span className="w-10 shrink-0 pr-2 text-right font-mono text-[10px] tabular-nums text-muted-foreground select-none">
      {value === null ? "" : value}
    </span>
  );
}

function SplitRowView({ row }: { row: SplitRow }) {
  if (row.kind === "hunk") {
    return (
      <div className={cn("px-2", TONE.meta)}>
        {row.text === null || row.text === "" ? "\u00A0" : row.text}
      </div>
    );
  }
  if (row.kind === "header") {
    return <div className={cn("px-2", TONE.meta)}>{row.text}</div>;
  }
  const changed = row.kind === "change";
  const leftTone = changed && row.left !== null ? TONE.removed : TONE.plain;
  const rightTone = changed && row.right !== null ? TONE.added : TONE.plain;
  return (
    <div className="flex">
      <div className={cn("flex min-w-0 flex-1 border-r border-border", leftTone)}>
        <LineNo value={row.leftNo} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
          {row.left === null ? "" : row.left === "" ? "\u00A0" : row.left}
        </span>
      </div>
      <div className={cn("flex min-w-0 flex-1", rightTone)}>
        <LineNo value={row.rightNo} />
        <span className="min-w-0 flex-1 whitespace-pre-wrap break-all pr-2">
          {row.right === null ? "" : row.right === "" ? "\u00A0" : row.right}
        </span>
      </div>
    </div>
  );
}

/**
 * A read-only diff of one file.
 *
 * Unified is the default because it fits a narrow pane; split is for reading a
 * change rather than scanning it, and pairs each removed line with the added
 * line at the same position in the block.
 */
export function DiffView({
  path,
  patch,
  status,
  message,
  layout,
  onLayoutChange,
  onOpenFile,
  onClose,
}: DiffViewProps) {
  const lines = useMemo(() => {
    if (patch === null) return [];
    const split = patch.split("\n");
    // The patch always ends with a newline, so `split` leaves one trailing
    // empty entry that is a separator, not a line of diff.
    while (split.length > 0 && split[split.length - 1] === "") split.pop();
    return split;
  }, [patch]);
  const rows = useMemo(
    () => (layout === "split" && patch !== null ? splitPatch(patch) : []),
    [layout, patch],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={path}>
          Changes to {path}
        </span>
        <div className="flex shrink-0 items-center gap-0.5 rounded border border-border p-0.5">
          <button
            type="button"
            title="Unified diff"
            aria-label="Unified diff"
            aria-pressed={layout === "unified"}
            onClick={() => onLayoutChange("unified")}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              layout === "unified" && "bg-accent text-accent-foreground",
            )}
          >
            Unified
          </button>
          <button
            type="button"
            title="Side-by-side diff"
            aria-label="Side-by-side diff"
            aria-pressed={layout === "split"}
            onClick={() => onLayoutChange("split")}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              layout === "split" && "bg-accent text-accent-foreground",
            )}
          >
            Split
          </button>
        </div>
        <button
          type="button"
          onClick={() => onOpenFile(path)}
          className="rounded border border-border px-2 py-0.5 text-xs hover:bg-accent hover:text-accent-foreground"
        >
          Open file
        </button>
        <button
          type="button"
          title="Close the diff"
          aria-label="Close the diff"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="X" aria-hidden className="size-3.5" />
        </button>
      </div>

      {status === "loading" || status === "idle" ? (
        <div className="flex flex-1 items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
          <Icon name="Loading" aria-hidden className="size-4 animate-spin" />
          <span>Loading the diff…</span>
        </div>
      ) : status === "error" ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-xs text-destructive">
            {message ?? "Could not read this file's diff."}
          </p>
        </div>
      ) : patch === null ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-xs text-muted-foreground">
            No diff for this file — it is unchanged, or its patch is too large to show here.
          </p>
        </div>
      ) : lines.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <p className="text-center text-xs text-muted-foreground">
            No textual change — this file is binary.
          </p>
        </div>
      ) : layout === "split" ? (
        <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-snug">
          {rows.map((row, index) => (
            <SplitRowView key={index} row={row} />
          ))}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto py-1 font-mono text-[11px] leading-snug whitespace-pre-wrap break-all">
          {lines.map((line, index) => (
            <PatchLine key={index} line={line} />
          ))}
        </div>
      )}
    </div>
  );
}
