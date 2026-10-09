import { useMemo } from "react";
import { FilePane, copyToClipboard, type SaveState } from "./FilePane";
import { isDirty, renderedText, type FileTab } from "./use-file-tabs";
import type { FileViewMode } from "@/lib/file-kind";
import { languageForPath, languageLabel, formatBytes } from "@/lib/file-kind";

export interface FileViewProps {
  tab: FileTab;
  autosave: boolean;
  lineWrap: boolean;
  onToggleLineWrap(): void;
  onToggleAutosave(): void;
  onChangeDraft(path: string, draft: string): void;
  onSave(path: string, options?: { force: boolean }): void;
  onReload(path: string): void;
  onSetMode(path: string, mode: FileViewMode): void;
  onAddToChat(path: string, text: string): void;
  onCopyContent(path: string, text: string): void;
  onCopyPath(path: string): void;
  /** 1-based line the editor should reveal once the file is loaded. */
  revealLine: number | null;
  /** Called once the pane has taken `revealLine`, so the caller can drop it. */
  onRevealConsumed(): void;
}

/**
 * The Finder panel's file pane: the tab's own state, handed to the shared
 * pane. All rendering lives in `FilePane` so this tab and BB's file tab cannot
 * drift apart.
 */
export function FileView({
  tab,
  autosave,
  lineWrap,
  onToggleLineWrap,
  onToggleAutosave,
  onChangeDraft,
  onSave,
  onReload,
  onSetMode,
  onAddToChat,
  onCopyContent,
  onCopyPath,
  revealLine,
  onRevealConsumed,
}: FileViewProps) {
  const save = useMemo<SaveState>(
    () =>
      tab.save.kind === "error"
        ? { kind: "error", message: tab.save.message }
        : { kind: tab.save.kind },
    [tab.save],
  );

  return (
    <FilePane
      path={tab.path}
      file={tab.file}
      error={tab.error}
      text={renderedText(tab)}
      dirty={isDirty(tab)}
      mode={tab.mode}
      save={save}
      autosave={autosave}
      lineWrap={lineWrap}
      revealLine={revealLine}
      onRevealConsumed={onRevealConsumed}
      onToggleLineWrap={onToggleLineWrap}
      onToggleAutosave={onToggleAutosave}
      onChangeDraft={onChangeDraft}
      onSave={onSave}
      onReload={onReload}
      onSetMode={onSetMode}
      onCopyContent={onCopyContent}
      onCopyPath={onCopyPath}
      onAddToChat={onAddToChat}
    />
  );
}

export { languageForPath, languageLabel, formatBytes, copyToClipboard };
