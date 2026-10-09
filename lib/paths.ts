import path from "node:path";

/**
 * The host a workspace lives on picks the path flavour, not the machine this
 * plugin runs on: a Windows workspace browsed from a Linux server still needs
 * backslashes when the absolute path goes back to BB.
 *
 * Detected by drive letter or UNC prefix, NOT by `win32.isAbsolute` — that
 * returns true for `/work/app` too, which would send every POSIX root down the
 * Windows path.
 */
export function pathApiFor(root: string): path.PlatformPath {
  const isWindows = /^[a-zA-Z]:[\\/]/.test(root) || root.startsWith("\\\\");
  return isWindows ? path.win32 : path.posix;
}

/**
 * Join a workspace-relative path onto its root, refusing anything that would
 * escape it. `rootPath` confinement on BB's side is the real guard; this one
 * keeps a malformed request from ever reaching it.
 *
 * An absolute path is refused rather than folded onto the root: silently
 * turning `/etc/passwd` into `<root>/etc/passwd` answers a request the caller
 * never made, and every caller here passes a path the listing produced.
 */
export function resolveWithinRoot(root: string, relativePath: string): string {
  const api = pathApiFor(root);
  const base = api.normalize(root);
  if (api.isAbsolute(relativePath)) {
    throw new Error(`Path must be workspace-relative: ${relativePath}`);
  }
  // A backslash separates segments only on a Windows host. On POSIX it is a
  // legal character in a file name, so splitting on it would retarget a file
  // literally called `foo\bar.txt`.
  const separator = api === path.win32 ? /[/\\]+/ : /\/+/;
  const relative = relativePath;
  if (relative === "" || relative === ".") return base;

  const segments = relative.split(separator).filter((segment) => segment !== "");
  if (segments.some((segment) => segment === "..")) {
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  }

  const resolved = api.join(base, ...segments);
  const prefix = base.endsWith(api.sep) ? base : `${base}${api.sep}`;
  if (resolved !== base && !resolved.startsWith(prefix)) {
    throw new Error(`Path escapes the workspace: ${relativePath}`);
  }
  return resolved;
}
