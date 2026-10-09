import { useCallback, useEffect, useRef, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract, ResolvedScope } from "../server.js";
import { scopeKey, type ScopeRef } from "@/lib/route";
import type { FlatEntry } from "@/lib/tree";
import { CHANGED_CHANNEL } from "@/lib/channels";

export interface TreeState {
  status: "idle" | "loading" | "ready" | "error";
  scope: ResolvedScope | null;
  entries: FlatEntry[];
  truncated: boolean;
  listing: "local" | "remote";
  error: string | null;
}

const EMPTY_TREE: TreeState = {
  status: "idle",
  scope: null,
  entries: [],
  truncated: false,
  listing: "local",
  error: null,
};

export interface TreeApi {
  state: TreeState;
  refresh(): void;
  /** Re-list after a mutation; coalesced so a burst is one request. */
  invalidate(): void;
}

/**
 * The workspace listing, kept current by the plugin's own realtime signal so a
 * write from this client, another tab, or the plugin's CLI refreshes every
 * open tree.
 */
export function useTree(scope: ScopeRef | null, includeHidden: boolean): TreeApi {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<TreeState>(EMPTY_TREE);
  const requestRef = useRef(0);
  const pendingRef = useRef<number | null>(null);

  // The route hands back a fresh scope object for the same workspace on every
  // navigation, so the listing is keyed on the workspace identity, not on the
  // object: otherwise opening a file would re-list the whole workspace.
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKeyRef = useRef(scopeKey(scope));
  scopeKeyRef.current = scopeKey(scope);

  const load = useCallback(
    (target: ScopeRef | null, hidden: boolean) => {
      if (target === null) {
        setState(EMPTY_TREE);
        return;
      }
      const generation = (requestRef.current += 1);
      setState((current) => ({ ...current, status: "loading", error: null }));

      void rpc
        .call("tree", { scope: target, includeHidden: hidden })
        .then((result) => {
          if (requestRef.current !== generation) return;
          setState({
            status: "ready",
            scope: result.scope,
            entries: result.entries,
            truncated: result.truncated,
            listing: result.listing,
            error: null,
          });
        })
        .catch((cause: unknown) => {
          if (requestRef.current !== generation) return;
          setState({
            status: "error",
            scope: null,
            entries: [],
            truncated: false,
            listing: "local",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [rpc],
  );

  const currentKey = scopeKey(scope);
  const loadedKey = useRef<string | null>(null);
  useEffect(() => {
    const key = `${currentKey}\u0000${includeHidden}`;
    if (loadedKey.current === key) return;
    loadedKey.current = key;
    load(scopeRef.current, includeHidden);
  }, [currentKey, includeHidden, load]);

  const invalidate = useCallback(() => {
    if (pendingRef.current !== null) return;
    // A mutation and the signal it publishes both ask for a refresh; one
    // request covers both without making the tree flicker through `loading`.
    pendingRef.current = window.setTimeout(() => {
      pendingRef.current = null;
      load(scopeRef.current, includeHidden);
    }, 150);
  }, [includeHidden, load]);

  // A pending coalesced refresh captured the dotfile setting from when it was
  // scheduled. If that setting changes before it fires, the stale request would
  // win the generation guard and revert the listing to the old setting while
  // the header still shows the new one, so the timer is dropped.
  useEffect(() => {
    return () => {
      if (pendingRef.current !== null) {
        window.clearTimeout(pendingRef.current);
        pendingRef.current = null;
      }
    };
  }, [includeHidden]);

  useEffect(
    () => () => {
      if (pendingRef.current !== null) window.clearTimeout(pendingRef.current);
    },
    [],
  );

  useRealtime(CHANGED_CHANNEL, (payload) => {
    // A change in another workspace must not re-walk this one: every open
    // Finder subscribes to the same channel, so an unfiltered refresh means a
    // write anywhere re-lists every tree on screen.
    const changed = payload as { scope?: { kind?: unknown; id?: unknown } } | null;
    const ref = changed?.scope;
    if (ref === undefined || typeof ref.kind !== "string" || typeof ref.id !== "string") return;
    if (scopeKeyRef.current !== `${ref.kind}:${ref.id}`) return;
    invalidate();
  });

  const refresh = useCallback(() => {
    load(scopeRef.current, includeHidden);
  }, [includeHidden, load]);

  return { state, refresh, invalidate };
}

/** Mutations Finder performs on the tree, each refreshing on success. */
export function useTreeMutations(scope: ScopeRef | null, onChanged: () => void) {
  const rpc = useRpc<typeof rpcContract>();

  const report = useCallback((cause: unknown) => {
    toast.error(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const create = useCallback(
    (directory: string, name: string, kind: "file" | "directory") => {
      if (scope === null) return;
      void rpc
        .call("create", { scope, directory, name, kind })
        .then((result) => {
          toast.success(`Created ${result.path}`);
          onChanged();
        })
        .catch(report);
    },
    [onChanged, report, rpc, scope],
  );

  const rename = useCallback(
    (path: string, name: string) => {
      if (scope === null) return;
      void rpc
        .call("rename", { scope, path, name })
        .then((result) => {
          toast.success(`Renamed to ${result.path}`);
          onChanged();
        })
        .catch(report);
    },
    [onChanged, report, rpc, scope],
  );

  const remove = useCallback(
    (path: string, recursive: boolean) => {
      if (scope === null) return;
      void rpc
        .call("remove", { scope, path, recursive })
        .then(() => {
          toast.success(`Removed ${path}`);
          onChanged();
        })
        .catch(report);
    },
    [onChanged, report, rpc, scope],
  );

  const upload = useCallback(
    (directory: string, files: Array<{ name: string; contentBase64: string }>) => {
      if (scope === null || files.length === 0) return;
      void rpc
        .call("upload", { scope, directory, files })
        .then((result) => {
          toast.success(
            result.written.length === 1
              ? `Uploaded ${result.written[0]}`
              : `Uploaded ${result.written.length} files`,
          );
          onChanged();
        })
        .catch(report);
    },
    [onChanged, report, rpc, scope],
  );

  return { create, rename, remove, upload };
}

/** Read a browser `File` as base64, which is how uploads cross the RPC boundary. */
export async function fileToBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
