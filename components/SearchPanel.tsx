/**
 * The editor's find-and-replace panel.
 *
 * CodeMirror ships a working panel whose markup and CSS predate any design
 * system: bare inputs with `silver` borders, `70%`-size text, gradient buttons,
 * and labels that are plain text nodes. It cannot be styled into bb's chrome
 * from the outside either — every class in it is a base-theme rule, and base
 * themes are emitted last, so they beat any `EditorView.theme` rule.
 *
 * `SearchConfig.createPanel` is the supported way out: CodeMirror still owns the
 * search state, the keymap, and the commands; this panel only renders them with
 * bb's own tokens and components.
 *
 * React cannot mount a root inside the panel — the plugin runtime hands plugins
 * `react-dom` without `react-dom/client` — so the panel renders through a
 * portal from the editor component's own tree, and CodeMirror keeps the host
 * element it created.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { EditorView, runScopeHandlers, type Panel } from "@codemirror/view";
import { Compartment } from "@codemirror/state";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  selectMatches,
  setSearchQuery,
  SearchQuery,
} from "@codemirror/search";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS } from "@/components/ui/coarse-pointer-sizing";
import { cn } from "@/lib/utils";

/**
 * A portal target that is also a CodeMirror panel.
 *
 * `view` is filled in on first render: the panel is created while the editor
 * component is still mounting, so the component hands the view over once it
 * exists.
 */
export interface SearchPanelTarget {
  dom: HTMLElement;
  view: EditorView | null;
  /**
   * Holds the update listener the portal installs while the panel is open.
   * Lives in the editor's configuration from the start so the portal can
   * reconfigure it without rebuilding the view.
   */
  updates: Compartment;
}

export function createSearchPanelTarget(updates: Compartment): SearchPanelTarget {
  return { dom: document.createElement("div"), view: null, updates };
}

/** The `Panel` CodeMirror mounts, rendering `target.dom` as its element. */
export function createSearchPanel(target: SearchPanelTarget): (view: EditorView) => Panel {
  return (view) => {
    target.view = view;
    return {
      dom: target.dom,
      top: true,
      destroy() {
        target.view = null;
      },
    };
  };
}

/**
 * Renders the panel's React tree into CodeMirror's element.
 *
 * The portal target is a plain DOM node, so React has no way to know when the
 * panel opens, closes, or changes query. `panelOpen` and the editor's own
 * update events drive that instead.
 */
export function SearchPanelPortal({
  target,
  view,
}: {
  target: SearchPanelTarget;
  view: EditorView | null;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (view === null) return;
    const sync = (): void => setOpen(view.dom.querySelector(".cm-panel") !== null);
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(view.dom, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [view]);

  // The panel has to follow the editor's own search state, which the keymap
  // changes without this component rendering. One listener on every update is
  // the cheapest correct signal, and it exists only while the panel is open.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (view === null || !open) return;
    view.dispatch({
      effects: target.updates.reconfigure(
        EditorView.updateListener.of(() => setTick((value) => value + 1)),
      ),
    });
    return () => {
      view.dispatch({ effects: target.updates.reconfigure([]) });
    };
  }, [view, open, target]);

  if (!open || target.view === null) return null;
  return createPortal(<SearchPanel view={target.view} />, target.dom);
}

