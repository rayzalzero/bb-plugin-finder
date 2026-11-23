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
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  allowedMode,
  formatBytes,
  isHtmlPath,
  isPreviewablePath,
  languageForPath,
  languageLabel,
  type FileViewMode,
} from "@/lib/file-kind";
import { languageExtension } from "@/lib/editor-language";
import { editorTheme } from "@/lib/editor-theme";
import { formatLineRange, rangeForSelectedText, type BlockSpan, type LineRange } from "@/lib/mention";
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
  /**
   * Absent where there is no composer to attach to. With `range`, the pill
   * stands for those lines only; without it, for the whole file.
   */
  onAddToChat?: (path: string, range?: LineRange) => void;
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
    copy: () => {},
    cut: () => {},
    paste: () => {},
  }).current;
  const [goToLineOpen, setGoToLineOpen] = useState(false);
  const [goToLineValue, setGoToLineValue] = useState("");
  /** Lines the editor's selection covers, or null when it is only a caret. */
  const [selection, setSelection] = useState<LineRange | null>(null);
  /** True while the preview holds a non-collapsed DOM selection of its own. */
  const [previewSelected, setPreviewSelected] = useState(false);
  /** The rendered-markdown container, for reading a DOM selection out of it. */
  const previewRef = useRef<HTMLDivElement | null>(null);

  const isText = file !== null && file.kind === "text";
  const language = useMemo(() => languageForPath(path), [path]);
  const extension = useMemo(() => languageExtension(language), [language]);
  const theme = useMemo(
    () => editorTheme(codeTheme.theme, codeTheme.mode),
    [codeTheme.mode, codeTheme.theme],
  );

  const mode = allowedMode(requestedMode, path, text);
  const isPreviewable = isPreviewablePath(path);
  const isHtml = isHtmlPath(path);
  const previewNoun = isHtml ? "HTML" : "markdown";

  // A caller names a line and nothing else, so the editor reveals it once the
  // text has arrived, then reports it consumed — the caller clears the prop, so
  // opening the next file cannot drag the caret back to a line nobody asked
  // for. The guard is still keyed by path as well as line: two files whose hit
  // sits on the same line number are two different targets.
  const revealedTarget = useRef<string | null>(null);
  useEffect(() => {
    if (revealLine === null) {
      // The caller dropped the line, so the next request for the same target —
      // clicking the same outline symbol again — is a new request, not a repeat.
      revealedTarget.current = null;
      return;
    }
    if (text === null) return;
    const target = `${path}:${revealLine}`;
    if (revealedTarget.current === target) return;
    revealedTarget.current = target;
    if (mode !== "edit") onSetMode(path, "edit");
    window.setTimeout(() => handle.goToLine(revealLine), 0);
    onRevealConsumed?.();
  }, [handle, mode, onRevealConsumed, onSetMode, path, revealLine, text]);

  // A selection only lives while its surface is mounted; switching to preview,
  // to the source viewer, or to another file drops the old one, or the toolbar
  // would offer to attach lines the user cannot see.
  useEffect(() => {
    setSelection(null);
    setPreviewSelected(false);
  }, [path, mode]);

  // A rendered markdown preview is read-only, so the editor's selection callback
  // never fires there. Read the browser's DOM selection out of the preview and
  // map it back to the source lines the pill resolves against.
  useEffect(() => {
    if (mode !== "preview" || isHtml || text === null) return;
    const container = previewRef.current;
    if (container === null) return;

    const sync = () => {
      const selection = window.getSelection();
      if (
        selection === null ||
        selection.isCollapsed ||
        !container.contains(selection.anchorNode) ||
        !container.contains(selection.focusNode)
      ) {
        setPreviewSelected(false);
        setSelection(null);
        return;
      }
      setPreviewSelected(true);
      let hint = 0;
      let block: BlockSpan | null = null;
      try {
        const range = selection.getRangeAt(0);
        const prefix = range.cloneRange();
        prefix.selectNodeContents(container);
        prefix.setEnd(range.startContainer, range.startOffset);
        const full = document.createRange();
        full.selectNodeContents(container);
        const total = full.toString().length;
        hint = total === 0 ? 0 : prefix.toString().length / total;

        // Pin the selection to its block when the start and end share one, so a
        // plain paragraph or heading maps to an exact source span rather than
        // being guessed among repeated words across the whole file.
        const startBlock = closestBlock(range.startContainer);
        const endBlock = closestBlock(range.endContainer);
        if (startBlock !== null && startBlock === endBlock) {
          const blockRange = document.createRange();
          blockRange.selectNodeContents(startBlock);
          const text = blockRange.toString();
          const startPrefix = blockRange.cloneRange();
          startPrefix.setEnd(range.startContainer, range.startOffset);
          const endPrefix = blockRange.cloneRange();
          endPrefix.setEnd(range.endContainer, range.endOffset);
          if (text.trim() !== "") {
            block = { text, start: startPrefix.toString().length, end: endPrefix.toString().length };
          }
        }
      } catch {
        // A selection that straddles the renderer's internals can refuse a Range
        // against the container; fall back to no hint rather than losing it.
        hint = 0;
        block = null;
      }
      setSelection(rangeForSelectedText(text, selection.toString(), hint, block));
    };

    // `mouseup` on the container covers a drag released inside it (even if a
    // child stops it from bubbling), the document listener covers one released
    // outside, and `keyup` covers keyboard-driven selection changes.
    container.addEventListener("mouseup", sync);
    container.addEventListener("keyup", sync);
    document.addEventListener("mouseup", sync);
    return () => {
      container.removeEventListener("mouseup", sync);
      container.removeEventListener("keyup", sync);
      document.removeEventListener("mouseup", sync);
    };
  }, [isHtml, mode, text]);

  const attachToPrompt = useCallback(() => {
    if (onAddToChat === undefined) return;
    if (selection !== null) {
      onAddToChat(path, selection);
      return;
    }
    // The preview has a selection we could not map back to source lines; a
    // whole-file pill would silently say the wrong thing, so refuse instead.
    if (previewSelected) {
      toast.error("Couldn't map the selection to source lines");
      return;
    }
    onAddToChat(path);
  }, [onAddToChat, path, previewSelected, selection]);

  // Copy what is selected — the editor's selection when it is mounted, else the
  // rendered/read view's DOM selection — and fall back to the whole file when
  // nothing is selected, matching the toolbar's "Copy file contents".
  const copyFromPane = useCallback(() => {
    if (text === null) return;
    if (mode === "edit" && file !== null && file.kind === "text" && file.editable && selection !== null) {
      handle.copy();
      return;
    }
    const dom = window.getSelection();
    const selected = dom !== null && !dom.isCollapsed ? dom.toString() : "";
    copyToClipboard(selected !== "" ? selected : text, selected !== "" ? "Selection" : "Contents");
  }, [file, handle, mode, selection, text]);

  // Mod-Alt-a attaches the selection in the editor; mirror it in the preview
  // only while there is a selection, so the shortcut never swallows the host's
  // own binding when the pane is just being read.
  useEffect(() => {
    if (mode !== "preview" || isHtml || selection === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "a" && (event.ctrlKey || event.metaKey) && event.altKey) {
        event.preventDefault();
        attachToPrompt();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [isHtml, mode, selection, attachToPrompt]);

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
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1">
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

        {isPreviewable && isText ? (
          <PaneToolbarButton
            // Driven by the RESOLVED mode, not the request: a markdown file too
            // large to preview resolves to `read`, and the button has to offer
            // the editor then — offering "Preview markdown" there would set a
            // request that resolves straight back to `read`, leaving the file
            // stuck in a read-only viewer it can never leave.
            label={mode === "edit" ? `Preview ${previewNoun}` : "Switch to editor"}
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
            label={
              selection !== null
                ? `Add lines ${formatLineRange(selection)} as context to the prompt (Ctrl/Cmd+Alt+A)`
                : previewSelected
                  ? "Selection couldn't be mapped to lines"
                  : "Add file as context to the prompt (Ctrl/Cmd+Alt+A)"
            }
            icon="MessageSquarePlus"
            disabled={text === null}
            active={selection !== null}
            onClick={attachToPrompt}
          />
        )}

        <span className="ml-auto flex items-center gap-2 pr-1 text-[10px] text-muted-foreground">
          {save.kind === "saving" ? <span>Saving…</span> : null}
          {save.kind === "clean" && dirty ? <span>Edited</span> : null}
          {selection === null ? null : <span>Lines {formatLineRange(selection)}</span>}
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

      <ContextMenu>
        <ContextMenuTrigger asChild>
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
            ) : mode === "preview" && text !== null && isHtml ? (
              <iframe
                // No allow-same-origin: the page runs in an opaque origin, so it
                // cannot read BB's DOM, storage or cookies. BB itself rejects
                // `Origin: null` with 403, so its API and this plugin's RPC stay out
                // of reach too; only outbound requests to other hosts get through,
                // and their responses stay unreadable. Scripts, forms and popups
                // stay on so generated reports and demos behave as in a tab.
                title={path}
                srcDoc={text}
                sandbox="allow-scripts allow-forms allow-popups allow-modals"
                className="h-full w-full border-0 bg-white"
              />
            ) : mode === "preview" && text !== null ? (
              <div ref={previewRef} className="h-full overflow-auto px-4 py-4">
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
                onSelectionChange={setSelection}
                onAttachSelection={attachToPrompt}
                handle={handle}
                className="h-full"
              />
            )}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            disabled={text === null || (previewSelected && selection === null)}
            onSelect={attachToPrompt}
          >
            {selection !== null
              ? `Add lines ${formatLineRange(selection)} to prompt`
              : "Add file to prompt"}
            <ContextMenuShortcut>Ctrl/Cmd+Alt+A</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={text === null} onSelect={copyFromPane}>
            Copy
            <ContextMenuShortcut>Ctrl/Cmd+C</ContextMenuShortcut>
          </ContextMenuItem>
          {mode === "edit" && file !== null && file.kind === "text" && file.editable ? (
            <>
              <ContextMenuItem onSelect={handle.cut}>
                Cut
                <ContextMenuShortcut>Ctrl/Cmd+X</ContextMenuShortcut>
              </ContextMenuItem>
              <ContextMenuItem onSelect={handle.paste}>
                Paste
                <ContextMenuShortcut>Ctrl/Cmd+V</ContextMenuShortcut>
              </ContextMenuItem>
            </>
          ) : null}
        </ContextMenuContent>
      </ContextMenu>
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

/** The nearest markdown block element containing `node`, or null. */
function closestBlock(node: Node): Element | null {
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest("p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre") ?? null;
}
