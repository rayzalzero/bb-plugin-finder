import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { syntaxHighlighting, HighlightStyle, type TagStyle } from "@codemirror/language";
import { tags as t, type Tag } from "@lezer/highlight";
import type { PluginCodeThemeData } from "@get-bb/plugin-sdk/app";

/**
 * TextMate scopes → Lezer tags. BB's code theme is a VS Code theme document,
 * so the editor's colors have to come from its `tokenColors` rather than from
 * BB's chrome variables — a custom palette would otherwise paint the editor in
 * the wrong syntax colors.
 */
const SCOPE_TAGS: ReadonlyArray<readonly [string, Tag]> = [
  ["comment", t.comment],
  ["string", t.string],
  ["string.regexp", t.regexp],
  ["constant.numeric", t.number],
  ["constant.language", t.bool],
  ["constant", t.constant(t.name)],
  ["variable", t.variableName],
  ["variable.parameter", t.special(t.variableName)],
  ["variable.language", t.self],
  ["keyword", t.keyword],
  ["keyword.control", t.controlKeyword],
  ["keyword.operator", t.operatorKeyword],
  ["storage", t.definitionKeyword],
  ["storage.type", t.typeName],
  ["entity.name.type", t.typeName],
  ["entity.name.class", t.className],
  ["entity.name.function", t.function(t.variableName)],
  ["entity.name.tag", t.tagName],
  ["entity.other.attribute-name", t.attributeName],
  ["support.function", t.function(t.name)],
  ["support.type", t.typeName],
  ["punctuation", t.punctuation],
  ["punctuation.definition", t.definitionOperator],
  ["meta", t.meta],
  ["invalid", t.invalid],
  ["markup.heading", t.heading],
  ["markup.bold", t.strong],
  ["markup.italic", t.emphasis],
  ["markup.underline.link", t.link],
  ["markup.raw", t.monospace],
  ["link", t.link],
  ["operator", t.operator],
  ["namespace", t.namespace],
  ["label", t.labelName],
  ["escape", t.escape],
];

/** `#rgb`/`#rrggbb`/`#rrggbbaa` as CodeMirror's `#rrggbb` or `#rrggbbaa`. */
function normalizeColor(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.startsWith("#") ? value.slice(1) : value;
  if (/^[0-9a-fA-F]{3}$/.test(hex) || /^[0-9a-fA-F]{4}$/.test(hex)) {
    return `#${hex
      .split("")
      .map((digit) => digit + digit)
      .join("")}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex) || /^[0-9a-fA-F]{8}$/.test(hex)) return `#${hex}`;
  return undefined;
}

function colorFor(
  theme: PluginCodeThemeData,
  scopes: readonly string[],
): { color?: string; bold?: boolean; italic?: boolean } | null {
  // Later rules win, the way VS Code resolves overlapping scopes.
  let found: { color?: string; bold?: boolean; italic?: boolean } | null = null;
  for (const rule of theme.tokenColors) {
    const ruleScopes =
      rule.scope === undefined
        ? [""]
        : typeof rule.scope === "string"
          ? rule.scope.split(",").map((scope) => scope.trim())
          : rule.scope;
    if (!ruleScopes.some((ruleScope) => scopes.includes(ruleScope))) continue;
    const color = normalizeColor(rule.settings.foreground);
    const fontStyle = rule.settings.fontStyle ?? "";
    found = {
      ...(color === undefined ? {} : { color }),
      bold: fontStyle.includes("bold"),
      italic: fontStyle.includes("italic"),
    };
  }
  return found;
}

/**
 * CodeMirror sizes itself to its content by default: `.cm-editor` is a flex
 * column with `height: auto`, so inside a bounded host it grows past the host
 * and its own `.cm-scroller` never has anything to scroll. Every editor this
 * plugin mounts lives in a fixed-height pane, so the sizing belongs in the
 * theme rather than in each call site.
 */
const SIZE_RULES = {
  "&": { height: "100%", minHeight: "0" },
  ".cm-scroller": { overflow: "auto" },
} as const;

/**
 * Build the editor's theme from BB's resolved code theme: the workbench colors
 * paint the chrome and the token rules paint the syntax. Everything the theme
 * does not name falls back to the base `vs`/`vs-dark` palette, so a sparse
 * theme still produces a readable editor.
 */
export function editorTheme(theme: PluginCodeThemeData | null, mode: "light" | "dark"): Extension {
  if (theme === null) {
    return EditorView.theme({ ...SIZE_RULES }, { dark: mode === "dark" });
  }

  const background = normalizeColor(theme.colors["editor.background"] ?? theme.bg);
  const foreground = normalizeColor(theme.colors["editor.foreground"] ?? theme.fg);
  const gutter = normalizeColor(
    theme.colors["editorGutter.background"] ?? theme.colors["editor.background"] ?? theme.bg,
  );
  const selection = normalizeColor(theme.colors["editor.selectionBackground"]);
  const lineHighlight = normalizeColor(theme.colors["editor.lineHighlightBackground"]);
  const cursor = normalizeColor(theme.colors["editorCursor.foreground"]);
  const lineNumber = normalizeColor(theme.colors["editorLineNumber.foreground"]);
  const activeLineNumber = normalizeColor(theme.colors["editorLineNumber.activeForeground"]);
  const border = normalizeColor(theme.colors["editorWidget.border"] ?? theme.colors["panel.border"]);

  const rules: TagStyle[] = [];
  for (const [scope, tag] of SCOPE_TAGS) {
    const resolved = colorFor(theme, [scope, scope.split(".")[0] ?? scope]);
    if (resolved === null) continue;
    rules.push({
      tag,
      ...(resolved.color === undefined ? {} : { color: resolved.color }),
      ...(resolved.bold === true ? { fontWeight: "bold" } : {}),
      ...(resolved.italic === true ? { fontStyle: "italic" } : {}),
    });
  }

  const base = colorFor(theme, [""]);
  if (base !== null && base.color !== undefined) {
    rules.push({ tag: t.name, color: base.color });
  }

  return [
    EditorView.theme(
      {
        ...SIZE_RULES,
        "&": {
          ...SIZE_RULES["&"],
          ...(background === undefined ? {} : { backgroundColor: background }),
          ...(foreground === undefined ? {} : { color: foreground }),
        },
        ".cm-scroller": SIZE_RULES[".cm-scroller"],
        ".cm-content": foreground === undefined ? {} : { caretColor: foreground },
        ".cm-cursor, .cm-dropCursor": cursor === undefined ? {} : { borderLeftColor: cursor },
        "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
          selection === undefined ? {} : { backgroundColor: selection },
        ".cm-activeLine": lineHighlight === undefined ? {} : { backgroundColor: lineHighlight },
        ".cm-gutters": {
          ...(gutter === undefined ? {} : { backgroundColor: gutter }),
          ...(lineNumber === undefined ? {} : { color: lineNumber }),
          ...(border === undefined ? {} : { borderRight: `1px solid ${border}` }),
        },
        ".cm-activeLineGutter": {
          ...(gutter === undefined ? {} : { backgroundColor: gutter }),
          ...(activeLineNumber === undefined ? {} : { color: activeLineNumber }),
        },
        ".cm-selectionMatch": { backgroundColor: selection ?? "transparent" },
      },
      { dark: theme.type === "dark" },
    ),
    syntaxHighlighting(HighlightStyle.define(rules)),
  ];
}
