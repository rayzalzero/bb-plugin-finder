import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import { sameScope, scopeKey, type ScopeRef } from "@/lib/route";
import {
  clearDraft,
  patchWorkspaceState,
  readDraft,
  readWorkspaceState,
  writeDraft,
} from "@/lib/workspace-state";
import { allowedMode, isMarkdownPath, type FileViewMode } from "@/lib/file-kind";
import type { ReadResult } from "../server.js";
import type { SaveState } from "./FilePane";

export interface FileTab {
  path: string;
  file: ReadResult | null;
  error: string | null;
  /** Edited text; null while the tab still matches what was read. */
  draft: string | null;
  /** The hash the draft is based on — the compare-and-swap guard on save. */
  sha256: string | null;
  mode: FileViewMode;
  save: SaveState;
}

/** What the tab would render: the draft over the file, or null with no text. */
export function renderedText(tab: FileTab): string | null {
  if (tab.draft !== null) return tab.draft;
  return tab.file !== null && tab.file.kind === "text" ? tab.file.content : null;
}

export function isDirty(tab: FileTab): boolean {
  if (tab.draft === null) return false;
  if (tab.file === null || tab.file.kind !== "text") return false;
  return tab.draft !== tab.file.content;
}

export interface FileTabsApi {
  tabs: FileTab[];
  activePath: string | null;
  activeTab: FileTab | null;
  open(path: string): void;
  /** Returns the tab left in front after the close. */
  close(path: string): string | null;
  setDraft(path: string, draft: string): void;
  setMode(path: string, mode: FileViewMode): void;
  /** `force` drops the compare-and-swap guard, for answering a conflict. */
  save(path: string, options?: { force: boolean }): void;
  reload(path?: string): void;
}

const MAX_TABS = 12;

/**
 * A tab whose path is known but whose contents have not been read yet.
 *
 * Markdown opens as a rendered preview: a README is written to be read, and the
 * whole point of opening one is usually to read it.
 *
 * The mode is stored as the raw request, not resolved here: preview needs the
 * text, and there is none yet. `FileView` resolves it against the loaded text
 * on every render, so the pane shows the source until the read lands and falls
 * back to the source for good if the file is too large to render.
 */
function unloadedTab(path: string): FileTab {
  return {
    path,
    file: null,
    error: null,
    draft: null,
    sha256: null,
    mode: isMarkdownPath(path) ? "preview" : "edit",
    save: { kind: "clean" },
  };
}

/**
 * The open files, their contents, their drafts, and their save state. One
 * instance per workspace: switching scope resets it, because a path only means
 * something relative to the root it came from.
 */
