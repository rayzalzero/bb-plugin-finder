import { ancestorsOf, normalizeRelative } from "./relpath.js";

export type EntryKind = "file" | "directory";

export interface FlatEntry {
  path: string;
  kind: EntryKind;
}

export interface TreeNode {
  path: string;
  name: string;
  kind: EntryKind;
  children: TreeNode[];
}

/** One rendered line of Finder: a node plus its indentation depth. */
export interface TreeRow {
  node: TreeNode;
  depth: number;
}

/**
 * Fold a flat listing into a tree. Directories implied by a file path are
 * created even when the listing omitted them, so a files-only listing still
 * produces the full shape.
 */
export function buildTree(entries: readonly FlatEntry[]): TreeNode[] {
  const root: TreeNode = { path: "", name: "", kind: "directory", children: [] };
  const byPath = new Map<string, TreeNode>([["", root]]);

  const directoryAt = (path: string): TreeNode => {
    const existing = byPath.get(path);
    if (existing !== undefined) return existing;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = {
      path,
      name: path.slice(separator + 1),
      kind: "directory",
      children: [],
    };
    byPath.set(path, node);
    parent.children.push(node);
    return node;
  };

  for (const entry of entries) {
    const path = normalizeRelative(entry.path);
    if (path === "") continue;
    if (entry.kind === "directory") {
      directoryAt(path);
      continue;
    }
    if (byPath.has(path)) continue;
    const separator = path.lastIndexOf("/");
    const parent = directoryAt(separator === -1 ? "" : path.slice(0, separator));
    const node: TreeNode = {
      path,
      name: path.slice(separator + 1),
      kind: "file",
      children: [],
    };
    byPath.set(path, node);
    parent.children.push(node);
  }

  sortRecursively(root);
  return root.children;
}

function sortRecursively(node: TreeNode): void {
  node.children.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
  });
  for (const child of node.children) sortRecursively(child);
}

/**
 * Flatten the tree into the rows Finder draws, descending only into
 * expanded directories. Collapsed subtrees cost nothing to render, which is
 * what keeps a large workspace responsive without windowing.
 */
export function visibleRows(
  nodes: readonly TreeNode[],
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const visit = (node: TreeNode, depth: number): void => {
    rows.push({ node, depth });
    if (node.kind === "directory" && expanded.has(node.path)) {
      for (const child of node.children) visit(child, depth + 1);
    }
  };
  for (const node of nodes) visit(node, 0);
  return rows;
}

/** Every directory path in the tree — what "collapse all" clears. */
export function allDirectoryPaths(nodes: readonly TreeNode[]): string[] {
  const paths: string[] = [];
  const visit = (node: TreeNode): void => {
    if (node.kind !== "directory") return;
    paths.push(node.path);
    for (const child of node.children) visit(child);
  };
  for (const node of nodes) visit(node);
  return paths;
}

export interface FilteredTree {
  nodes: TreeNode[];
  expand: Set<string>;
}

/** Prune the tree to the files whose path matches `query`. */
export function filterTree(nodes: readonly TreeNode[], query: string): FilteredTree {
  const needle = query.trim().toLowerCase();
  if (needle === "") return { nodes: [...nodes], expand: new Set() };

  const expand = new Set<string>();
  const visit = (node: TreeNode): TreeNode | null => {
    if (node.kind === "file") {
      return node.path.toLowerCase().includes(needle) ? node : null;
    }
    const children = node.children
      .map(visit)
      .filter((child): child is TreeNode => child !== null);
    if (children.length === 0) return null;
    expand.add(node.path);
    return { ...node, children };
  };

  return {
    nodes: nodes.map(visit).filter((node): node is TreeNode => node !== null),
    expand,
  };
}

export { ancestorsOf };
