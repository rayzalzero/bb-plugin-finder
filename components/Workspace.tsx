import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import { toast } from "sonner";
import { Explorer } from "./Explorer";
import { FileView } from "./FileView";
import { useAddToChat } from "./use-add-to-chat";
import { fileToBase64, useTree, useTreeMutations, type TreeState } from "./use-tree";
import { isDirty, useFileTabs } from "./use-file-tabs";
import { cn } from "@/lib/utils";
import { ancestorsOf } from "@/lib/tree";
import { patchWorkspaceState, readWorkspaceState } from "@/lib/workspace-state";
import { useContentSearch } from "./use-content-search";
import { ContentSearch } from "./ContentSearch";
import { scopeKey } from "@/lib/route";
import type { ScopeRef } from "@/lib/route";
import {
  AUTOSAVE_DELAY_MS,
  AUTOSAVE_KEY,
  LINE_WRAP_KEY,
  readPref,
  readPrefFlag,
  writePref,
} from "@/lib/prefs";

export interface WorkspaceProps {
  scope: ScopeRef | null;
  filePath: string | null;
  /** Called when the open file changes, so a routed surface can mirror it. */
  onOpenPath(path: string | null): void;
}

const WIDTH_STORAGE_KEY = "finder:explorer-width";
const MIN_EXPLORER_PX = 180;
const MAX_EXPLORER_PX = 560;
const DEFAULT_EXPLORER_PX = 260;
const HIDDEN_STORAGE_KEY = "finder:include-hidden";

export function Workspace({ scope, filePath, onOpenPath }: WorkspaceProps) {
  // Everything below is per-workspace state, so the whole shell is keyed on the
  // workspace: switching scope remounts it and re-seeds each piece from the
  // destination's stored state. Keeping it mounted and re-seeding in an effect
  // would let the persist effects write the source workspace's expansion set and
  // target directory into the destination's record before the new values landed.
  return (
    <WorkspaceState
      key={scopeKey(scope)}
      scope={scope}
      filePath={filePath}
      onOpenPath={onOpenPath}
    />
  );
}