export function useFileTabs(scope: ScopeRef | null): FileTabsApi {
  const rpc = useRpc<typeof rpcContract>();
  // Restored from the remembered workspace state, so reopening the panel shows
  // the same files in front. Contents are re-read below; only the paths are
  // remembered, because a file may well have changed while the panel was shut.
  const [tabs, setTabs] = useState<FileTab[]>(() =>
    readWorkspaceState(scopeKey(scope)).openPaths.slice(-MAX_TABS).map(unloadedTab),
  );
  const [activePath, setActivePath] = useState<string | null>(
    () => readWorkspaceState(scopeKey(scope)).activePath,
  );

  // Every callback below reads through these rather than through the value it
  // closed over: a toast action can be clicked several renders after it was
  // created, and acting on that render's tab array would revert everything
  // that happened since.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;
  // The route hands back a fresh object for the same workspace on every
  // navigation, so a read is validated against the workspace KEY rather than
  // against the object identity it started with — otherwise opening a file
  // discards the read that the same navigation started.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKeyRef = useRef(scopeKey(scope));
  scopeKeyRef.current = scopeKey(scope);

  // Reads resolve out of order; only the newest one for a path may land. The
  // counter is monotonic for the life of the hook, so a read issued before a
  // close can never collide with one issued after a reopen.
  const readSequence = useRef(0);
  const inFlightRead = useRef(new Map<string, number>());
  const writeSequence = useRef(0);
  const inFlightWrite = useRef(new Map<string, number>());

  const patch = useCallback((path: string, next: Partial<FileTab>) => {
    setTabs((current) =>
      current.map((tab) => (tab.path === path ? { ...tab, ...next } : tab)),
    );
  }, []);

  // The draft store keeps unsaved text alive across a panel close, which
  // unmounts this whole hook. Only paths are kept in the workspace state; the
  // text lives in its own entry so a large draft never rewrites the index.
  const rememberDraft = useCallback((path: string, draft: string | null) => {
    const key = scopeKeyRef.current;
    if (key === "") return;
    if (draft === null) clearDraft(key, path);
    else writeDraft(key, path, draft);
  }, []);

  const load = useCallback(
    (path: string) => {
      const target = scopeRef.current;
      if (target === null) return;
      const sequence = (readSequence.current += 1);
      inFlightRead.current.set(path, sequence);
      patch(path, { error: null });

      const targetKey = scopeKey(target);
      void rpc
        .call("read", { scope: target, path })
        .then((file) => {
          if (inFlightRead.current.get(path) !== sequence) return;
          if (scopeKeyRef.current !== targetKey) return;
          const stored = readDraft(targetKey, path);
          // A stored draft is the user's unsaved text coming back; it survives
          // a panel close and a reload, and is dropped on save, close, or when
          // it matches the file again.
          const draft =
            stored !== null && file.kind === "text" && stored !== file.content ? stored : null;
          if (stored !== null && draft === null) clearDraft(targetKey, path);
          // The read's hash is what the next write is based on. Dropping it
          // would make every first save an unconditional overwrite of whatever
          // an agent wrote in the meantime — the guard exists to stop that.
          patch(path, {
            file,
            draft,
            sha256: file.kind === "text" ? file.sha256 : null,
            error: null,
          });
        })
        .catch((cause: unknown) => {
          if (inFlightRead.current.get(path) !== sequence) return;
          patch(path, {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [patch, rpc],
  );

  const open = useCallback(
    (path: string) => {
      // Opening an already-open tab only brings it to the front. Re-reading it
      // would also throw away an in-progress draft, and a caller that opens on
      // every render (a route effect) would spin.
      const existing = tabsRef.current.find((tab) => tab.path === path);
      if (existing !== undefined) {
        setActivePath(path);
        return;
      }
      const current = tabsRef.current;
      // The oldest tab is evicted when the cap is reached, and its unsaved draft
      // has to go with it: leaving the entry behind would keep megabytes in
      // localStorage that nothing can ever reach again.
      if (current.length >= MAX_TABS) {
        const evicted = current[0];
        if (evicted !== undefined) rememberDraft(evicted.path, null);
      }
      setTabs((live) => {
        if (live.some((tab) => tab.path === path)) return live;
        const next = unloadedTab(path);
        return live.length >= MAX_TABS ? [...live.slice(1), next] : [...live, next];
      });
      setActivePath(path);
      load(path);
    },
    [load, rememberDraft],
  );

  const close = useCallback((path: string) => {
    const current = tabsRef.current;
    const index = current.findIndex((tab) => tab.path === path);
    if (index === -1) return activePathRef.current;
    rememberDraft(path, null);
    const remaining = current.filter((tab) => tab.path !== path);
    setTabs(remaining);

    if (activePathRef.current !== path) return activePathRef.current;
    const next = remaining[Math.min(index, remaining.length - 1)]?.path ?? null;
    setActivePath(next);
    return next;
  }, []);

  const save = useCallback(
    (path: string, options?: { force: boolean }) => {
      const tab = tabsRef.current.find((entry) => entry.path === path);
      if (tab === undefined || tab.file === null || tab.file.kind !== "text") return;
      if (tab.draft === null) return;
      const target = scopeRef.current;
      if (target === null) return;

      const content = tab.draft;
      // `force` is the user answering a conflict with "keep my text": the hash
      // the draft was based on is exactly what is stale, so sending it again
      // would conflict on every retry.
      const guard = options?.force === true ? null : tab.sha256;
      const sequence = (writeSequence.current += 1);
      inFlightWrite.current.set(path, sequence);
      patch(path, { save: { kind: "saving" } });

      void rpc
        .call("write", {
          scope: target,
          path,
          content,
          ...(guard === null ? {} : { expectedSha256: guard }),
        })
        .then((result) => {
          if (inFlightWrite.current.get(path) !== sequence) return;
          if (result.outcome === "conflict") {
            patch(path, { save: { kind: "conflict" } });
            return;
          }
          // The written text becomes the file. A draft typed past it is not the
          // draft that was written, so it stays — dropping it here would throw
          // away keystrokes that landed while the write was in flight.
          // Compare against the text that was written: a draft equal to it is
          // this write landing, while a different draft is keystrokes that
          // arrived while the write was in flight and must be kept.
          const live = tabsRef.current.find((entry) => entry.path === path)?.draft ?? null;
          const stillDirty = live !== null && live !== content;
          if (!stillDirty) rememberDraft(path, null);
          patch(path, {
            ...(stillDirty ? {} : { draft: null }),
            file: {
              kind: "text",
              content,
              sha256: result.sha256,
              sizeBytes: result.sizeBytes,
              absolutePath: tab.file?.absolutePath ?? "",
              editable: true,
            },
            sha256: result.sha256,
            save: { kind: "clean" },
          });
        })
        .catch((cause: unknown) => {
          if (inFlightWrite.current.get(path) !== sequence) return;
          patch(path, {
            save: {
              kind: "error",
              message: cause instanceof Error ? cause.message : String(cause),
            },
          });
        });
    },
    [patch, rpc],
  );

  const setDraft = useCallback(
    (path: string, draft: string) => {
      const tab = tabsRef.current.find((entry) => entry.path === path);
      if (tab === undefined) return;
      const base = tab.file !== null && tab.file.kind === "text" ? tab.file.content : "";
      patch(path, { draft: draft === base ? null : draft });
      rememberDraft(path, draft === base ? null : draft);
    },
    [patch, rememberDraft],
  );

  const setMode = useCallback(
    (path: string, mode: FileViewMode) => {
      const tab = tabsRef.current.find((entry) => entry.path === path);
      if (tab === undefined) return;
      patch(path, { mode: allowedMode(mode, path, renderedText(tab)) });
    },
    [patch],
  );

  const reload = useCallback(
    (path?: string) => {
      const target = path ?? activePathRef.current;
      if (target === null) return;
      rememberDraft(target, null);
      patch(target, { draft: null, sha256: null, save: { kind: "clean" } });
      load(target);
    },
    [load, patch],
  );

  // Remember the open files and the one in front, so the next visit restores
  // them. Only paths are stored, and only when the set of paths or the front
  // tab actually changes: `tabs` is a new array on every keystroke (the draft
  // lives on the tab), and rewriting the workspace index — expanded folders
  // included — once per keystroke would serialize the whole index for nothing.
  // The identity is JSON, so a path containing any separator still counts as
  // one entry rather than splitting into several.
  const openPathsKey = JSON.stringify(tabs.map((tab) => tab.path));
  const openPathsRef = useRef<string[]>([]);
  openPathsRef.current = tabs.map((tab) => tab.path);
  useEffect(() => {
    patchWorkspaceState(scopeKeyRef.current, {
      openPaths: openPathsRef.current,
      activePath,
    });
  }, [activePath, openPathsKey]);

  /**
   * Install the remembered tabs of a workspace and read their contents.
   *
   * Paths survive a panel close; the bytes deliberately do not, because a file
   * may well have changed while the panel was shut. A scope change invalidates
   * every open tab — the same relative path names a different file in a
   * different root — so this is also what replaces the old tab list wholesale.
   */
  const restore = useCallback(
    (target: ScopeRef | null) => {
      readSequence.current += 1;
      writeSequence.current += 1;
      inFlightRead.current.clear();
      inFlightWrite.current.clear();
      const remembered = readWorkspaceState(scopeKey(target));
      const seeded = remembered.openPaths.slice(-MAX_TABS).map(unloadedTab);
      setTabs((current) => {
        const alreadyShown =
          current.length === seeded.length &&
          current.every((tab, index) => tab.path === seeded[index]?.path);
        // Re-seeding equal paths would drop contents that are already loaded.
        return alreadyShown ? current : seeded;
      });
      // A route-named file is already open by the time this runs (its effect
      // sits above), so the remembered path is adopted only when it survived.
      setActivePath((current) => {
        if (current !== null && seeded.some((tab) => tab.path === current)) return current;
        return remembered.activePath !== null && seeded.some((tab) => tab.path === remembered.activePath)
          ? remembered.activePath
          : current;
      });
      // The read above rehydrates a stored draft; a tab whose contents are
      // still current must not lose its draft just because the panel remounted.
      setTabs((current) =>
        current.map((tab) =>
          tab.file !== null && tab.draft === null
            ? { ...tab, draft: readDraft(scopeKey(target), tab.path) }
            : tab,
        ),
      );
      for (const tab of seeded) load(tab.path);
    },
    [load],
  );

  // Compared structurally, because the route hands back a fresh object for the
  // same workspace on every navigation. `undefined` marks "never ran", so the
  // first run installs the remembered tabs for the workspace the panel opened
  // on rather than clearing them.
  const previousScope = useRef<ScopeRef | null | undefined>(undefined);
  useEffect(() => {
    if (previousScope.current !== undefined && sameScope(previousScope.current, scope)) return;
    previousScope.current = scope;
    restore(scope);
  }, [restore, scope]);

  const activeTab = tabs.find((tab) => tab.path === activePath) ?? null;
  // Memoized so a consumer can depend on the whole API without re-running its
  // effects on every render; `open` in an effect dependency list would
  // otherwise re-open the same tab forever.
  return useMemo(
    () => ({
      tabs,
      activePath,
      activeTab,
      open,
      close,
      setDraft,
      setMode,
      save,
      reload,
    }),
    [activePath, activeTab, close, open, reload, save, setDraft, setMode, tabs],
  );
}
