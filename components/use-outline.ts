import { useEffect, useRef, useState } from "react";
import { outlineOf, type OutlineSymbol } from "@/lib/outline";

/**
 * How long typing settles before the outline is rebuilt. Deriving symbols means
 * parsing the whole document, so doing it per keystroke would spend the typing
 * budget on a panel the user is not looking at.
 */
const OUTLINE_DELAY_MS = 200;

export interface OutlineState {
  symbols: OutlineSymbol[];
  /** True while the text in front has not been parsed yet. */
  pending: boolean;
}

/**
 * The symbol tree of `text`, rebuilt a beat after typing stops.
 *
 * `text` is null when there is nothing to outline — no tab, an image, a binary,
 * or a panel the user closed — and the result is empty without parsing.
 */
export function useOutline(text: string | null, language: string): OutlineState {
  const [state, setState] = useState<OutlineState>({ symbols: [], pending: false });
  // The last document that was parsed, so `pending` can tell "not parsed yet"
  // from "parsed and genuinely empty". The language is part of the key: the
  // same bytes read as TypeScript and as plain text are different outlines.
  const parsed = useRef<string | null>(null);
  const key = text === null ? null : `${language}\u0000${text}`;

  useEffect(() => {
    if (key === null) {
      parsed.current = null;
      setState({ symbols: [], pending: false });
      return;
    }
    if (parsed.current === key) {
      setState((current) => (current.pending ? { ...current, pending: false } : current));
      return;
    }
    setState((current) => (current.pending ? current : { ...current, pending: true }));
    const timer = window.setTimeout(() => {
      parsed.current = key;
      setState({ symbols: outlineOf(text ?? "", language), pending: false });
    }, OUTLINE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [key, language, text]);

  return state;
}
