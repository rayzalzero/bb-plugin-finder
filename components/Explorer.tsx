import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { cn } from "@/lib/utils";
import { extensionOf } from "@/lib/file-kind";
import {
  allDirectoryPaths,
  ancestorsOf,
  buildTree,
  filterTree,
  visibleRows,
  type FlatEntry,
} from "@/lib/tree";

export interface ExplorerProps {
  entries: FlatEntry[];
  expanded: ReadonlySet<string>;
  onToggleExpanded(path: string): void;
  onSetExpanded(paths: string[]): void;
  activePath: string | null;
  onOpenFile(path: string): void;
  filter: string;
  onFilterChange(value: string): void;
  /** Directory new files and uploads land in; "" is the workspace root. */
  selectedDirectory: string;
  onSelectDirectory(path: string): void;
  onCreate(directory: string, name: string, kind: "file" | "directory"): void;
  onRename(path: string, name: string): void;
  onRemove(path: string, recursive: boolean): void;
  onUpload(directory: string): void;
  onRefresh(): void;
  /** Switch the pane from the file tree to the content search. */
  onOpenSearch(): void;
}

/** A colored glyph per file family, so a glance is enough in a deep tree. */
const FILE_TONE: Readonly<Record<string, string>> = {
  css: "text-sky-400",
  go: "text-cyan-400",
  html: "text-orange-400",
  java: "text-red-400",
  javascript: "text-yellow-400",
  json: "text-amber-400",
  md: "text-blue-400",
  php: "text-violet-400",
  python: "text-emerald-400",
  rs: "text-orange-300",
  sh: "text-lime-400",
  sql: "text-fuchsia-400",
  ts: "text-blue-400",
  xml: "text-teal-400",
  yaml: "text-pink-400",
};

function FileGlyph({ path }: { path: string }) {
  return (
    <Icon
      name="File"
      aria-hidden
      className={cn("size-3.5 shrink-0", FILE_TONE[extensionOf(path)] ?? "text-muted-foreground")}
    />
  );
}

/** The inline input the tree shows for "new file", "new folder", and "rename". */
interface PendingInput {
  kind: "file" | "directory" | "rename";
  directory: string;
  /** Set for a rename. */
  path: string | null;
  initial: string;
}

const NO_PATHS: ReadonlySet<string> = new Set<string>();

