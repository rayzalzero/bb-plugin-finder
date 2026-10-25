/**
 * Split (side-by-side) rows from a unified patch.
 *
 * A unified patch is one column of lines; a side-by-side view needs each change
 * block paired up. Pairing is by position inside a block: the first removed
 * line sits beside the first added line, and a block whose sides differ in
 * length leaves the shorter side blank rather than shifting the rest.
 */

export interface SplitRow {
  kind: "header" | "hunk" | "context" | "change";
  /** Full-width text for header and hunk rows; null for paired rows. */
  text: string | null;
  /** The old side; null on a pure addition. */
  left: string | null;
  /** The new side; null on a pure deletion. */
  right: string | null;
  /** 1-based line number on the old side, when there is one. */
  leftNo: number | null;
  /** 1-based line number on the new side, when there is one. */
  rightNo: number | null;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

interface Numbered {
  text: string;
  no: number;
}

function paired(
  kind: SplitRow["kind"],
  left: Numbered | undefined,
  right: Numbered | undefined,
): SplitRow {
  return {
    kind,
    text: null,
    left: left?.text ?? null,
    right: right?.text ?? null,
    leftNo: left?.no ?? null,
    rightNo: right?.no ?? null,
  };
}

/**
 * `patch` in rows a two-column view can render directly. An empty or binary
 * patch yields no rows, which the viewer reports as "nothing to show".
 */
export function splitPatch(patch: string): SplitRow[] {
  const rows: SplitRow[] = [];
  const lines = patch.split("\n");
  // A patch ends with a newline, so the final split entry is a separator.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  let inHunk = false;
  let leftNo = 0;
  let rightNo = 0;
  let removed: Numbered[] = [];
  let added: Numbered[] = [];

  const flush = (): void => {
    const pairs = Math.max(removed.length, added.length);
    for (let index = 0; index < pairs; index += 1) {
      rows.push(paired("change", removed[index], added[index]));
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    const hunk = HUNK_HEADER.exec(line);
    if (hunk !== null) {
      flush();
      leftNo = Number(hunk[1]);
      rightNo = Number(hunk[2]);
      inHunk = true;
      rows.push({ kind: "hunk", text: line, left: null, right: null, leftNo: null, rightNo: null });
      continue;
    }

    // File-level headers come before the first hunk and after `diff --git`.
    // They name the file the viewer already titles, so they are dropped rather
    // than shown as a row that belongs to neither side.
    if (!inHunk || line.startsWith("diff --git ") || line.startsWith("index ")) {
      inHunk = false;
      if (
        line.startsWith("diff --git ") ||
        line.startsWith("index ") ||
        line.startsWith("--- ") ||
        line.startsWith("+++ ")
      ) {
        continue;
      }
      if (line.trim() === "") continue;
      rows.push({ kind: "header", text: line, left: null, right: null, leftNo: null, rightNo: null });
      continue;
    }

    if (line.startsWith("+")) {
      added.push({ text: line.slice(1), no: rightNo });
      rightNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      removed.push({ text: line.slice(1), no: leftNo });
      leftNo += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      flush();
      const text = line.slice(1);
      rows.push(paired("context", { text, no: leftNo }, { text, no: rightNo }));
      leftNo += 1;
      rightNo += 1;
      continue;
    }
    // `\ No newline at end of file` and any other marker: it belongs to the
    // previous line, so it is not a row of its own.
  }
  flush();
  return rows;
}
