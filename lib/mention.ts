import type { ScopeRef } from "./route";

/**
 * A mention item id has to survive in a saved composer draft, so it carries the
 * workspace reference and the path together: `<kind>:<id>\u0000<relative path>`.
 * The server's `parseMentionId` reads the same format.
 */
export function mentionId(scope: ScopeRef, path: string): string {
  return `${scope.kind}:${scope.id}\u0000${path}`;
}

export function parseMentionId(itemId: string): { scope: ScopeRef; path: string } | null {
  const separator = itemId.indexOf("\u0000");
  if (separator === -1) return null;
  const reference = itemId.slice(0, separator);
  const path = itemId.slice(separator + 1);
  const colon = reference.indexOf(":");
  if (colon === -1 || path === "") return null;
  const kind = reference.slice(0, colon);
  const id = reference.slice(colon + 1);
  if (kind !== "thread" && kind !== "environment" && kind !== "project") return null;
  if (id === "") return null;
  return { scope: { kind, id }, path };
}
