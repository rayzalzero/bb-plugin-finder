import { useRef } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { OutlineKind, OutlineSymbol } from "@/lib/outline";

export interface OutlinePanelProps {
  open: boolean;
  onToggleOpen(): void;
  /** The file the symbols belong to, or null when no tab is in front. */
  path: string | null;
  symbols: readonly OutlineSymbol[];
  /** True while the file has text but the outline has not been derived yet. */
  pending: boolean;
  onOpenSymbol(line: number): void;
  /** The panel's height in pixels, as the user last dragged it. */
  height: number;
  onResize(next: number): void;
}

/** A glyph per symbol family, so the shape of a file reads at a glance. */
const KIND_ICON: Readonly<Record<OutlineKind, string>> = {
  class: "Layers",
  interface: "Layers",
  enum: "Layers",
  type: "Layers",
  trait: "Layers",
  impl: "Layers",
  module: "Layers",
  namespace: "Layers",
  function: "Code",
  method: "Code",
  macro: "Code",
  property: "List",
  variable: "List",
  constant: "List",
  key: "List",
  heading: "SectionAdd",
  section: "SectionAdd",
  element: "List",
  rule: "List",
};

const KIND_TONE: Readonly<Record<OutlineKind, string>> = {
  class: "text-amber-400",
  interface: "text-teal-400",
  enum: "text-orange-300",
  type: "text-cyan-400",
  trait: "text-violet-400",
  impl: "text-violet-300",
  module: "text-pink-400",
  namespace: "text-pink-400",
  function: "text-blue-400",
  method: "text-blue-300",
  macro: "text-fuchsia-400",
  property: "text-emerald-400",
  variable: "text-emerald-300",
  constant: "text-emerald-200",
  key: "text-amber-300",
  heading: "text-sky-400",
  section: "text-sky-300",
  element: "text-orange-400",
  rule: "text-fuchsia-300",
};

/**
 * The symbol tree of the file in front: classes, functions, headings, keys —
 * whatever the file's own grammar calls a declaration. It is the "where is it"
 * map for a long file, so a click lands the caret on the declaration.
 */
export function OutlinePanel({
  open,
  onToggleOpen,
  path,
  symbols,
  pending,
  onOpenSymbol,
  height,
  onResize,
}: OutlinePanelProps) {
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(height);
  if (!open) return null;

  return (
    <div
      // `max-h-[70%]` is the backstop: the sidebar can be short, and a height
      // remembered from a tall window must not push the tree out of sight.
      className="flex max-h-[70%] shrink-0 flex-col"
      style={{ height }}
    >
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the outline"
        tabIndex={0}
        onPointerDown={(event) => {
          dragStartY.current = event.clientY;
          // Measured, not the prop: `max-h-[70%]` can render the panel shorter
          // than the height it remembers, and a drag must start from what the
          // user is actually grabbing or the first move jumps.
          dragStartHeight.current =
            event.currentTarget.parentElement?.getBoundingClientRect().height ?? height;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          // Dragging up grows the panel, so the delta is inverted.
          onResize(dragStartHeight.current - (event.clientY - dragStartY.current));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") onResize(height + 16);
          if (event.key === "ArrowDown") onResize(height - 16);
        }}
        className="h-1.5 shrink-0 cursor-row-resize border-t border-border bg-transparent hover:bg-accent"
      />
      <div className="flex items-center gap-1 px-2 py-1">
        <Icon name="Layers" aria-hidden className="size-3 text-muted-foreground" />
        <span className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
          Outline
        </span>
        {symbols.length === 0 ? null : (
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {symbols.length}
          </span>
        )}
        <button
          type="button"
          title="Hide the outline"
          aria-label="Hide the outline"
          onClick={onToggleOpen}
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          <Icon name="ChevronDown" aria-hidden className="size-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto pb-1" role="tree" aria-label="Outline">
        {path === null ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            Open a file to see its outline.
          </p>
        ) : pending && symbols.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">Reading symbols…</p>
        ) : symbols.length === 0 ? (
          <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
            No symbols in this file. Plain text, data, and very large files have no outline.
          </p>
        ) : (
          symbols.map((symbol, index) => (
            <button
              key={`${symbol.line}:${index}`}
              type="button"
              role="treeitem"
              aria-selected={false}
              title={`${symbol.name} — line ${symbol.line}`}
              onClick={() => onOpenSymbol(symbol.line)}
              style={{ paddingLeft: `${symbol.depth * 12 + 8}px` }}
              className="flex w-full items-center gap-1.5 py-[3px] pr-2 text-left text-xs hover:bg-accent hover:text-accent-foreground"
            >
              <Icon
                name={KIND_ICON[symbol.kind]}
                aria-hidden
                className={cn("size-3.5 shrink-0", KIND_TONE[symbol.kind])}
              />
              <span className="truncate">{symbol.name}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                {symbol.line}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
