import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import { scopeKey, type ScopeRef } from "@/lib/route";
import { CHANGED_CHANNEL } from "@/lib/channels";
import type { ChangeKind } from "@/lib/git-status";

export interface GitChangesApi {
  status: "idle" | "loading" | "ready" | "no-git" | "error";
  /** Relative path -> change kind, for the tree badges. */
  files: ReadonlyMap<string, ChangeKind>;
  /** Relative path -> tracked/untracked, so untracked files badge as `?`. */
  origins: ReadonlyMap<string, "tracked" | "untracked">;
  /** Paths git reports as binary, so a diff picker can skip them. */
  binaries: ReadonlySet<string>;
  /** Relative path -> unified patch text, for the diff viewer. */
  patches: ReadonlyMap<string, string>;
  /** The one-line summary the host computed (e.g. `3 files changed, +42 -7`). */
  shortstat: string;
  error: string | null;
  reload(): void;
}

interface GitChangesState {
  status: GitChangesApi["status"];
  files: ReadonlyMap<string, ChangeKind>;
  origins: ReadonlyMap<string, "tracked" | "untracked">;
  binaries: ReadonlySet<string>;
  patches: ReadonlyMap<string, string>;
  shortstat: string;
  error: string | null;
}

const EMPTY_FILES: ReadonlyMap<string, ChangeKind> = new Map<string, ChangeKind>();
const EMPTY_ORIGINS: ReadonlyMap<string, "tracked" | "untracked"> = new Map<string, "tracked" | "untracked">();
const EMPTY_BINARIES: ReadonlySet<string> = new Set<string>();
const EMPTY_PATCHES: ReadonlyMap<string, string> = new Map<string, string>();

const IDLE: GitChangesState = {
  status: "idle",
  files: EMPTY_FILES,
  origins: EMPTY_ORIGINS,
  binaries: EMPTY_BINARIES,
  patches: EMPTY_PATCHES,
  shortstat: "",
  error: null,
};

/**
 * The workspace's uncommitted git changes, kept current by the plugin's own
 * realtime signal so a write from this client, another tab, or the CLI
 * refreshes the tree badges and the diff viewer.
 */
export function useGitChanges(scope: ScopeRef | null): GitChangesApi {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<GitChangesState>(IDLE);
  const requestRef = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKeyRef = useRef(scopeKey(scope));
  scopeKeyRef.current = scopeKey(scope);

  const load = useCallback(
    (target: ScopeRef | null) => {
      // A project checkout has no environment to diff against; the hook submits
      // nothing and the caller shows the plain tree.
      if (target === null) {
        requestRef.current += 1;
        setState(IDLE);
        return;
      }
      const generation = (requestRef.current += 1);
      setState((current) => ({ ...current, status: "loading", error: null }));

      void rpc
        .call("gitChanges", { scope: target })
        .then((result) => {
          // A scope switch starts a newer request; its response is the one
          // that defines the state, so an older in-flight one is dropped.
          if (requestRef.current !== generation) return;

          if (result.kind === "available") {
            const files = new Map<string, ChangeKind>();
            const origins = new Map<string, "tracked" | "untracked">();
            const binaries = new Set<string>();
            for (const file of result.files) {
              files.set(file.path, file.changeKind);
              origins.set(file.path, file.origin);
              if (file.binary) binaries.add(file.path);
            }
            const patches = new Map<string, string>();
            for (const entry of result.patches) {
              patches.set(entry.path, entry.patch);
            }
            setState({
              status: "ready",
              files,
              origins,
              binaries,
              patches,
              shortstat: result.shortstat,
              error: null,
            });
          } else if (result.kind === "not_git") {
            setState({
              status: "no-git",
              files: EMPTY_FILES,
              origins: EMPTY_ORIGINS,
              binaries: EMPTY_BINARIES,
              patches: EMPTY_PATCHES,
              shortstat: "",
              error: null,
            });
          } else {
            setState({
              status: "error",
              files: EMPTY_FILES,
              origins: EMPTY_ORIGINS,
              binaries: EMPTY_BINARIES,
              patches: EMPTY_PATCHES,
              shortstat: "",
              error: result.message,
            });
          }
        })
        .catch((cause: unknown) => {
          if (requestRef.current !== generation) return;
          setState({
            status: "error",
            files: EMPTY_FILES,
            origins: EMPTY_ORIGINS,
            binaries: EMPTY_BINARIES,
            patches: EMPTY_PATCHES,
            shortstat: "",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [rpc],
  );

  // Load once per workspace identity. The route hands back a fresh scope object
  // for the same workspace on every navigation, so the fetch is keyed on the
  // stable key rather than the object identity.
  const currentKey = scopeKey(scope);
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    if (loadedKey.current === currentKey) return;
    loadedKey.current = currentKey;
    load(scopeRef.current);
  }, [currentKey, load]);

  const reload = useCallback(() => {
    load(scopeRef.current);
  }, [load]);

  useRealtime(CHANGED_CHANNEL, (payload) => {
    // A change in another workspace must not re-diff this one: every open
    // Finder subscribes to the same channel, so an unfiltered refresh would
    // fetch every tree's git status on any write anywhere.
    const changed = payload as { scope?: { kind?: unknown; id?: unknown } } | null;
    const ref = changed?.scope;
    if (ref === undefined || typeof ref.kind !== "string" || typeof ref.id !== "string") return;
    if (scopeKeyRef.current !== `${ref.kind}:${ref.id}`) return;
    reload();
  });

  return {
    status: state.status,
    files: state.files,
    origins: state.origins,
    binaries: state.binaries,
    patches: state.patches,
    shortstat: state.shortstat,
    error: state.error,
    reload,
  };
}

export interface GitFileDiffState {
  status: "idle" | "loading" | "ready" | "error";
  patch: string | null;
  message: string | null;
}

/**
 * One file's patch, when `gitChanges` did not preload it.
 *
 * `diffFiles` only ships patches while the change set is small — a repository
 * with hundreds of changed files arrives with an empty `patches` array — so the
 * viewer asks for the single file it is showing instead of re-fetching them all.
 * A patch already in hand is used without a round trip.
 */
export function useGitFileDiff(
  scope: ScopeRef | null,
  path: string | null,
  known: string | null,
): GitFileDiffState {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<GitFileDiffState>({
    status: "idle",
    patch: null,
    message: null,
  });
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  // Identity of the request: a different file or workspace is a different
  // patch, and the effect must not re-run for a new scope object naming the
  // same workspace.
  const key = path === null ? "" : `${scopeKey(scope)}\u0000${path}`;

  useEffect(() => {
    const target = scopeRef.current;
    if (path === null || target === null) {
      setState({ status: "idle", patch: null, message: null });
      return;
    }
    if (known !== null) {
      setState({ status: "ready", patch: known, message: null });
      return;
    }
    let cancelled = false;
    setState({ status: "loading", patch: null, message: null });
    void rpc
      .call("gitFileDiff", { scope: target, path })
      .then((result) => {
        if (cancelled) return;
        if (result.kind === "available") {
          setState({ status: "ready", patch: result.patch, message: null });
          return;
        }
        setState({
          status: "error",
          patch: null,
          message:
            result.kind === "not_git"
              ? "This workspace is not a git repository."
              : result.message,
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          patch: null,
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
    // `key` carries the workspace and the path; `known` is the patch the
    // listing already handed over, so a later refresh can fill the view in
    // without another request.
  }, [key, known, path, rpc]);

  return state;
}