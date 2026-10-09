import { useCallback, useEffect, useRef, useState } from "react";
import {
  useRpc,
  type PluginFileOpenerProps,
  type PluginFileOpenerSource,
} from "@get-bb/plugin-sdk/app";
import { FilePane, copyToClipboard, type SaveState } from "@/components/FilePane";
import { AUTOSAVE_DELAY_MS, AUTOSAVE_KEY, LINE_WRAP_KEY, readPrefFlag, writePref } from "@/lib/prefs";
import type { rpcContract, ReadResult } from "../server.js";
import { isMarkdownPath, type FileViewMode } from "@/lib/file-kind";
import type { ScopeRef } from "@/lib/route";

/**
 * A file BB opened through this plugin's `fileOpener`.
 *
 * BB hands a file reference — a chat link, the environment diff panel, any
 * surface that opens a file — to whichever opener is registered for the
 * extension, and this component is what the user gets. It renders the same
 * `FilePane` as the Finder panel, so the file looks and behaves identically
 * whichever surface opened it: markdown as a preview with the source one click
 * away, code in the editor, line references landing on their line.
 *
 * The source names where the file lives, and only a workspace maps onto a scope
 * the backend can resolve; thread-storage and host paths are BB's own business,
 * so those delegate to `Original` rather than failing in a pane of their own.
 */
export function FileOpenerTab({
  path,
  source,
  experimental_lineRange,
  Original,
}: PluginFileOpenerProps) {
  const scope = source.kind === "workspace" ? scopeOfSource(source) : null;

  if (scope === null) return <Original />;
  return (
    <WorkspaceFileTab
      // A new path is a new document: keying here drops the previous file's
      // read, draft, and undo history rather than carrying them across.
      key={path}
      path={path}
      scope={scope}
      lineRange={experimental_lineRange ?? null}
    />
  );
}

function scopeOfSource(source: PluginFileOpenerSource): ScopeRef | null {
  if (source.environmentId !== null) return { kind: "environment", id: source.environmentId };
  if (source.threadId !== null) return { kind: "thread", id: source.threadId };
  if (source.projectId !== null) return { kind: "project", id: source.projectId };
  return null;
}

interface WorkspaceFileTabProps {
  path: string;
  scope: ScopeRef;
  /** Lines BB asked to reveal, or null when the reference named no line. */
  lineRange: { startLineNumber: number; endLineNumber: number } | null;
}

function WorkspaceFileTab({ path, scope, lineRange }: WorkspaceFileTabProps) {
  const rpc = useRpc<typeof rpcContract>();
  const [file, setFile] = useState<ReadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [sha256, setSha256] = useState<string | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: "clean" });
  // Markdown opens as a preview, like the Finder panel does: a document
  // reference in chat is usually there to be read.
  const [mode, setMode] = useState<FileViewMode>("edit");
  const [autosave, setAutosave] = useState(() => readPrefFlag(AUTOSAVE_KEY, false));
  const [lineWrap, setLineWrap] = useState(() => readPrefFlag(LINE_WRAP_KEY, true));

  const read = useCallback(() => {
    void rpc
      .call("read", { scope, path })
      .then((next) => {
        setFile(next);
        setError(null);
        setDraft(null);
        // The read's hash is what the first write is based on; dropping it would
        // make every save an unconditional overwrite of whatever an agent wrote
        // in the meantime, which is exactly what the guard exists to prevent.
        setSha256(next.kind === "text" ? next.sha256 : null);
        setMode(next.kind === "text" && isMarkdownPath(path) ? "preview" : "edit");
        setSave({ kind: "clean" });
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
  }, [path, rpc, scope]);

  useEffect(read, [read]);

  const write = useCallback(
    (content: string, options?: { force: boolean }) => {
      setSave({ kind: "saving" });
      // Answering a conflict with "keep my text" means the hash the draft was
      // based on is the stale one; sending it again conflicts on every retry.
      const guard = options?.force === true ? null : sha256;
      void rpc
        .call("write", {
          scope,
          path,
          content,
          ...(guard === null ? {} : { expectedSha256: guard }),
        })
        .then((result) => {
          if (result.outcome === "conflict") {
            setSave({ kind: "conflict" });
            return;
          }
          setFile((current) =>
            current !== null && current.kind === "text"
              ? { ...current, content, sha256: result.sha256, sizeBytes: result.sizeBytes }
              : current,
          );
          setDraft((current) => (current === content ? null : current));
          setSha256(result.sha256);
          setSave({ kind: "clean" });
        })
        .catch((cause: unknown) => {
          setSave({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
          });
        });
    },
    [path, rpc, scope, sha256],
  );

  const text = draft ?? (file !== null && file.kind === "text" ? file.content : null);
  const editable = file !== null && file.kind === "text" && file.editable;
  const dirty = draft !== null && file !== null && file.kind === "text" && draft !== file.content;

  // Auto-save, off by default and shared with the Finder panel: the setting
  // means the same thing in both places, so it lives in one key.
  const writeRef = useRef(write);
  writeRef.current = write;
  useEffect(() => {
    // Only a clean tab is auto-written: a conflict waits for the user's Reload
    // or Save again, and a failed write waits for Retry, so the timer cannot
    // loop against a file the user is being asked about.
    if (!autosave || !dirty || !editable || save.kind !== "clean") return;
    const timer = window.setTimeout(() => writeRef.current(draft ?? ""), AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [autosave, dirty, draft, editable, save.kind]);

  return (
    <FilePane
      path={path}
      file={file}
      error={error}
      text={text}
      dirty={dirty}
      mode={mode}
      save={save}
      autosave={autosave}
      lineWrap={lineWrap}
      revealLine={lineRange === null ? null : lineRange.startLineNumber}
      onToggleLineWrap={() => {
        const next = !lineWrap;
        setLineWrap(next);
        writePref(LINE_WRAP_KEY, String(next));
      }}
      onToggleAutosave={() => {
        const next = !autosave;
        setAutosave(next);
        writePref(AUTOSAVE_KEY, String(next));
      }}
      onChangeDraft={(_path, next) => setDraft(next)}
      onSave={(_path, options) => write(draft ?? "", options)}
      onReload={read}
      onSetMode={(_path, next) => setMode(next)}
      onCopyContent={(_path, contents) => copyToClipboard(contents, "Contents")}
      onCopyPath={(target) => copyToClipboard(target, "Path")}
    />
  );
}
