/**
 * Workspace-relative path arithmetic. Pure string work with forward slashes
 * only, so the same helpers serve the server's filesystem calls and the
 * browser's tree.
 *
 * A backslash is NOT rewritten into a separator. It separates segments only on
 * a Windows host, and the plugin never learns the host's path flavour from the
 * relative string alone; every caller that knows the root normalizes the
 * absolute path with `pathApiFor(root)` instead. Rewriting here would corrupt a
 * POSIX file whose *name* contains a backslash — `bsd/back\slash.txt` would
 * become the two-level path `bsd/back/slash.txt`, and every read of it would
 * fail with ENOENT.
 */

/** Forward slashes, no leading `./`, no trailing separator. */
export function normalizeRelative(input: string): string {
  return input.replace(/^\.?\/+/, "").replace(/\/+$/, "");
}

/** Parent directory of `relativePath`; "" at the workspace root. */
export function dirnameOf(relativePath: string): string {
  const normalized = normalizeRelative(relativePath);
  const separator = normalized.lastIndexOf("/");
  return separator === -1 ? "" : normalized.slice(0, separator);
}

/** Every directory between the workspace root and `relativePath`, outermost first. */
export function ancestorsOf(relativePath: string): string[] {
  const segments = normalizeRelative(relativePath).split("/");
  segments.pop();
  const ancestors: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current === "" ? segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
}
