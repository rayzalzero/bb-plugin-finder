/**
 * Editor preferences that belong to the user rather than to a workspace: they
 * are read by the Finder panel and by BB's own file tab, so both write the
 * same key and changing one changes the other.
 */

export const LINE_WRAP_KEY = "finder:line-wrap";
export const AUTOSAVE_KEY = "finder:autosave";

/** How long typing settles before an auto-save writes. */
export const AUTOSAVE_DELAY_MS = 1200;

export function readPref(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A blocked storage API must not break Finder.
  }
}

export function readPrefFlag(key: string, fallback: boolean): boolean {
  return readPref(key, String(fallback)) === "true";
}
