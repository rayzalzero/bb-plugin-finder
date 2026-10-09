import { Icon } from "@/components/ui/icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { WorkspaceOption } from "../server.js";
import { sameScope, type ScopeRef } from "@/lib/route";

export interface WorkspacePickerProps {
  workspaces: WorkspaceOption[] | null;
  scope: ScopeRef | null;
  /** What the scope is, when it is not one of the listed workspaces. */
  scopeLabel?: string | null;
  onChange(scope: ScopeRef): void;
}

/** Switch which workspace Finder is browsing. */
export function WorkspacePicker({ workspaces, scope, scopeLabel, onChange }: WorkspacePickerProps) {
  const current = workspaces?.find((entry) => sameScope(entry.ref, scope)) ?? null;
  // A thread scope is never in the list — the list holds project checkouts and
  // environments — so the trigger falls back to the label the caller supplied
  // rather than claiming nothing is selected.
  const label = current?.label ?? scopeLabel ?? "Choose workspace";

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-xs",
              "hover:bg-accent hover:text-accent-foreground",
            )}
          >
            <Icon name="FolderGit" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{label}</span>
            {current === null ? null : (
              <span className="truncate text-muted-foreground">{current.sublabel}</span>
            )}
            <Icon name="ChevronDown" aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-80 w-72 overflow-auto">
          <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
          <DropdownMenuSeparator />
          {workspaces === null ? (
            <DropdownMenuItem disabled>Loading…</DropdownMenuItem>
          ) : workspaces.length === 0 ? (
            <DropdownMenuItem disabled>No workspaces yet</DropdownMenuItem>
          ) : (
            workspaces.map((entry) => (
              <DropdownMenuItem
                key={`${entry.ref.kind}:${entry.ref.id}`}
                onSelect={() => onChange(entry.ref)}
                className="flex items-center gap-2"
              >
                <Icon
                  name={entry.kind === "environment" ? "GitBranch" : "FolderGit"}
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground"
                />
                <span className="truncate">{entry.label}</span>
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {entry.sublabel}
                </span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
