import { useEffect, useRef, useState } from "react";
import { Compartment, EditorState, StateEffect, Transaction, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import { bracketMatching, indentOnInput } from "@codemirror/language";
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  createSearchPanel,
  createSearchPanelTarget,
  SearchPanelPortal,
} from "./SearchPanel.js";

export interface CodeEditorHandle {
  /** Open CodeMirror's own find-in-file panel (Mod-F also works). */
  openFind(): void;
  /** Put the caret on a 1-based line and scroll it into view. */
  goToLine(line: number): void;
}

export interface CodeEditorProps {
  /** Identity of the open document. A change replaces the document and clears undo. */
  documentKey: string;
  value: string;
  language: Extension | null;
  readOnly: boolean;
  lineWrap: boolean;
  theme: Extension;
  onChange: (value: string) => void;
  onSave: () => void;
  /** Mod-Alt-g, routed to the plugin's own line field instead of the built-in dialog. */
  onGoToLine(): void;
  className?: string;
  handle: CodeEditorHandle;
}

/**
 * The editor surface. CodeMirror owns its own DOM and document, so the view is
 * created once and every later prop arrives as a transaction or a whole-state
 * swap — rebuilding the view would drop scroll position, selection, undo
 * history, and the find panel's state.
 */
export function CodeEditor({
  documentKey,
  value,
  language,
  readOnly,
  lineWrap,
  theme,
  onChange,
  onSave,
  onGoToLine,
  className,
  handle,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  // The search panel portal is a child component, so its effects run BEFORE
  // this component's mount effect. It therefore cannot read the view through a
  // ref; the view is published as state once it exists.
  const [readyView, setReadyView] = useState<EditorView | null>(null);

  // The search panel renders bb-styled controls instead of CodeMirror's own.
  // The target element and the compartment that carries the panel's update
  // listener have to exist before the view is built, because both go into its
  // initial configuration.
  const panelTarget = useRef(
    createSearchPanelTarget(new Compartment()),
  ).current;

  // Callbacks and the prop-driven extension set change every render; the view
  // has to read the newest without being rebuilt, so both live in refs.
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  const goToLineRef = useRef(onGoToLine);
  goToLineRef.current = onGoToLine;

  const propExtensions = useRef<readonly Extension[]>([]);
  propExtensions.current = [
    ...(language === null ? [] : [language]),
    ...(lineWrap ? [EditorView.lineWrapping] : []),
    theme,
    ...(readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []),
  ];

  const staticExtensions = useRef<readonly Extension[]>([]);
  if (staticExtensions.current.length === 0) {
    staticExtensions.current = [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      bracketMatching(),
      indentOnInput(),
      search({ top: true, createPanel: createSearchPanel(panelTarget) }),
      panelTarget.updates.of([]),
      keymap.of([
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            saveRef.current();
            return true;
          },
        },
        indentWithTab,
        // Ahead of `searchKeymap` so Mod-Alt-g opens the plugin's line field
        // rather than CodeMirror's own dialog, which cannot be styled and would
        // otherwise appear beside the field as a second prompt.
        {
          key: "Mod-Alt-g",
          preventDefault: true,
          run: () => {
            goToLineRef.current();
            return true;
          },
        },
        ...searchKeymap,
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) changeRef.current(update.state.doc.toString());
      }),
    ];
  }

  const appliedDocument = useRef<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [...staticExtensions.current, ...propExtensions.current],
      }),
    });
    viewRef.current = view;
    setReadyView(view);
    appliedDocument.current = documentKey;

    handle.openFind = () => {
      view.focus();
      openSearchPanel(view);
    };
    handle.goToLine = (line) => {
      const total = view.state.doc.lines;
      const position = view.state.doc.line(Math.min(Math.max(Math.trunc(line), 1), total)).from;
      view.dispatch({
        selection: { anchor: position },
        effects: EditorView.scrollIntoView(position, { y: "center" }),
      });
      view.focus();
    };

    return () => {
      viewRef.current = null;
      view.destroy();
    };
    // Mount-only: later props are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A different file: replace the document. Rebuilding the state is what clears
  // the undo history, which would otherwise let Mod-Z walk into the previous
  // file's text.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || appliedDocument.current === documentKey) return;
    appliedDocument.current = documentKey;
    view.setState(
      EditorState.create({
        doc: value,
        extensions: [...staticExtensions.current, ...propExtensions.current],
      }),
    );
  }, [documentKey, value]);

  // Same file, new content (reload, save round-trip): apply as one edit so the
  // caret and scroll position survive.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null || appliedDocument.current !== documentKey) return;
    if (view.state.doc.toString() === value) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
      // Not an edit the user made: without this the reload lands in the undo
      // history, so Ctrl-Z resurrects the pre-reload text, the tab flips dirty,
      // and auto-save writes the stale text back over the freshly read file.
      annotations: Transaction.addToHistory.of(false),
    });
  }, [documentKey, value]);

  // `StateEffect.reconfigure` replaces the ENTIRE root extension set, so the
  // static half has to be re-supplied here — reconfiguring with only the
  // prop-driven half would drop line numbers, history, and the keymaps.
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({
      effects: StateEffect.reconfigure.of([
        ...staticExtensions.current,
        ...propExtensions.current,
      ]),
    });
  }, [language, readOnly, lineWrap, theme]);

  return (
    <>
      <div ref={hostRef} className={className} />
      <SearchPanelPortal target={panelTarget} view={readyView} />
    </>
  );
}
