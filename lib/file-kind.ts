/** Extension → language, for the editor's syntax mode and the file glyphs. */
const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  bash: "shell",
  c: "cpp",
  cc: "cpp",
  cfg: "ini",
  cjs: "javascript",
  clj: "clojure",
  conf: "ini",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  csv: "plaintext",
  cxx: "cpp",
  dart: "dart",
  diff: "diff",
  dockerfile: "dockerfile",
  env: "ini",
  ex: "elixir",
  exs: "elixir",
  go: "go",
  gradle: "groovy",
  groovy: "groovy",
  h: "cpp",
  hpp: "cpp",
  hs: "haskell",
  htm: "html",
  html: "html",
  ini: "ini",
  java: "java",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  log: "plaintext",
  lua: "lua",
  md: "markdown",
  markdown: "markdown",
  mjs: "javascript",
  mkd: "markdown",
  mm: "cpp",
  patch: "diff",
  php: "php",
  pl: "perl",
  properties: "properties",
  ps1: "powershell",
  py: "python",
  pyi: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  sass: "sass",
  scala: "scala",
  scss: "scss",
  sh: "shell",
  sql: "sql",
  svelte: "html",
  swift: "swift",
  tf: "hcl",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  txt: "plaintext",
  vue: "html",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

export function extensionOf(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "";
  return name.slice(dot + 1).toLowerCase();
}

export function languageForPath(path: string): string {
  return LANGUAGE_BY_EXTENSION[extensionOf(path)] ?? "plaintext";
}

/**
 * The extensions this plugin claims when BB opens a file — every one its editor
 * has a language for. This is what BB's `fileOpener` slot matches a file
 * against, so it stays derived from the same table that drives highlighting: an
 * extension the editor cannot read must never be claimed here.
 *
 * Markdown is included: a reference to a `.md` file in chat is exactly the case
 * that should land in this editor, and the opener renders markdown as a preview
 * by default, with the source one click away. BB still lets a user send any
 * extension back to its own preview under Settings → Files.
 */
export function openableExtensions(): string[] {
  return Object.keys(LANGUAGE_BY_EXTENSION);
}

/** A short label for the editor's status strip. */
export function languageLabel(path: string): string {
  const language = languageForPath(path);
  return language === "plaintext" ? extensionOf(path).toUpperCase() || "Text" : language;
}

/**
 * `.mdx` is deliberately absent: it is JSX wearing markdown's extension, and a
 * CommonMark renderer either prints the components as literal text or drops
 * them — strictly worse than reading the source.
 */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extensionOf(path));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * BB's markdown renderer is its chat message renderer: it parses the whole
 * document and builds the entire element tree in one synchronous pass, with no
 * virtualization. A long README is tens of kilobytes, so a million characters
 * already allows an order of magnitude more than anything written to be read;
 * past it the parse blocks the surface long enough to look like a hang.
 *
 * Counted in characters, not bytes: the parse costs what the text costs, and
 * every caller has the text in hand.
 */
export const MARKDOWN_PREVIEW_MAX_CHARS = 1024 * 1024;

export function canPreviewMarkdown(path: string, text: string): boolean {
  return isMarkdownPath(path) && text.length <= MARKDOWN_PREVIEW_MAX_CHARS;
}

/** What the pane shows: rendered markdown, the source viewer, or the editor. */
export type FileViewMode = "preview" | "read" | "edit";

/**
 * The mode a tab may hold, given the one asked for. `text` is what the tab
 * would render — the draft over the file — or null when it has no text: not
 * read yet, an image, a binary. Preview is the only mode with a precondition,
 * and a tab that fails it shows the source instead.
 */
export function allowedMode(
  requested: FileViewMode,
  path: string,
  text: string | null,
): FileViewMode {
  if (requested !== "preview") return requested;
  return text !== null && canPreviewMarkdown(path, text) ? "preview" : "read";
}
