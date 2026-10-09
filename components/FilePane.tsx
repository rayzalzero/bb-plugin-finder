import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Markdown,
  experimental_SourceCode as SourceCode,
  experimental_useCodeTheme,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CodeEditor, type CodeEditorHandle } from "./CodeEditor";
import { PaneCentered, PaneNotice, PaneToolbarButton } from "./FilePaneChrome";
import {
  allowedMode,
  formatBytes,
  isMarkdownPath,
  languageForPath,
  languageLabel,
  type FileViewMode,
} from "@/lib/file-kind";
import { languageExtension } from "@/lib/editor-language";
import { editorTheme } from "@/lib/editor-theme";
import type { ReadResult } from "../server.js";

/**
 * How a write ended. Shared by the panel's tab store and the standalone file
 * tab, because both render the same conflict and error affordances.
 */
export type SaveState =
  | { kind: "clean" }
  | { kind: "saving" }
  | { kind: "conflict" }
  | { kind: "error"; message: string };

export interface FilePaneProps {
  path: string;
  /** The file as read, or null while the read is still in flight. */
  file: ReadResult | null;
  /** A failed read, shown in place of the editor. */
  error: string | null;
  /** What the pane renders: the draft over the file, or null with no text. */
  text: string | null;
  dirty: boolean;
  /** The mode the tab asked for; the pane resolves it against the text. */
  mode: FileViewMode;
  save: SaveState;
  autosave: boolean;
  lineWrap: boolean;
  /** 1-based line to reveal once the text has arrived. */
  revealLine: number | null;
  /**
   * Called once the pane has taken `revealLine`, so the caller can drop it.
   * Omitted where the line is owned elsewhere (BB's file tab passes a fresh
   * `lineRange` per targeted open, and that component remounts per path).
   */
  onRevealConsumed?(): void;
  onToggleLineWrap(): void;
  onToggleAutosave(): void;
  onChangeDraft(path: string, draft: string): void;
  onSave(path: string, options?: { force: boolean }): void;
  onReload(path: string): void;
  onSetMode(path: string, mode: FileViewMode): void;
  onCopyContent(path: string, text: string): void;
  onCopyPath(path: string): void;
  /** Absent where there is no composer to attach to. */
  onAddToChat?: (path: string, text: string) => void;
}

/**
 * The file pane: toolbar, notices, and the body — markdown preview, source
 * viewer, or editor. The Finder panel and BB's file tab both render this, so
 * a file looks and behaves the same whichever surface opened it.
 */