export function Explorer({
  entries,
  expanded,
  onToggleExpanded,
  onSetExpanded,
  activePath,
  onOpenFile,
  filter,
  onFilterChange,
  selectedDirectory,
  onSelectDirectory,
  onCreate,
  onRename,
  onRemove,
  onUpload,
  onRefresh,
  onOpenSearch,
}: ExplorerProps) {
  const [pending, setPending] = useState<PendingInput | null>(null);
  const [draftName, setDraftName] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  const tree = useMemo(() => buildTree(entries), [entries]);
  const filtering = filter.trim() !== "";
  // While a filter is active every matching directory is open by default so the
  // hits are visible; a directory the user folds away is recorded against the
  // query it was folded under, so refining the query starts from open again.
  const [foldedUnderFilter, setFoldedUnderFilter] = useState<{
    query: string;
    paths: ReadonlySet<string>;
  }>(() => ({ query: "", paths: NO_PATHS }));
  const folded = foldedUnderFilter.query === filter ? foldedUnderFilter.paths : NO_PATHS;

  const filtered = useMemo(() => filterTree(tree, filter), [filter, tree]);
  const effectiveExpanded = useMemo(() => {
    if (!filtering || folded.size === 0) return filtering ? filtered.expand : expanded;
    return new Set([...filtered.expand].filter((path) => !folded.has(path)));
  }, [expanded, filtered.expand, filtering, folded]);
  const rows = useMemo(
    () => visibleRows(filtered.nodes, effectiveExpanded),
    [effectiveExpanded, filtered.nodes],
  );
  // Counted once per listing rather than on every render: the footer shows it,
  // and a render happens on every keystroke in the filter box.
  const fileCount = useMemo(
    () => entries.reduce((total, entry) => (entry.kind === "file" ? total + 1 : total), 0),
    [entries],
  );

  const toggleDirectory = (path: string): void => {
    if (!filtering) {
      onToggleExpanded(path);
      return;
    }
    const paths = new Set(folded);
    if (paths.has(path)) paths.delete(path);
    else paths.add(path);
    setFoldedUnderFilter({ query: filter, paths });
  };

  /** "Expand all" / "Collapse all", in both the plain tree and a filtered one. */
  const setAllDirectories = (paths: Iterable<string>): void => {
    if (!filtering) {
      onSetExpanded([...paths]);
      return;
    }
    const opened = new Set(paths);
    setFoldedUnderFilter({
      query: filter,
      paths: new Set([...filtered.expand].filter((path) => !opened.has(path))),
    });
  };

  useEffect(() => {
    if (pending === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [pending]);

  const begin = (next: PendingInput) => {
    setPending(next);
    setDraftName(next.initial);
    if (next.kind === "rename" || next.directory === "") return;
    // Reveal the target so the input is not typed into a collapsed subtree —
    // without collapsing everything else the user had open. Under a filter the
    // open set is derived from the query, so unfolding is the lever there.
    const reveal = [...ancestorsOf(next.directory), next.directory];
    if (!filtering) {
      onSetExpanded([...new Set([...expanded, ...reveal])]);
      return;
    }
    const paths = new Set(folded);
    for (const path of reveal) paths.delete(path);
    setFoldedUnderFilter({ query: filter, paths });
  };

  const commit = () => {
    if (pending === null) return;
    const name = draftName.trim();
    setPending(null);
    if (name === "") return;
    if (pending.kind === "rename") {
      if (pending.path !== null && name !== pending.initial) onRename(pending.path, name);
      return;
    }
    onCreate(pending.directory, name, pending.kind === "directory" ? "directory" : "file");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <div className="relative min-w-0 flex-1">
          <Icon
            name="Search"
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={filter}
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder="Filter files…"
            aria-label="Filter files by path"
            className="h-7 pl-7 text-xs"
          />
        </div>
        <button
          type="button"
          title="Search in file contents"
          aria-label="Search in file contents"
          onClick={onOpenSearch}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="Search" aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-2" role="tree" aria-label="Finder">
        {rows.length === 0 ? (
          <p className="px-3 py-2 text-xs text-muted-foreground">
            {filtering ? `No match for “${filter}”.` : "No files."}
          </p>
        ) : null}

        {rows.map(({ node, depth }) => {
          const isDirectory = node.kind === "directory";
          const isExpanded = effectiveExpanded.has(node.path);
          const isActive = node.path === activePath;
          const isTarget = isDirectory && node.path === selectedDirectory;

          return (
            <ContextMenu key={`${node.kind}:${node.path}`}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  role="treeitem"
                  aria-selected={isActive}
                  aria-expanded={isDirectory ? isExpanded : undefined}
                  title={node.path}
                  onClick={() => {
                    if (isDirectory) {
                      onSelectDirectory(node.path);
                      toggleDirectory(node.path);
                    } else {
                      onOpenFile(node.path);
                    }
                  }}
                  style={{ paddingLeft: `${depth * 12 + 8}px` }}
                  className={cn(
                    "flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs hover:bg-accent hover:text-accent-foreground",
                    isActive && "bg-accent text-accent-foreground",
                    isTarget && !isActive && "bg-accent/60",
                  )}
                >
                  <Icon
                    name={isDirectory ? (isExpanded ? "ChevronDown" : "ChevronRight") : "Code"}
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground",
                      !isDirectory && "invisible",
                    )}
                  />
                  {isDirectory ? (
                    <Icon
                      name={isExpanded ? "FolderOpen" : "Folder"}
                      aria-hidden
                      className="size-3.5 shrink-0 text-muted-foreground"
                    />
                  ) : (
                    <FileGlyph path={node.path} />
                  )}
                  <span className="truncate">{node.name}</span>
                </button>
              </ContextMenuTrigger>

              <ContextMenuContent>
                {isDirectory ? (
                  <>
                    <ContextMenuItem onSelect={() => begin({ kind: "file", directory: node.path, path: null, initial: "" })}>
                      New file
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => begin({ kind: "directory", directory: node.path, path: null, initial: "" })}>
                      New folder
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onUpload(node.path)}>Upload files…</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => onCopy(node.path)}>Copy relative path</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => begin({ kind: "rename", directory: "", path: node.path, initial: node.name })}>
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onRemove(node.path, true)}>Delete folder</ContextMenuItem>
                  </>
                ) : (
                  <>
                    <ContextMenuItem onSelect={() => onOpenFile(node.path)}>Open</ContextMenuItem>
                    <ContextMenuItem onSelect={() => onCopy(node.path)}>Copy relative path</ContextMenuItem>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={() => begin({ kind: "rename", directory: "", path: node.path, initial: node.name })}>
                      Rename
                    </ContextMenuItem>
                    <ContextMenuItem onSelect={() => onRemove(node.path, false)}>Delete</ContextMenuItem>
                  </>
                )}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
      </div>

      {pending === null ? null : (
        <form
          className="flex items-center gap-1 border-t border-border px-2 py-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            commit();
          }}
        >
          <Icon
            name={pending.kind === "directory" ? "Folder" : "File"}
            aria-hidden
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <Input
            ref={inputRef}
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Escape") setPending(null);
            }}
            aria-label={
              pending.kind === "rename"
                ? "New name"
                : pending.kind === "directory"
                  ? "New folder name"
                  : "New file name"
            }
            placeholder={pending.kind === "directory" ? "folder-name" : "file-name.ext"}
            className="h-6 text-xs"
          />
        </form>
      )}

      <div className="flex items-center gap-0.5 border-t border-border px-1.5 py-1">
        <FooterAction label="New file" icon="Plus" run={() => begin({ kind: "file", directory: selectedDirectory, path: null, initial: "" })} />
        <FooterAction label="New folder" icon="FolderPlus" run={() => begin({ kind: "directory", directory: selectedDirectory, path: null, initial: "" })} />
        <FooterAction label="Upload files" icon="ArrowUp" run={() => onUpload(selectedDirectory)} />
        <FooterAction label="Refresh" icon="ArrowReloadHorizontal" run={onRefresh} />
        <FooterAction label="Expand all" icon="ChevronsDown" run={() => setAllDirectories(allDirectoryPaths(tree))} />
        <FooterAction label="Collapse all" icon="ChevronsUp" run={() => setAllDirectories([])} />
        <span className="ml-auto truncate pr-1 text-[10px] text-muted-foreground">
          {selectedDirectory === "" ? "root" : selectedDirectory}
          {` · ${fileCount} files`}
        </span>
      </div>
    </div>
  );
}

function FooterAction({ label, icon, run }: { label: string; icon: string; run: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={run}
      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
    >
      <Icon name={icon} aria-hidden className="size-3.5" />
    </button>
  );
}

/** Copy to the clipboard and confirm, since the tree has no other feedback. */
function onCopy(relativePath: string): void {
  void navigator.clipboard
    .writeText(relativePath)
    .then(() => toast.success("Path copied"))
    .catch(() => toast.error("Could not copy the path"));
}
