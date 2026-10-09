import { useCallback, useEffect, useMemo, useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
  type PluginNavPanelProps,
  type PluginThreadHeaderActionProps,
  type PluginThreadPanelProps,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, WorkspaceOption } from "./server.js";
import { formatRoute, parseRoute, sameScope, type ScopeKind, type ScopeRef } from "@/lib/route";
import { Workspace } from "./components/Workspace";
import { FileOpenerTab } from "./components/FileOpenerTab";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { Icon } from "./components/ui/icon";
import { openableExtensions } from "./lib/file-kind";
import { cn } from "./lib/utils";

const PANEL_PATH = "files";
/** Tab title the panel opens with; the header button matches it in the host tab strip. */
const PANEL_TAB_TITLE = "Finder";
const LAST_SCOPE_KEY = "finder:last-scope";

/**
 * The full-page Finder. The route carries both the workspace and the open
 * file, so back/forward walk the files you opened and a link survives a reload.
 */
function FilesPage({ subPath }: PluginNavPanelProps) {
  const navigate = useBbNavigate();
  const context = useBbContext();
  const rpc = useRpc<typeof rpcContract>();
  const route = useMemo(() => parseRoute(subPath), [subPath]);
  const [fallback, setFallback] = useState<ScopeRef | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceOption[] | null>(null);

  useEffect(() => {
    void rpc
      .call("workspaces")
      .then((result) => setWorkspaces(result.workspaces))
      .catch(() => setWorkspaces([]));
  }, [rpc]);

  // With no workspace in the route, fall back to the thread in view, then to
  // whatever was open last, then to the server's first workspace — a visit
  // straight from the sidebar should land on files, not on an empty pane.
  useEffect(() => {
    if (route.scope !== null) return;
    let cancelled = false;

    const guess = async (): Promise<ScopeRef | null> => {
      if (context.threadId !== null) return { kind: "thread", id: context.threadId };
      if (context.projectId !== null) return { kind: "project", id: context.projectId };
      const remembered = readLastScope();
      if (remembered !== null) return remembered;
      return (await rpc.call("workspaces")).defaultRef;
    };

    void guess()
      .then((next) => {
        if (cancelled || next === null) return;
        navigate.toPluginPanel(PANEL_PATH, {
          subPath: formatRoute(next, null),
          replace: true,
        });
        setFallback(next);
      })
      .catch(() => {
        if (!cancelled) setFallback(null);
      });

    return () => {
      cancelled = true;
    };
  }, [context.projectId, context.threadId, navigate, route.scope, rpc]);

  const scope = route.scope ?? fallback;

  useEffect(() => {
    if (scope !== null) storeLastScope(scope);
  }, [scope]);

  const onOpenPath = useCallback(
    (path: string | null) => {
      if (scope === null) return;
      // Compare structurally, not against `subPath`: BB hands the subPath back
      // percent-encoded while formatRoute writes raw segments, so a string
      // compare misses for any path with a space or a non-ASCII name and pushes
      // a duplicate history entry every time that tab is clicked.
      if (sameScope(route.scope, scope) && route.filePath === path) return;
      // Opening a file is navigation the user should be able to undo, so it
      // pushes; clearing the last tab only rewinds to the workspace root and
      // would otherwise leave a dead entry between two files.
      navigate.toPluginPanel(PANEL_PATH, {
        subPath: formatRoute(scope, path),
        ...(path === null ? { replace: true } : {}),
      });
    },
    [navigate, route.filePath, route.scope, scope],
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <WorkspacePicker
        workspaces={workspaces}
        scope={scope}
        scopeLabel={scope === null ? null : labelForScopeKind(scope.kind)}
        onChange={(next) =>
          navigate.toPluginPanel(PANEL_PATH, { subPath: formatRoute(next, null) })
        }
      />
      {scope === null ? (
        <div className="flex flex-1 items-center justify-center text-xs text-muted-foreground">
          Choose a workspace to browse.
        </div>
      ) : (
        <div className="min-h-0 flex-1">
          <Workspace
            scope={scope}
            filePath={route.filePath}
            onOpenPath={onOpenPath}
          />
        </div>
      )}
    </div>
  );
}