export function FilePane({
  path,
  file,
  error,
  text,
  dirty,
  mode: requestedMode,
  save,
  autosave,
  lineWrap,
  revealLine,
  onRevealConsumed,
  onToggleLineWrap,
  onToggleAutosave,
  onChangeDraft,
  onSave,
  onReload,
  onSetMode,
  onCopyContent,
  onCopyPath,
  onAddToChat,
}: FilePaneProps) {
  const codeTheme = experimental_useCodeTheme();
  const handle = useRef<CodeEditorHandle>({
    openFind: () => {},
    goToLine: () => {},
  }).current;
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");

  const isText = file !== null && file.kind === "text";
  const language = useMemo(() => languageForPath(path), [path]);
  const extension = useMemo(() => languageExtension(language), [language]);
  const theme = useMemo(
    () => editorTheme(codeTheme.theme, codeTheme.mode),
    [codeTheme.mode, codeTheme.theme],
  );

  const mode = allowedMode(requestedMode, path, text);
  const isMarkdown = isMarkdownPath(path);

  // A caller names a line and nothing else, so the editor reveals it once the
  // text has arrived, then reports it consumed — the caller clears the prop, so
  // opening the next file cannot drag the caret back to a line nobody asked
  // for. The guard is still keyed by path as well as line: two files whose hit
  // sits on the same line number are two different targets.
  const revealedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (revealLine === null || text === null) return;
    const target = `${path}:${revealLine}`;
    if (revealedTarget.current === target) return;
    revealedTarget.current = target;
    if (mode !== "edit") onSetMode(path, "edit");
    window.setTimeout(() => handle.goToLine(revealLine), 0);
    onRevealConsumed?.();
  }, [handle, mode, onRevealConsumed, onSetMode, path, revealLine, text]);

  const requestFind = useCallback(() => {
    if (mode !== "edit") onSetMode(path, "edit");
    // The editor may not exist yet on the frame that switches mode.
    window.setTimeout(() => handle.openFind(), 0);
  }, [handle, mode, onSetMode, path]);

  const jumpToLine = useCallback(() => {
    const line = Number.parseInt(goToLineValue, 10);
    setGoToLineOpen(false);
    setGoToLineValue("");
    if (!Number.isFinite(line) || line < 1) return;
    if (mode !== "edit") onSetMode(path, "edit");
    window.setTimeout(() => handle.goToLine(line), 0);
  }, [goToLineValue, handle, mode, onSetMode, path]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-2 py-1">
        <span className="mr-1 truncate font-mono text-xs text-muted-foreground" title={path}>
          {path}
        </span>
        {dirty ? (
          <span
            className="mr-1 size-1.5 shrink-0 rounded-full bg-amber-400"
            title="Unsaved changes"
            aria-label="Unsaved changes"
          />
        ) : null}

        <PaneToolbarButton
          label="Save"
          icon="Download"
          disabled={!dirty || !isText}
          onClick={() => onSave(path)}
        />
        <PaneToolbarButton
          label="Reload from disk"
          icon="ArrowReloadHorizontal"
          onClick={() => onReload(path)}
        />
        <PaneToolbarButton label="Find in file (Ctrl/Cmd+F)" icon="Search" onClick={requestFind} />

        {goToLineOpen ? (
          <form
            className="flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              jumpToLine();
            }}
          >
            <Input
              autoFocus
              value={goToLineValue}
              onChange={(event) => setGoToLineValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setGoToLineOpen(false);
              }}
              onBlur={() => setGoToLineOpen(false)}
              placeholder="Line"
              aria-label="Go to line"
              inputMode="numeric"
              className="h-6 w-16 text-xs"
            />
          </form>
        ) : (
          <PaneToolbarButton
            label="Go to line"
            icon="MoveTo"
            disabled={!isText}
            onClick={() => setGoToLineOpen(true)}
          />
        )}

        <span className="mx-0.5 h-4 w-px bg-border" />

        <PaneToolbarButton
          label={lineWrap ? "Disable line wrap" : "Enable line wrap"}
          icon="TextWrap"
          active={lineWrap}
          onClick={onToggleLineWrap}
        />
        <PaneToolbarButton
          label={autosave ? "Auto-save on" : "Auto-save off"}
          icon={autosave ? "Square" : "SquareUnlock02"}
          active={autosave}
          onClick={onToggleAutosave}
        />

        <span className="mx-0.5 h-4 w-px bg-border" />

        {isMarkdown && isText ? (
          <PaneToolbarButton
            // Driven by the RESOLVED mode, not the request: a markdown file too
            // large to preview resolves to `read`, and the button has to offer
            // the editor then — offering "Preview markdown" there would set a
            // request that resolves straight back to `read`, leaving the file
            // stuck in a read-only viewer it can never leave.
            label={mode === "edit" ? "Preview markdown" : "Switch to editor"}
            icon={mode === "edit" ? "Eye" : "Edit"}
            active={mode === "preview"}
            onClick={() => onSetMode(path, mode === "edit" ? "preview" : "edit")}
          />
        ) : null}
        <PaneToolbarButton
          label="Copy file contents"
          icon="Copy"
          disabled={text === null}
          onClick={() => {
            if (text !== null) onCopyContent(path, text);
          }}
        />
        <PaneToolbarButton label="Copy path" icon="FileText" onClick={() => onCopyPath(path)} />
        {onAddToChat === undefined ? null : (
          <PaneToolbarButton
            label="Add file as context to the prompt"
            icon="MessageSquarePlus"
            disabled={text === null}
            onClick={() => {
              if (text !== null) onAddToChat(path, text);
            }}
          />
        )}

        <span className="ml-auto flex items-center gap-2 pr-1 text-[10px] text-muted-foreground">
          {save.kind === "saving" ? <span>Saving…</span> : null}
          {save.kind === "clean" && dirty ? <span>Edited</span> : null}
          {isText ? <span>{languageLabel(path)}</span> : null}
          {file !== null ? <span>{formatBytes(file.sizeBytes)}</span> : null}
          {isText && file.kind === "text" && !file.editable ? (
            <span>read-only (large)</span>
          ) : null}
        </span>
      </div>

      {save.kind === "conflict" ? (
        <PaneNotice tone="warning">
          <span>This file changed on disk since it was opened.</span>
          <Button size="sm" variant="outline" onClick={() => onReload(path)}>
            Reload (discard my edit)
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              // Overwrite what is on disk now: the user chose to keep their
              // text, so the stale hash must not be sent again — retrying with
              // it would conflict on every click.
              onSave(path, { force: true });
            }}
          >
            Save again
          </Button>
        </PaneNotice>
      ) : null}
      {save.kind === "error" ? (
        <PaneNotice tone="error">
          <span>{save.message}</span>
          <Button size="sm" variant="outline" onClick={() => onSave(path)}>
            Retry
          </Button>
        </PaneNotice>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {error !== null ? (
          <PaneCentered tone="error">{error}</PaneCentered>
        ) : file === null ? (
          <PaneCentered>
            <Icon name="Loading" aria-hidden className="size-4 animate-spin" />
            <span>Opening {path}…</span>
          </PaneCentered>
        ) : file.kind === "image" ? (
          <div className="flex h-full items-start justify-center overflow-auto bg-muted/30 p-4">
            <img
              src={file.dataUrl}
              alt={path}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        ) : file.kind === "binary" ? (
          <PaneCentered>{file.reason}</PaneCentered>
        ) : mode === "preview" && text !== null ? (
          <div className="h-full overflow-auto px-4 py-4">
            <Markdown content={text} />
          </div>
        ) : mode === "read" || file.editable === false ? (
          <SourceCode
            content={text ?? ""}
            path={path}
            overflow={lineWrap ? "wrap" : "scroll"}
            className="h-full"
          />
        ) : (
          <CodeEditor
            // Keyed on the path alone: keying on the hash too would rebuild
            // the state after every save and throw away the undo history.
            documentKey={path}
            value={text ?? ""}
            language={extension}
            readOnly={false}
            lineWrap={lineWrap}
            theme={theme}
            onChange={(next) => onChangeDraft(path, next)}
            onSave={() => onSave(path)}
            onGoToLine={() => {
              if (mode === "preview") onSetMode(path, "edit");
              setGoToLineOpen(true);
            }}
            handle={handle}
            className="h-full"
          />
        )}
      </div>
    </div>
  );
}

/** Copy text to the clipboard and confirm, since a pane has no other feedback. */
export function copyToClipboard(text: string, what: string): void {
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${what} copied`))
    .catch(() => toast.error(`Could not copy the ${what.toLowerCase()}`));
}