function WorkspaceState({ scope, filePath, onOpenPath }: WorkspaceProps) {
  const [includeHidden, setIncludeHidden] = useState(() =>
    readPrefFlag(HIDDEN_STORAGE_KEY, false),
  );
  const [filter, setFilter] = useState("");
  // Remembered per workspace: the host unmounts this whole tree when the panel
  // closes or another tab takes the front, so anything kept only in React state
  // would be gone when the user comes back.
  const workspaceKey = scopeKey(scope);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(readWorkspaceState(workspaceKey).expanded),
  );
  const [selectedDirectory, setSelectedDirectory] = useState(
    () => readWorkspaceState(workspaceKey).selectedDirectory,
  );
  const [isTreeOpen, setIsTreeOpen] = useState(true);
  /** The tree pane shows either the file tree or the content search. */
  const [treeMode, setTreeMode] = useState<"tree" | "search">("tree");
  /** Line a search hit asked the editor to reveal, consumed by the pane below. */
  const [revealLine, setRevealLine] = useState<number | null>(null);
  const [isEditorOpen, setIsEditorOpen] = useState(true);
  const [explorerWidth, setExplorerWidth] = useState(
    () => Number(readPref(WIDTH_STORAGE_KEY, String(DEFAULT_EXPLORER_PX))) || DEFAULT_EXPLORER_PX,
  );
  const [lineWrap, setLineWrap] = useState(() => readPrefFlag(LINE_WRAP_KEY, true));
  const [autosave, setAutosave] = useState(() => readPrefFlag(AUTOSAVE_KEY, false));

  const tree = useTree(scope, includeHidden);
  const tabs = useFileTabs(scope);
  const contentSearch = useContentSearch(scope, includeHidden);
  const addToChat = useAddToChat(scope);
  const uploadInput = useRef<HTMLInputElement | null>(null);
  const uploadDirectory = useRef("");

  const mutations = useTreeMutations(scope, () => {
    tree.invalidate();
  });

  useEffect(() => {
    writePref(HIDDEN_STORAGE_KEY, String(includeHidden));
  }, [includeHidden]);
  useEffect(() => {
    writePref(LINE_WRAP_KEY, String(lineWrap));
  }, [lineWrap]);
  useEffect(() => {
    writePref(AUTOSAVE_KEY, String(autosave));
  }, [autosave]);
  useEffect(() => {
    writePref(WIDTH_STORAGE_KEY, String(explorerWidth));
  }, [explorerWidth]);
  useEffect(() => {
    patchWorkspaceState(workspaceKey, { expanded: [...expanded] });
  }, [expanded, workspaceKey]);
  useEffect(() => {
    patchWorkspaceState(workspaceKey, { selectedDirectory });
  }, [selectedDirectory, workspaceKey]);

  // The route names the open file, so a link, a reload, or back/forward lands
  // on the file it names. Opening through the route is what makes that work;
  // the tab store only follows.
  const routePath = filePath;
  // `tabs` itself is a new object whenever a tab is patched, so the effect must
  // depend on the stable `open` handle rather than on the whole API.
  const openTab = tabs.open;
  useEffect(() => {
    if (routePath === null) return;
    openTab(routePath);
  }, [openTab, routePath]);

  const activeTab = tabs.activeTab;
  useEffect(() => {
    if (activeTab === null || activeTab.path === routePath) return;
    onOpenPath(activeTab.path);
  }, [activeTab, onOpenPath, routePath]);

  // Auto-save, off by default. The toolbar toggle used to be read-only state:
  // nothing ever wrote the draft, so "Auto-save on" saved nothing. The save
  // callback is read through a ref rather than being an effect dependency, so a
  // conflict or error state does not retrigger the timer on every render.
  const saveTab = tabs.save;
  const saveRef = useRef(saveTab);
  saveRef.current = saveTab;
  const activePath = tabs.activePath;
  const activeFile = activeTab?.file ?? null;
  const activeEditable = activeFile !== null && activeFile.kind === "text" && activeFile.editable;
  const activeDirty = activeTab !== null && isDirty(activeTab);
  useEffect(() => {
    if (!autosave || !activeDirty || !activeEditable || activePath === null) return;
    // Only a clean or already-saved tab is auto-written. A conflict waits for
    // the user's Reload / Save again, and a failed write waits for Retry —
    // otherwise the timer would fire again every 1.2 s and fight the user for
    // the file.
    if (activeTab?.save.kind !== "clean") return;
    const timer = window.setTimeout(() => saveRef.current(activePath), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [activeDirty, activeEditable, activePath, activeTab, autosave]);

  // Reveal a routed file in the tree without collapsing what the user opened.
  useEffect(() => {
    if (routePath === null) return;
    const ancestors = ancestorsOf(routePath);
    setExpanded((current) => {
      if (ancestors.every((path) => current.has(path))) return current;
      const next = new Set(current);
      for (const path of ancestors) next.add(path);
      return next;
    });
  }, [routePath]);

  const toggleExpanded = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const openFile = useCallback(
    (path: string) => {
      tabs.open(path);
      onOpenPath(path);
    },
    [onOpenPath, tabs],
  );

  const openSearchHit = useCallback(
    (path: string, line: number) => {
      openFile(path);
      setRevealLine(line);
    },
    [openFile],
  );

  const closeTab = useCallback(
    (path: string) => {
      const next = tabs.close(path);
      if (next !== path) onOpenPath(next);
    },
    [onOpenPath, tabs],
  );

  const onPickUpload = useCallback(
    async (files: FileList | null) => {
      if (files === null || files.length === 0) return;
      const payload = await Promise.all(
        Array.from(files, async (file) => ({
          name: file.name,
          contentBase64: await fileToBase64(file),
        })),
      );
      mutations.upload(uploadDirectory.current, payload);
    },
    [mutations],
  );

  // Every directory in the workspace, so the search scope can be widened from a
  // folder back to the whole workspace without hunting for it in the tree.
  const searchScopes = useMemo(
    () =>
      tree.state.entries
        .filter((entry) => entry.kind === "directory")
        .map((entry) => entry.path),
    [tree.state.entries],
  );

  const hiddenCount = useMemo(
    () => tree.state.entries.filter((entry) => entry.path.split("/").some((s) => s.startsWith("."))).length,
    [tree.state.entries],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspaceHeader
        tree={tree.state}
        includeHidden={includeHidden}
        onToggleHidden={() => setIncludeHidden((current) => !current)}
        hiddenCount={hiddenCount}
        isTreeOpen={isTreeOpen}
        onToggleTree={() => setIsTreeOpen((current) => !current)}
        isEditorOpen={isEditorOpen}
        onToggleEditor={() => setIsEditorOpen((current) => !current)}
        onRefresh={tree.refresh}
        tabs={tabs.tabs.map((tab) => ({ path: tab.path, dirty: tab.save.kind !== "clean" }))}
        activePath={tabs.activePath}
        onActivateTab={openFile}
        onCloseTab={closeTab}
      />

      <div className="flex min-h-0 flex-1">
        {isTreeOpen ? (
          <>
            <div
              className="min-h-0 shrink-0 border-r border-border"
              style={{ width: `${explorerWidth}px` }}
            >
              {treeMode === "search" ? (
                <ContentSearch
                  search={contentSearch}
                  scope={scope}
                  scopes={searchScopes}
                  directory={selectedDirectory}
                  onDirectoryChange={setSelectedDirectory}
                  onOpenHit={openSearchHit}
                  onClose={() => setTreeMode("tree")}
                />
              ) : (
              <Explorer
                entries={tree.state.entries}
                expanded={expanded}
                onToggleExpanded={toggleExpanded}
                onSetExpanded={(paths) => setExpanded(new Set(paths))}
                activePath={tabs.activePath}
                onOpenFile={openFile}
                filter={filter}
                onFilterChange={setFilter}
                selectedDirectory={selectedDirectory}
                onSelectDirectory={setSelectedDirectory}
                onCreate={mutations.create}
                onRename={mutations.rename}
                onRemove={mutations.remove}
                onUpload={(directory) => {
                  uploadDirectory.current = directory;
                  uploadInput.current?.click();
                }}
                onRefresh={tree.refresh}
                onOpenSearch={() => setTreeMode("search")}
              />
              )}
            </div>
            <ResizeHandle
              width={explorerWidth}
              onResize={(next) =>
                setExplorerWidth(Math.min(MAX_EXPLORER_PX, Math.max(MIN_EXPLORER_PX, next)))
              }
            />
          </>
        ) : null}

        {isEditorOpen ? (
          <div className="min-h-0 min-w-0 flex-1">
            {activeTab === null ? (
              <EmptyPane
                workspace={tree.state.scope}
                error={tree.state.error}
                onOpenTree={() => setIsTreeOpen(true)}
              />
            ) : (
              <FileView
                tab={activeTab}
                autosave={autosave}
                lineWrap={lineWrap}
                onToggleLineWrap={() => setLineWrap((current) => !current)}
                onToggleAutosave={() => setAutosave((current) => !current)}
                onChangeDraft={tabs.setDraft}
                onSave={tabs.save}
                onReload={tabs.reload}
                onSetMode={tabs.setMode}
                revealLine={revealLine}
                // The line is a one-shot: cleared as soon as the pane has taken
                // it, so opening the next file does not drag the caret back to a
                // line the user never asked for.
                onRevealConsumed={() => setRevealLine(null)}
                onAddToChat={addToChat}
                onCopyContent={(_path, text) => {
                  void navigator.clipboard
                    .writeText(text)
                    .then(() => toast.success("Contents copied"))
                    .catch(() => toast.error("Could not copy the contents"));
                }}
                onCopyPath={(path) => {
                  void navigator.clipboard
                    .writeText(path)
                    .then(() => toast.success("Path copied"))
                    .catch(() => toast.error("Could not copy the path"));
                }}
              />
            )}
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <button
              type="button"
              onClick={() => setIsEditorOpen(true)}
              className="rounded border border-dashed border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            >
              Show the editor
            </button>
          </div>
        )}
      </div>

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void onPickUpload(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}

interface WorkspaceHeaderProps {
  tree: TreeState;
  includeHidden: boolean;
  hiddenCount: number;
  onToggleHidden(): void;
  isTreeOpen: boolean;
  onToggleTree(): void;
  isEditorOpen: boolean;
  onToggleEditor(): void;
  onRefresh(): void;
  tabs: Array<{ path: string; dirty: boolean }>;
  activePath: string | null;
  onActivateTab(path: string): void;
  onCloseTab(path: string): void;
}

function WorkspaceHeader({
  tree,
  includeHidden,
  hiddenCount,
  onToggleHidden,
  isTreeOpen,
  onToggleTree,
  isEditorOpen,
  onToggleEditor,
  onRefresh,
  tabs,
  activePath,
  onActivateTab,
  onCloseTab,
}: WorkspaceHeaderProps) {
  return (
    <div className="flex flex-col border-b border-border">
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          type="button"
          title={isTreeOpen ? "Hide the file tree" : "Show the file tree"}
          aria-label={isTreeOpen ? "Hide the file tree" : "Show the file tree"}
          aria-pressed={isTreeOpen}
          onClick={onToggleTree}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            isTreeOpen && "bg-accent text-accent-foreground",
          )}
        >
          <Icon name="PanelLeft" aria-hidden className="size-3.5" />
        </button>
        <button
          type="button"
          title={isEditorOpen ? "Hide the editor" : "Show the editor"}
          aria-label={isEditorOpen ? "Hide the editor" : "Show the editor"}
          aria-pressed={isEditorOpen}
          onClick={onToggleEditor}
          className={cn(
            "rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            isEditorOpen && "bg-accent text-accent-foreground",
          )}
        >
          <Icon name="Columns2" aria-hidden className="size-3.5" />
        </button>

        <span className="mx-1 truncate text-xs font-medium">
          {tree.scope?.label ?? "Finder"}
          {tree.scope === null ? null : (
            <span className="ml-1.5 font-normal text-muted-foreground">
              {tree.scope.sublabel}
              {tree.scope.isLocal ? "" : ` · ${tree.scope.hostName}`}
            </span>
          )}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
          {tree.listing === "remote" && includeHidden ? (
            <span
              className="pr-1 text-[10px] text-amber-400"
              title="Remote listings never include dotfiles."
            >
              dotfiles unavailable
            </span>
          ) : null}
          <button
            type="button"
            title={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
            aria-label={includeHidden ? "Hide dotfiles" : "Show dotfiles"}
            aria-pressed={includeHidden}
            onClick={onToggleHidden}
            className={cn(
              "rounded px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              includeHidden && "bg-accent text-accent-foreground",
            )}
          >
            {includeHidden ? `.files (${hiddenCount})` : ".files"}
          </button>
          <button
            type="button"
            title="Refresh the folder"
            aria-label="Refresh the folder"
            onClick={onRefresh}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Icon name="ArrowReloadHorizontal" aria-hidden className="size-3.5" />
          </button>
        </div>
      </div>

      {tabs.length === 0 ? null : (
        <div className="flex items-stretch overflow-x-auto border-t border-border">
          {tabs.map((tab) => (
            <div
              key={tab.path}
              className={cn(
                "group flex max-w-56 shrink-0 items-center gap-1 border-r border-border py-1 pl-1 pr-2 text-xs",
                tab.path === activePath
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/50",
              )}
            >
              <button
                type="button"
                aria-label={`Close ${tab.path}`}
                onClick={() => onCloseTab(tab.path)}
                className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 hover:bg-background"
              >
                <Icon name="X" aria-hidden className="size-3" />
              </button>
              <button
                type="button"
                onClick={() => onActivateTab(tab.path)}
                title={tab.path}
                className="truncate"
              >
                {tab.path.slice(tab.path.lastIndexOf("/") + 1)}
              </button>
              {tab.dirty ? <span className="size-1.5 shrink-0 rounded-full bg-amber-400" /> : null}
            </div>
          ))}
        </div>
      )}

      {tree.status === "error" && tree.error !== null ? (
        <p className="border-t border-border bg-destructive/10 px-3 py-1 text-xs text-destructive">
          {tree.error}
        </p>
      ) : null}
      {tree.truncated ? (
        <p className="border-t border-border bg-amber-500/10 px-3 py-1 text-xs text-amber-200">
          The listing was truncated — this workspace has more files than the plugin lists at once.
        </p>
      ) : null}
    </div>
  );
}

function ResizeHandle({ width, onResize }: { width: number; onResize(next: number): void }) {
  const startX = useRef(0);
  const startWidth = useRef(width);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree"
      tabIndex={0}
      onPointerDown={(event) => {
        startX.current = event.clientX;
        startWidth.current = width;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onResize(startWidth.current + (event.clientX - startX.current));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") onResize(width - 16);
        if (event.key === "ArrowRight") onResize(width + 16);
      }}
      className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-accent"
    />
  );
}

function EmptyPane({
  workspace,
  error,
  onOpenTree,
}: {
  workspace: { label: string; root: string } | null;
  error: string | null;
  onOpenTree(): void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <Icon name="FileText" aria-hidden className="size-6 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">
        {error !== null
          ? error
          : workspace === null
            ? "Pick a workspace to browse its files."
            : `Open a file from the tree to read or edit it.`}
      </p>
      {workspace === null ? null : (
        <p className="max-w-md truncate font-mono text-[10px] text-muted-foreground">
          {workspace.root}
        </p>
      )}
      <button
        type="button"
        onClick={onOpenTree}
        className="rounded border border-border px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        Show the file tree
      </button>
    </div>
  );
}
