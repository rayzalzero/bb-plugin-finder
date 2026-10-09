/**
 * Per-workspace Finder state, remembered across panel closes, route changes,
 * and reloads.
 *
 * The host unmounts a plugin panel tab whenever it is not the active tab or the
 * panel is closed, so every piece of React state inside it is gone by the time
 * the user comes back. What makes reopening pleasant is the workspace looking
 * the way it was left: the same folders open, the same file in front, the same
 * directory targeted for new files.
 *
 * State is keyed by the workspace identity (`<kind>:<id>`), never by the file
 * path, so a project checkout and a thread worktree keep separate histories.
 */

export interface StoredWorkspaceState {
  /** Directories expanded in the tree. */
  expanded: string[];
  /** Directory new files, folders, and uploads land in; "" is the root. */
  selectedDirectory: string;
  /** Files open in the editor, in tab order. */
  openPaths: string[];
  /** The file in front, or null when no tab is open. */
  activePath: string | null;
}

const EMPTY: StoredWorkspaceState = {
  expanded: [],
  selectedDirectory: "",
  openPaths: [],
  activePath: null,
};

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/** The remembered state for a workspace, or empty defaults. */
export function readWorkspaceState(workspaceKey: string): StoredWorkspaceState {
  if (workspaceKey === "") return EMPTY;
  try {
    const raw = window.localStorage.getItem(`finder:workspace:${workspaceKey}`);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const { expanded, selectedDirectory, openPaths, activePath } = parsed as Record<string, unknown>;
    return {
      expanded: isStringArray(expanded) ? expanded : [],
      selectedDirectory: typeof selectedDirectory === "string" ? selectedDirectory : "",
      openPaths: isStringArray(openPaths) ? openPaths : [],
      activePath: typeof activePath === "string" ? activePath : null,
    };
  } catch {
    return EMPTY;
  }
}

/**
 * Merge one slice of state. The tree and the tab store write independently —
 * expanding a folder must not erase the open tabs, and vice versa.
 */
export function patchWorkspaceState(
  workspaceKey: string,
  patch: Partial<StoredWorkspaceState>,
): void {
  if (workspaceKey === "") return;
  try {
    const next = { ...readWorkspaceState(workspaceKey), ...patch };
    window.localStorage.setItem(`finder:workspace:${workspaceKey}`, JSON.stringify(next));
  } catch {
    // A blocked or full storage API must not break Finder.
  }
}

/**
 * Unsaved editor text, kept in its own entry per file.
 *
 * The workspace index holds paths only: a draft can be megabytes, and rewriting
 * the index on every keystroke would serialize the whole open-tab list too. The
 * host unmounts the panel whenever it stops being the front tab, so without
 * this the text a user typed and did not save would simply vanish.
 */
export function readDraft(workspaceKey: string, path: string): string | null {
  if (workspaceKey === "") return null;
  try {
    return window.localStorage.getItem(`finder:draft:${workspaceKey}:${path}`);
  } catch {
    return null;
  }
}

export function writeDraft(workspaceKey: string, path: string, draft: string): void {
  if (workspaceKey === "") return;
  try {
    window.localStorage.setItem(`finder:draft:${workspaceKey}:${path}`, draft);
  } catch {
    // A draft that cannot be stored must never break editing.
  }
}

export function clearDraft(workspaceKey: string, path: string): void {
  if (workspaceKey === "") return;
  try {
    window.localStorage.removeItem(`finder:draft:${workspaceKey}:${path}`);
  } catch {
    // Nothing to do: the entry is gone either way.
  }
}
