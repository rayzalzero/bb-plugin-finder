export interface Utf8Head {
  text: string;
  /** UTF-8 bytes in `text`, exactly. */
  bytes: number;
  truncated: boolean;
}

/**
 * The longest prefix of `text` that fits in `maxBytes` of UTF-8, cut on a code
 * point boundary.
 *
 * A character budget is not a byte budget: BB bounds a plugin command's output
 * in bytes, so a file of multi-byte characters can pass a 512k-character check
 * and still exceed a 1 MiB byte limit. Code points are walked rather than
 * indices sliced, so a surrogate pair is never cut in half.
 */
export function utf8Head(text: string, maxBytes: number): Utf8Head {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const point = text.codePointAt(index);
    if (point === undefined) break;
    const width = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
    if (bytes + width > maxBytes) break;
    bytes += width;
    // A code point above the BMP occupies two UTF-16 units.
    index += width === 4 ? 2 : 1;
  }
  return { text: text.slice(0, index), bytes, truncated: index < text.length };
}