function SearchPanel({ view }: { view: EditorView }) {
  const query = getSearchQuery(view.state);
  const [search, setSearch] = useState(query.search);
  const [replace, setReplace] = useState(query.replace);

  // The panel outlives any single query: a keymap command, a reopened panel, or
  // another tab can change the query behind this component's back, and the
  // fields must follow rather than keep the values they mounted with.
  const [shownQuery, setShownQuery] = useState(query);
  if (!query.eq(shownQuery)) {
    setShownQuery(query);
    setSearch(query.search);
    setReplace(query.replace);
  }

  const searchRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    searchRef.current?.focus();
    searchRef.current?.select();
  }, []);

  const apply = (patch: {
    search?: string;
    replace?: string;
    caseSensitive?: boolean;
    regexp?: boolean;
    wholeWord?: boolean;
  }): void => {
    view.dispatch({
      effects: setSearchQuery.of(
        new SearchQuery({
          search: patch.search ?? search,
          replace: patch.replace ?? replace,
          caseSensitive: patch.caseSensitive ?? query.caseSensitive,
          regexp: patch.regexp ?? query.regexp,
          wholeWord: patch.wholeWord ?? query.wholeWord,
        }),
      ),
    });
  };

  // An unfinished regexp is the one query state worth showing: it is the
  // difference between "no matches" and "this cannot be searched for".
  const invalid = search.length > 0 && !query.valid;

  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border bg-popover px-2 py-1.5 text-xs text-popover-foreground"
      // CodeMirror's own panel routes key events through the `search-panel`
      // scope, which is what makes Escape close the panel and F3 / Mod-g step
      // through matches while a field has focus. A React panel has to do it
      // itself; the bindings are registered by `searchKeymap` already.
      onKeyDown={(event) => {
        if (runScopeHandlers(view, event.nativeEvent, "search-panel")) {
          event.preventDefault();
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <div className="relative min-w-0 flex-1 basis-40">
          <Input
            ref={searchRef}
            value={search}
            placeholder="Find"
            aria-label="Find"
            aria-invalid={invalid}
            spellCheck={false}
            // CodeMirror's own panel tags its search input this way;
            // `openSearchPanel` looks the attribute up to refocus the field
            // when find is invoked again, and find-next uses it to keep the
            // caret in the field.
            {...({ "main-field": "true" } as Record<string, string>)}
            className={cn(
              "h-7 py-0 pr-7 font-mono text-xs",
              invalid && "border-destructive focus-visible:ring-destructive",
            )}
            onChange={(event) => {
              setSearch(event.target.value);
              apply({ search: event.target.value });
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              if (event.shiftKey) findPrevious(view);
              else findNext(view);
            }}
          />
          {search.length === 0 ? null : (
            <button
              type="button"
              title="Clear the search"
              aria-label="Clear the search"
              className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:bg-state-hover hover:text-foreground"
              onClick={() => {
                setSearch("");
                apply({ search: "" });
                searchRef.current?.focus();
              }}
            >
              <Icon name="X" aria-hidden className="size-3" />
            </button>
          )}
        </div>

        <PanelIconButton label="Previous match (Shift+Enter)" onClick={() => findPrevious(view)}>
          <Icon name="ChevronUp" aria-hidden className="size-3.5" />
        </PanelIconButton>
        <PanelIconButton label="Next match (Enter)" onClick={() => findNext(view)}>
          <Icon name="ChevronDown" aria-hidden className="size-3.5" />
        </PanelIconButton>
        <PanelIconButton label="Select all matches" onClick={() => selectMatches(view)}>
          <Icon name="Copy" aria-hidden className="size-3.5" />
        </PanelIconButton>

        <div className="mx-0.5 h-4 w-px bg-border" />

        <PanelToggle
          label="Match case"
          active={query.caseSensitive}
          onToggle={() => apply({ caseSensitive: !query.caseSensitive })}
        />
        <PanelToggle
          label="Regexp"
          active={query.regexp}
          onToggle={() => apply({ regexp: !query.regexp })}
        />
        <PanelToggle
          label="By word"
          active={query.wholeWord}
          onToggle={() => apply({ wholeWord: !query.wholeWord })}
        />

        <PanelIconButton
          label="Close find"
          className="ml-auto"
          onClick={() => closeSearchPanel(view)}
        >
          <Icon name="X" aria-hidden className="size-3.5" />
        </PanelIconButton>
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <Input
          value={replace}
          placeholder="Replace"
          aria-label="Replace"
          spellCheck={false}
          className="h-7 min-w-0 flex-1 basis-40 py-0 font-mono text-xs"
          onChange={(event) => {
            setReplace(event.target.value);
            apply({ replace: event.target.value });
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs font-normal"
          onClick={() => replaceNext(view)}
        >
          Replace
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs font-normal"
          onClick={() => replaceAll(view)}
        >
          Replace all
        </Button>
      </div>
    </div>
  );
}

/**
 * The panel must keep the editor's focus. A press that moves focus into the
 * panel closes the editor's own key handling, so every control suppresses the
 * default focus change and leaves the caret where the match is.
 */
function PanelIconButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick(): void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground",
        "hover:bg-state-hover hover:text-foreground",
        COARSE_POINTER_TOOLBAR_ACTION_BUTTON_CLASS,
        className,
      )}
    >
      {children}
    </button>
  );
}

function PanelToggle({
  label,
  active,
  onToggle,
}: {
  label: string;
  active: boolean;
  onToggle(): void;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onToggle}
      className={cn(
        "rounded-md border px-1.5 py-1 text-[11px]",
        active
          ? "border-input bg-state-active text-foreground"
          : "border-transparent text-muted-foreground hover:bg-state-hover hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}
