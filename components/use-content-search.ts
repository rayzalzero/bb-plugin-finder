import { useCallback, useEffect, useRef, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../server.js";
import { scopeKey, type ScopeRef } from "@/lib/route";

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchState {
  status: "idle" | "searching" | "ready" | "error";
  hits: SearchHit[];
  truncated: boolean;
  filesScanned: number;
  /** The regexp did not compile; nothing was searched. */
  invalidPattern: string | null;
  error: string | null;
}

const IDLE: SearchState = {
  status: "idle",
  hits: [],
  truncated: false,
  filesScanned: 0,
  invalidPattern: null,
  error: null,
};

export interface SearchApi {
  state: SearchState;
  run(query: string, options: { caseSensitive: boolean; regexp: boolean; wholeWord: boolean }, directory: string): void;
  clear(): void;
}

/**
 * Content search over a workspace.
 *
 * Every run supersedes the one before it: results are keyed by a monotonic
 * generation so a slow scan of a big directory cannot overwrite the results of
 * the query typed after it. Clearing the query clears the pane rather than
 * leaving stale hits from a search nobody asked for any more.
 */
export function useContentSearch(scope: ScopeRef | null, includeHidden: boolean): SearchApi {
  const rpc = useRpc<typeof rpcContract>();
  const [state, setState] = useState<SearchState>(IDLE);
  const generation = useRef(0);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  const clear = useCallback(() => {
    generation.current += 1;
    setState(IDLE);
  }, []);

  // A workspace change invalidates every hit: the same relative path names a
  // different file in a different root.
  const previousScope = useRef<string | null>(null);
  useEffect(() => {
    const key = scopeKey(scope);
    if (previousScope.current === key) return;
    previousScope.current = key;
    clear();
  }, [clear, scope]);

  const run = useCallback(
    (
      query: string,
      options: { caseSensitive: boolean; regexp: boolean; wholeWord: boolean },
      directory: string,
    ) => {
      const target = scopeRef.current;
      if (target === null || query.trim() === "") {
        clear();
        return;
      }
      const current = (generation.current += 1);
      setState((previous) => ({ ...previous, status: "searching", error: null }));
      void rpc
        .call("search", {
          scope: target,
          query,
          includeHidden,
          caseSensitive: options.caseSensitive,
          regexp: options.regexp,
          wholeWord: options.wholeWord,
          directory,
        })
        .then((result) => {
          if (generation.current !== current) return;
          setState({
            status: "ready",
            hits: result.matches,
            truncated: result.truncated,
            filesScanned: result.filesScanned,
            invalidPattern: result.invalidPattern,
            error: null,
          });
        })
        .catch((cause: unknown) => {
          if (generation.current !== current) return;
          setState({
            status: "error",
            hits: [],
            truncated: false,
            filesScanned: 0,
            invalidPattern: null,
            error: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [clear, includeHidden, rpc],
  );

  return { state, run, clear };
}