/**
 * The same Finder beside a thread, pinned to that thread's workspace — the
 * files the agent in this conversation is actually editing.
 */
function ThreadFilesPanel({ threadId }: PluginThreadPanelProps) {
  const [filePath, setFilePath] = useState<string | null>(null);
  const scope = useMemo<ScopeRef>(() => ({ kind: "thread", id: threadId }), [threadId]);

  return (
    // Marks this thread's panel instance in the DOM. The header button uses it
    // to tell "my panel is open and active" from "closed, or showing another
    // tab", which no SDK API exposes.
    <div data-finder-mounted={threadId} className="h-full min-h-0">
      <Workspace scope={scope} filePath={filePath} onOpenPath={setFilePath} />
    </div>
  );
}

/** What the picker calls a scope it has no list entry for. */
function labelForScopeKind(kind: ScopeKind): string {
  if (kind === "thread") return "Thread workspace";
  if (kind === "environment") return "Environment workspace";
  return "Project checkout";
}

function readLastScope(): ScopeRef | null {
  try {
    const raw = window.localStorage.getItem(LAST_SCOPE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { kind, id } = parsed as { kind?: unknown; id?: unknown };
    if (typeof id !== "string" || id === "") return null;
    if (kind !== "thread" && kind !== "environment" && kind !== "project") return null;
    return { kind, id };
  } catch {
    return null;
  }
}

function storeLastScope(scope: ScopeRef): void {
  try {
    window.localStorage.setItem(LAST_SCOPE_KEY, JSON.stringify(scope));
  } catch {
    // A blocked storage API must not break navigation.
  }
}

/**
 * The workspace control in the thread header's action row: a folder button that
 * opens this thread's workspace files in the side panel and closes them again
 * on a second click.
 *
 * The toggle needs two facts the SDK does not expose: whether this plugin's
 * tab exists and is in front, and a way to close it. Both come from the host's
 * own DOM, scoped to this thread's pane:
 *
 * - exists = the panel component writes `[data-finder-mounted]`. The host
 *   keeps a panel tab mounted after the panel is closed and only unmounts its
 *   contents, so this answers "is the tab in the strip", not "is it showing".
 * - in front = the host's tab pill for the panel carries the active background
 *   class. A closed panel leaves its tab in the strip with the class removed,
 *   which is exactly the case that must open rather than close.
 * - close = the host's close button inside that same tab pill (`aria-label`
 *   `Close <tab title>`), so the close follows the host's own rules — the last
 *   tab closes the panel, a pinned tab has no close button, and history and
 *   focus restoration stay the host's business.
 *
 * Neither a hidden panel (the host's Ctrl+J) nor a panel behind another tab
 * needs its own case: both fall through to open, and opening focuses the tab
 * that is already there.
 *
 * The header action only mounts on the main thread view, which always has a
 * side panel, so a failed open is a refusal rather than a missing surface.
 */
function ThreadWorkspaceButton({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();

  const toggleWorkspaceFiles = useCallback(() => {
    // The host's own Ctrl+J hides the whole panel and leaves the tab in front,
    // so a click must bring it back rather than throw the tab away.
    if (isPanelShown() && isWorkspaceTabOpen(threadId) && isWorkspaceTabInFront()) {
      // In front means "clicked again": close the panel. Hiding it whole is what
      // the click means, and it is also what survives a panel holding other
      // tabs — closing just this tab would leave the panel standing.
      const hideButton = findRightPanelHideButton();
      if (hideButton !== null) {
        hideButton.click();
        return;
      }
      // No panel chrome to hide with (an unusual layout): closing this tab is
      // still the host's own action, and closes the panel when it is the last.
      const closeButton = findWorkspaceTabCloseButton();
      if (closeButton !== null) {
        closeButton.click();
        return;
      }
    }
    // Every other state — no tab, a hidden or closed panel, or another tab in
    // front — opens. The host focuses an existing tab rather than duplicating.
    const opened = navigate.openThreadPanel({
      actionId: "thread-finder",
      title: PANEL_TAB_TITLE,
    });
    if (!opened) toast.error("Could not open the Finder panel");
  }, [navigate, threadId]);

  return (
    <button
      type="button"
      title="Finder"
      aria-label="Finder"
      onClick={toggleWorkspaceFiles}
      className={cn(
        "inline-flex size-7 cursor-pointer items-center justify-center rounded-md",
        "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      <Icon name="FolderOpen" aria-hidden className="size-4" />
    </button>
  );
}

/**
 * Whether this thread's workspace tab exists in the host's tab strip, front or
 * not.
 *
 * The host keeps a panel tab mounted after the panel is closed — only the
 * contents are dropped, and the whole thread pane unmounts when it is not on
 * screen at all — so the marker is a reliable "the tab is in the strip" signal.
 */
function isWorkspaceTabOpen(threadId: string): boolean {
  return document.querySelector(`[data-finder-mounted="${CSS.escape(threadId)}"]`) !== null;
}

/**
 * Whether the host's right panel is on screen at all.
 *
 * The host hides the panel without unmounting it, sliding it out of the
 * viewport, and leaves no attribute behind: the toggle button's `aria-expanded`
 * is absent while the panel is shown and `"false"` while it is hidden. Geometry
 * is the only signal that separates the two.
 */
function isPanelShown(): boolean {
  const marker = document.querySelector<HTMLElement>("[data-finder-mounted]");
  if (marker === null) return true;
  const rect = marker.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const left = Math.max(rect.left, 0);
  const right = Math.min(rect.right, window.innerWidth);
  // A sliver of a collapsed drawer is not shown; require a usable width.
  return right - left > 120;
}

/**
 * The host's own control for hiding the right panel.
 *
 * Using it rather than the tab's close button means the click closes the panel
 * as a whole, whatever else is open in it, and that reopening later restores
 * every tab instead of just this plugin's.
 */
function findRightPanelHideButton(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button[aria-label]")).find((button) =>
      (button.getAttribute("aria-label") ?? "").startsWith("Hide right panel"),
    ) ?? null
  );
}

/** Whether this thread's tab pill is the one in front of the panel. */
function isWorkspaceTabInFront(): boolean {
  const pill = findWorkspaceTabPill();
  return pill !== null && /bg-state-active|text-foreground/.test(pill.className);
}

function findWorkspaceTabPill(): HTMLElement | null {
  const labels = Array.from(document.querySelectorAll("button")).filter(
    (button) => button.textContent.trim() === PANEL_TAB_TITLE,
  );
  for (const label of labels) {
    const pill = label.parentElement;
    if (pill !== null && pill.className.includes("tab-pill")) return pill;
  }
  return null;
}

function findWorkspaceTabCloseButton(): HTMLButtonElement | null {
  const pill = findWorkspaceTabPill();
  if (pill === null) return null;
  return pill.querySelector<HTMLButtonElement>(
    `button[aria-label="Close ${PANEL_TAB_TITLE}"]`,
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "files",
    title: "Finder",
    icon: "FolderOpen",
    path: PANEL_PATH,
    component: FilesPage,
  });

  app.slots.experimental_threadHeaderAction({
    id: "thread-workspace-files",
    title: "Finder",
    component: ThreadWorkspaceButton,
  });

  app.slots.fileOpener({
    id: "finder-editor",
    title: "Finder editor",
    extensions: openableExtensions(),
    component: FileOpenerTab,
  });

  app.slots.threadPanelAction({
    id: "thread-finder",
    title: "Finder",
    icon: "FolderOpen",
    layout: "flush",
    component: ThreadFilesPanel,
    run: ({ openPanel }) => {
      openPanel({ title: PANEL_TAB_TITLE });
    },
  });
});
