import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { scopeKey, type ScopeRef } from "@/lib/route";
import type { SearchApi, SearchHit } from "./use-content-search";

export interface ContentSearchProps {
  search: SearchApi;
  /** Workspace the search belongs to; a change invalidates the shown results. */
  scope: ScopeRef | null;
  /**
   * Directories the search may be scoped to, outermost first. "" is the
   * workspace root. The list comes from the tree the user already has, so the
   * search never invents a scope Finder cannot show.
   */
  scopes: readonly string[];
  directory: string;
  onDirectoryChange(directory: string): void;
  onOpenHit(path: string, line: number): void;
  onClose(): void;
}

/** How long typing settles before a scan starts; a scan reads many files. */
const DEBOUNCE_MS = 350;

/**
 * Search inside the files of a folder.
 *
 * Distinct from the tree's filter, which only narrows the visible names: this
 * reads file contents and reports the matching lines. The query is debounced
 * because each run walks the workspace on the server, and options are held here
 * rather than in the workspace shell because they only mean anything to a scan.
 */
export function ContentSearch({
  search,
  scope,
  scopes,
  directory,
  onDirectoryChange,
  onOpenHit,
  onClose,
}: ContentSearchProps) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regexp, setRegexp] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  // Which file groups the user folded away, keyed by path rather than by index
  // so refining the query keeps the same files folded.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);

  const toggleGroup = (path: string): void =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const runRef = useRef(search.run);
  runRef.current = search.run;
  const clearRef = useRef(search.clear);
  clearRef.current = search.clear;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    // The pane must never describe an older query: results from the previous
    // scan are dropped the moment the query or its options change, and again
    // when the workspace changes, rather than sitting under the new text for
    // the debounce window.
    clearRef.current();
    if (query.trim() === "") return;
    const timer = window.setTimeout(
      () => runRef.current(query, { caseSensitive, regexp, wholeWord }, directory),
      DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timer);
    // `search` is a fresh object each render; its stable handles are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [caseSensitive, directory, query, regexp, wholeWord, scopeKey(scope)]);

  const grouped = useMemo(() => groupByFile(search.state.hits), [search.state.hits]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Folder to search in"
              aria-label="Search scope"
              className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              <Icon name="Folder" aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{scopeLabel(directory)}</span>
              <Icon name="ChevronDown" aria-hidden className="size-3 shrink-0" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-80 w-64 overflow-auto">
            <DropdownMenuLabel>Search in</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={directory} onValueChange={onDirectoryChange}>
              <DropdownMenuRadioItem value="">Entire workspace</DropdownMenuRadioItem>
              {scopes.map((scope) => (
                <DropdownMenuRadioItem key={scope} value={scope}>
                  <span className="truncate">{scope}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <button
          type="button"
          title="Close search"
          aria-label="Close search"
          onClick={onClose}
          className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="X" aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-col gap-1 px-2 py-1.5">
        <div className="relative">
          <Input
            ref={inputRef}
            value={query}
            placeholder="Search in files…"
            aria-label="Search file contents"
            aria-invalid={search.state.invalidPattern !== null}
            spellCheck={false}
            className={cn("h-7 pl-7 pr-7 text-xs", search.state.invalidPattern !== null && "border-destructive")}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
            }}
          />
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          {query === "" ? null : (
            <button
              type="button"
              title="Clear the search"
              aria-label="Clear the search"
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
            >
              <Icon name="X" aria-hidden className="size-3" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <OptionChip label="Match case" active={caseSensitive} onToggle={() => setCaseSensitive((v) => !v)} />
          <OptionChip label="Regexp" active={regexp} onToggle={() => setRegexp((v) => !v)} />
          <OptionChip label="By word" active={wholeWord} onToggle={() => setWholeWord((v) => !v)} />
        </div>
      </div>

      {search.state.status === "ready" && search.state.hits.length > 0 ? (
        <div className="flex items-center gap-1 border-b border-border px-2 py-0.5">
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {`${search.state.hits.length} matches in ${grouped.length} files`}
            {search.state.truncated ? " · partial, refine the search" : ""}
          </span>
          <button
            type="button"
            title="Collapse all files"
            aria-label="Collapse all files"
            onClick={() => setCollapsed(new Set(grouped.map((group) => group.path)))}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ChevronsUp" aria-hidden className="size-3.5" />
          </button>
          <button
            type="button"
            title="Expand all files"
            aria-label="Expand all files"
            onClick={() => setCollapsed(new Set())}
            className="shrink-0 rounded p-1 text-muted-foreground hover:bg-state-hover hover:text-foreground"
          >
            <Icon name="ChevronsDown" aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {search.state.invalidPattern !== null ? (
          <p className="px-3 py-2 text-xs text-destructive">
            Invalid regular expression: {search.state.invalidPattern}
          </p>
        ) : search.state.error !== null ? (
          <p className="px-3 py-2 text-xs text-destructive">{search.state.error}</p>
        ) : search.state.status === "searching" ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">Searching…</p>
        ) : query.trim() === "" ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            Type to search the contents of every file under this folder.
          </p>
        ) : search.state.hits.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {`No matches in ${search.state.filesScanned} files.`}
          </p>
        ) : (
          <>
            {grouped.map((group) => (
              <div key={group.path} className="border-b border-border/40 last:border-b-0">
                <button
                  type="button"
                  aria-expanded={!collapsed.has(group.path)}
                  title={group.path}
                  onClick={() => toggleGroup(group.path)}
                  className="sticky top-0 z-10 flex w-full items-center gap-1 border-b border-border/60 bg-background/95 px-1.5 py-1 text-left backdrop-blur hover:bg-state-hover"
                >
                  <Icon
                    name={collapsed.has(group.path) ? "ChevronRight" : "ChevronDown"}
                    aria-hidden
                    className="size-3.5 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11px] font-medium text-foreground">
                    {group.path}
                  </span>
                  <span className="shrink-0 pr-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {group.hits.length}
                  </span>
                </button>
                {collapsed.has(group.path) ? null : group.hits.map((hit) => (
                  <button
                    key={`${hit.line}:${hit.column}`}
                    type="button"
                    title={`${hit.path}:${hit.line}`}
                    onClick={() => onOpenHit(hit.path, hit.line)}
                    className="flex w-full items-baseline gap-2 py-[3px] pr-2 text-left hover:bg-state-hover"
                  >
                    <span className="w-10 shrink-0 pr-1 text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                      {hit.line}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground/80">
                      {hit.text.slice(0, hit.matchStart)}
                      <mark className="rounded-sm bg-primary/25 px-0.5 text-foreground">
                        {hit.text.slice(hit.matchStart, hit.matchEnd)}
                      </mark>
                      {hit.text.slice(hit.matchEnd)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

/** The scope as the header shows it: the folder's own name, not its path. */
function scopeLabel(directory: string): string {
  if (directory === "") return "Entire workspace";
  return directory.slice(directory.lastIndexOf("/") + 1);
}

/** Hits grouped by file, preserving the order the server scanned them in. */
function groupByFile(hits: readonly SearchHit[]): Array<{ path: string; hits: SearchHit[] }> {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of hits) {
    const existing = groups.get(hit.path);
    if (existing === undefined) groups.set(hit.path, [hit]);
    else existing.push(hit);
  }
  return [...groups].map(([path, fileHits]) => ({ path, hits: fileHits }));
}

function OptionChip({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "rounded-md border px-1.5 py-1 text-[11px]",
        active
          ? "border-input bg-state-active text-foreground"
          : "border-transparent text-muted-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {label}
    </button>
  );
}
