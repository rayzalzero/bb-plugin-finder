import { useMemo } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { changeLabel, type ChangeKind } from "@/lib/git-status";

export interface ChangesListProps {
  /** Every changed path with its kind, as `gitChanges` reported it. */
  files: ReadonlyMap<string, ChangeKind>;
  origins: ReadonlyMap<string, "tracked" | "untracked">;
  /** Paths git reports as binary, so the row can say it has no text diff. */
  binaries: ReadonlySet<string>;
  /** The one-line summary the host computed. */
  shortstat: string;
  /** The file whose diff is open, highlighted in the list. */
  activePath: string | null;
  onOpenDiff(path: string): void;
  onClose(): void;
}

/**
 * Every uncommitted change, as one list.
 *
 * The tree badges answer "which file changed"; this answers "what changed" in
 * one scroll, which is the question a user asks after the agent finishes. It
 * lives in the editor area rather than the tree pane because a change set is
 * routinely hundreds of files — the tree column is too narrow to scan them.
 */
export function ChangesList({
  files,
  origins,
  binaries,
  shortstat,
  activePath,
  onOpenDiff,
  onClose,
}: ChangesListProps) {
  // Sorted by path so the list reads like the tree. A Map keeps insertion
  // order, which is git's own ordering and varies with the diff target.
  const rows = useMemo(
    () => [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
    [files],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1">
        <Icon name="DiffModified" aria-hidden className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Uncommitted changes</span>
        <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
          {rows.length}
        </span>
        <button
          type="button"
          title="Close the changes list"
          aria-label="Close the changes list"
          onClick={onClose}
          className="ml-auto rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="X" aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1" role="list" aria-label="Changed files">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">No uncommitted changes.</p>
        ) : (
          rows.map(([path, kind]) => {
            const badge = changeLabel(path, kind, origins.get(path) ?? "tracked");
            const binary = binaries.has(path);
            return (
              <button
                key={path}
                type="button"
                role="listitem"
                title={binary ? `${path} — binary, no text diff` : path}
                aria-current={path === activePath}
                onClick={() => onOpenDiff(path)}
                className={cn(
                  "flex w-full items-center gap-2 py-[3px] pr-2 pl-2 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                  path === activePath && "bg-accent text-accent-foreground",
                )}
              >
                <span className={cn("w-3 shrink-0 font-mono text-[10px]", badge.tone)}>
                  {badge.label}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
                {binary ? (
                  <span className="shrink-0 text-[10px] text-muted-foreground">binary</span>
                ) : null}
              </button>
            );
          })
        )}
      </div>

      {shortstat === "" ? null : (
        <div className="border-t border-border px-2 py-1 font-mono text-[10px] text-muted-foreground">
          {shortstat.trim()}
        </div>
      )}
    </div>
  );
}
