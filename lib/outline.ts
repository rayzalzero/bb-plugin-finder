import { EditorState } from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { languageExtension } from "./editor-language";

/** What a symbol is, which decides its marker colour in the panel. */
export type OutlineKind =
  | "class"
  | "interface"
  | "enum"
  | "type"
  | "namespace"
  | "module"
  | "trait"
  | "impl"
  | "function"
  | "method"
  | "macro"
  | "property"
  | "variable"
  | "constant"
  | "heading"
  | "key"
  | "section"
  | "element"
  | "rule";

export interface OutlineSymbol {
  name: string;
  kind: OutlineKind;
  /** 1-based line of the declaration. */
  line: number;
  /** Nesting among symbols, not raw syntax-tree depth. */
  depth: number;
}

/**
 * An outline is a convenience, not a document: past this many symbols the list
 * stops being a map and starts being the file again.
 */
const MAX_SYMBOLS = 400;

/**
 * Parsing a large file for an outline costs more than the outline is worth, and
 * the parse blocks the surface. The editor's own limit is 4 MB; a symbol list
 * is only useful well below that.
 */
const MAX_OUTLINE_CHARS = 512 * 1024;

/** How long the parser may spend before the outline settles for a partial tree. */
const PARSE_BUDGET_MS = 120;

/**
 * Node names that declare something, with the child nodes that carry the name.
 * The candidates are ordered: one grammar's `Definition` is another's `Name`,
 * and a node whose name lives in a declarator reports it from there.
 */
interface TreeRule {
  kind: OutlineKind;
  name?: readonly string[];
  /** Only count it directly under the top node — a local is not a symbol. */
  topLevel?: boolean;
}

const TREE_RULES: Readonly<Record<string, TreeRule>> = {
  // TypeScript, JavaScript, JSX, and the grammars that borrow them.
  ClassDeclaration: { kind: "class", name: ["VariableDefinition", "Definition", "Identifier", "Name"] },
  InterfaceDeclaration: { kind: "interface", name: ["TypeDefinition", "Definition", "Identifier", "Name"] },
  EnumDeclaration: { kind: "enum", name: ["TypeDefinition", "Definition", "Identifier", "Name"] },
  TypeAliasDeclaration: { kind: "type", name: ["TypeDefinition", "Identifier", "Name"] },
  NamespaceDeclaration: { kind: "namespace", name: ["VariableDefinition", "Identifier", "Name"] },
  FunctionDeclaration: { kind: "function", name: ["VariableDefinition", "Definition", "Identifier", "Name"] },
  // Python, PHP, and C++ all call a free function this; each keeps its name in
  // a different child, and only one of them is ever present.
  FunctionDefinition: {
    kind: "function",
    name: ["VariableName", "Name", "FunctionDeclarator", "Definition", "Identifier"],
  },
  MethodDeclaration: { kind: "method", name: ["PropertyDefinition", "Definition", "Identifier", "Name"] },
  ConstructorDeclaration: { kind: "method", name: ["Definition", "Identifier", "Name"] },
  PropertyDeclaration: { kind: "property", name: ["PropertyDefinition", "VariableDeclarator", "Identifier", "Name"] },
  VariableDeclaration: { kind: "variable", name: ["VariableDefinition", "Definition", "Name"], topLevel: true },
  FieldDeclaration: { kind: "property", name: ["VariableDeclarator", "FieldIdentifier", "Name"] },

  // Python.
  ClassDefinition: { kind: "class", name: ["VariableName", "Name"] },
  AssignStatement: { kind: "variable", name: ["VariableName", "Name"], topLevel: true },

  // Go.
  FunctionDecl: { kind: "function", name: ["DefName"] },
  MethodDecl: { kind: "method", name: ["FieldName"] },
  ConstSpec: { kind: "constant", name: ["DefName"] },
  VarSpec: { kind: "variable", name: ["DefName"] },

  // Rust.
  StructItem: { kind: "class", name: ["TypeIdentifier"] },
  EnumItem: { kind: "enum", name: ["TypeIdentifier"] },
  TraitItem: { kind: "trait", name: ["TypeIdentifier"] },
  FunctionItem: { kind: "function", name: ["BoundIdentifier"] },
  ConstItem: { kind: "constant", name: ["BoundIdentifier"] },
  StaticItem: { kind: "constant", name: ["BoundIdentifier"] },
  TypeItem: { kind: "type", name: ["TypeIdentifier"] },
  ModItem: { kind: "module", name: ["BoundIdentifier"] },
  MacroDefinition: { kind: "macro", name: ["Identifier"] },

  // C and C++.
  StructSpecifier: { kind: "class", name: ["TypeIdentifier", "Identifier"] },
  ClassSpecifier: { kind: "class", name: ["TypeIdentifier", "Identifier"] },
  EnumSpecifier: { kind: "enum", name: ["TypeIdentifier", "Identifier"] },
  NamespaceDefinition: { kind: "namespace", name: ["Identifier", "Name"] },

  // PHP.
  TraitDeclaration: { kind: "trait", name: ["Name", "Identifier"] },
  ConstDeclaration: { kind: "constant", name: ["VariableDeclarator", "Name"] },

  // Java's annotation type has no closer relative.
  AnnotationTypeDeclaration: { kind: "interface", name: ["Identifier", "Definition", "Name"] },

  // CSS.
  KeyframesStatement: { kind: "rule", name: ["KeyframeName"] },
};

/** What `CREATE <target>` declares, by the keyword that follows CREATE. */
const SQL_TARGETS: Readonly<Record<string, OutlineKind>> = {
  TABLE: "class",
  VIEW: "class",
  FUNCTION: "function",
  PROCEDURE: "function",
  TRIGGER: "function",
  INDEX: "key",
  TYPE: "type",
  SCHEMA: "namespace",
  DATABASE: "namespace",
  SEQUENCE: "type",
};

/** The name a rule takes from a child node, before any tidying. */
function childText(node: SyntaxNode, candidates: readonly string[], text: string): string {
  for (const name of candidates) {
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.name === name) return text.slice(child.from, child.to);
    }
  }
  return "";
}

/**
 * Turn a declaration's raw text into a display name: a C++ declarator reports
 * `C::m()`, a PHP const declarator reports `C = 1`, and neither is a name.
 */
function cleanName(raw: string): string {
  let name = raw.trim();
  const call = name.indexOf("(");
  if (call > 0) name = name.slice(0, call);
  const assign = name.indexOf(" =");
  if (assign > 0) name = name.slice(0, assign);
  name = name.trim();
  return name.endsWith(":") ? name.slice(0, -1).trim() : name;
}

/** The text before the first `{`, which is what a CSS rule is called. */
function preludeOf(node: SyntaxNode, text: string): string {
  const body = text.slice(node.from, node.to);
  const brace = body.indexOf("{");
  return (brace === -1 ? body : body.slice(0, brace)).trim();
}

function symbolAt(
  node: SyntaxNode,
  text: string,
  language: string,
): { name: string; kind: OutlineKind } | null {
  if (node.name === "Property" && (language === "json" || language === "json5" || language === "jsonc")) {
    return { name: cleanName(childText(node, ["PropertyName"], text)).replace(/^"|"$/g, ""), kind: "key" };
  }
  if (node.name === "Pair" && language === "yaml") {
    return { name: childText(node, ["Key"], text).trim(), kind: "key" };
  }
  if (node.name === "Element" && (language === "html" || language === "xml")) {
    const tag = childText(node, ["OpenTag"], text).match(/^<\s*([^\s/>]+)/)?.[1] ?? "";
    if (tag === "") return null;
    const id = text.slice(node.from, node.to).match(/\bid\s*=\s*"([^"]*)"/)?.[1];
    return { name: id === undefined ? tag : `${tag}#${id}`, kind: "element" };
  }
  if (node.name === "RuleSet") {
    const selector = preludeOf(node, text);
    return selector === "" ? null : { name: selector, kind: "rule" };
  }
  if (node.name === "MediaStatement") {
    const query = preludeOf(node, text);
    return query === "" ? null : { name: query, kind: "rule" };
  }
  if (node.name === "TypeSpec" && language === "go") {
    const name = cleanName(childText(node, ["DefName"], text));
    if (name === "") return null;
    const kind: OutlineKind =
      node.getChild("StructType") !== null
        ? "class"
        : node.getChild("InterfaceType") !== null
          ? "interface"
          : "type";
    return { name, kind };
  }
  if (node.name === "ImplItem" && language === "rust") {
    // `impl Trait for Type` is about Type; without a `for`, about the trait.
    const types: string[] = [];
    for (let child = node.firstChild; child !== null; child = child.nextSibling) {
      if (child.name === "TypeIdentifier") types.push(text.slice(child.from, child.to));
      if (child.name === "for") types.length = 0;
    }
    const name = types[0];
    return name === undefined ? null : { name, kind: "impl" };
  }
  if (node.name === "Statement" && language === "sql") {
    const words: string[] = [];
    for (let child = node.firstChild; child !== null && words.length < 3; child = child.nextSibling) {
      if (child.name === "Keyword") words.push(text.slice(child.from, child.to).toUpperCase());
    }
    if (words[0] !== "CREATE" && words[0] !== "ALTER") return null;
    const kind = SQL_TARGETS[words[1] ?? ""];
    if (kind === undefined) return null;
    const name = childText(node, ["Identifier"], text);
    return name === "" ? null : { name, kind };
  }

  const rule = TREE_RULES[node.name];
  if (rule === undefined) return null;
  if (rule.topLevel === true && node.parent?.parent !== null) return null;
  const name = cleanName(childText(node, rule.name ?? [], text));
  return name === "" ? null : { name, kind: rule.kind };
}

/** Markdown's outline is its heading tree, so depth comes from the level. */
function collectHeadings(
  top: SyntaxNode,
  text: string,
  lineOf: (position: number) => number,
  symbols: OutlineSymbol[],
): void {
  const levels: number[] = [];
  const visit = (node: SyntaxNode): void => {
    const atx = node.name.match(/^ATXHeading(\d)$/);
    const setext = node.name.match(/^SetextHeading(\d)$/);
    const level = atx === null ? (setext === null ? 0 : Number(setext[1])) : Number(atx[1]);
    if (level > 0 && symbols.length < MAX_SYMBOLS) {
      const raw = text.slice(node.from, node.to);
      const name = raw
        .replace(/^#{1,6}\s*/, "")
        .split("\n")[0]!
        .replace(/^=+\s*$/, "")
        .trim();
      while (levels.length > 0 && levels[levels.length - 1]! >= level) levels.pop();
      symbols.push({ name, kind: "heading", line: lineOf(node.from), depth: levels.length });
      levels.push(level);
      return;
    }
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child);
  };
  visit(top);
}

/**
 * TOML has no nesting in the tree: a section header is a flat `atom` and the
 * keys that follow belong to it until the next one.
 */
function collectToml(
  top: SyntaxNode,
  text: string,
  lineOf: (position: number) => number,
  symbols: OutlineSymbol[],
): void {
  for (let child = top.firstChild; child !== null; child = child.nextSibling) {
    if (symbols.length >= MAX_SYMBOLS) return;
    if (child.name === "atom") {
      const name = text.slice(child.from, child.to).replace(/^\[+|\]+$/g, "");
      symbols.push({ name, kind: "section", line: lineOf(child.from), depth: 0 });
    } else if (child.name === "propertyName") {
      symbols.push({ name: text.slice(child.from, child.to), kind: "key", line: lineOf(child.from), depth: 1 });
    }
  }
}

/**
 * Grammars with no tree — the legacy stream modes — report a keyword token and
 * the name as two flat leaves. A rule names the keyword and where its name
 * sits; the scan walks leaves in order and pairs them.
 */
interface TokenRule {
  keywords: Readonly<Record<string, OutlineKind>>;
  nameNodes: readonly string[];
}

const TOKEN_RULES: Readonly<Record<string, TokenRule>> = {
  ruby: {
    keywords: { def: "method", class: "class", module: "module" },
    nameNodes: ["variableName.definition", "propertyName", "tagName"],
  },
  perl: {
    keywords: { sub: "method", package: "namespace" },
    nameNodes: ["meta", "variableName.definition"],
  },
  powershell: {
    keywords: { function: "function", class: "class" },
    nameNodes: ["variableName"],
  },
  groovy: {
    keywords: { class: "class", interface: "interface", def: "method" },
    nameNodes: ["variableName"],
  },
  vb: {
    keywords: { Class: "class", Module: "module", Interface: "interface", Sub: "method", Function: "method" },
    nameNodes: ["variableName"],
  },
  lua: { keywords: { function: "function" }, nameNodes: ["variableName"] },
  haskell: { keywords: { data: "type", newtype: "type", type: "type" }, nameNodes: ["typeName"] },
  protobuf: {
    keywords: { message: "class", enum: "enum", service: "interface", rpc: "method" },
    nameNodes: ["variableName"],
  },
  clojure: {
    keywords: { defn: "function", def: "variable", defrecord: "class", ns: "namespace" },
    nameNodes: ["variableName"],
  },
};

/** How many leaves after a keyword its name may sit — `def self.name` needs 3. */
const NAME_LOOKAHEAD = 3;

function collectTokens(
  top: SyntaxNode,
  text: string,
  lineOf: (position: number) => number,
  symbols: OutlineSymbol[],
  language: string,
): void {
  const rule = TOKEN_RULES[language];
  const leaves: SyntaxNode[] = [];
  const collect = (node: SyntaxNode): void => {
    const first = node.firstChild;
    if (first === null) {
      leaves.push(node);
      return;
    }
    for (let child: SyntaxNode | null = first; child !== null; child = child.nextSibling) {
      collect(child);
    }
  };
  collect(top);

  for (let index = 0; index < leaves.length && symbols.length < MAX_SYMBOLS; index += 1) {
    const leaf = leaves[index]!;
    const value = text.slice(leaf.from, leaf.to);

    // R names a function on its left: `f <- function(x)`.
    if (language === "r") {
      const next = leaves[index + 1];
      const body = leaves[index + 2];
      if (leaf.name === "variableName" && next?.name === "operator" && text.slice(next.from, next.to) === "<-") {
        if (body?.name === "keyword" && text.slice(body.from, body.to) === "function") {
          symbols.push({ name: value, kind: "function", line: lineOf(leaf.from), depth: 0 });
        }
      }
      continue;
    }

    const kind = rule.keywords[value];
    if (kind === undefined || leaf.name !== "keyword") continue;
    // `End Sub` closes a body; it does not declare one.
    const previous = leaves[index - 1];
    if (previous !== undefined && text.slice(previous.from, previous.to) === "End") continue;

    for (let ahead = 1; ahead <= NAME_LOOKAHEAD; ahead += 1) {
      const candidate = leaves[index + ahead];
      if (candidate === undefined) break;
      if (candidate.name === "keyword") break;
      if (!rule.nameNodes.includes(candidate.name)) continue;
      symbols.push({
        name: text.slice(candidate.from, candidate.to),
        kind,
        line: lineOf(leaf.from),
        depth: 0,
      });
      break;
    }
  }
}

/**
 * The symbol tree of `text`, in document order.
 *
 * Derived from the same grammar the editor highlights with, so the outline and
 * the colouring can never disagree about what a declaration is. A language
 * without a grammar yields nothing rather than a guessed list.
 */
export function outlineOf(text: string, language: string): OutlineSymbol[] {
  if (text.length > MAX_OUTLINE_CHARS) return [];
  const extension = languageExtension(language);
  if (extension === null) return [];

  const state = EditorState.create({ doc: text, extensions: [extension] });
  const tree = ensureSyntaxTree(state, text.length, PARSE_BUDGET_MS) ?? syntaxTree(state);
  const lineOf = (position: number) => state.doc.lineAt(position).number;
  const symbols: OutlineSymbol[] = [];

  if (language === "markdown") {
    collectHeadings(tree.topNode, text, lineOf, symbols);
    return symbols;
  }
  if (language === "toml") {
    collectToml(tree.topNode, text, lineOf, symbols);
    return symbols;
  }
  if (TOKEN_RULES[language] !== undefined || language === "r") {
    collectTokens(tree.topNode, text, lineOf, symbols, language);
    return symbols;
  }

  const walk = (node: SyntaxNode, depth: number): void => {
    if (symbols.length >= MAX_SYMBOLS) return;
    const symbol = symbolAt(node, text, language);
    if (symbol !== null) symbols.push({ ...symbol, depth, line: lineOf(node.from) });
    const nextDepth = symbol === null ? depth : depth + 1;
    for (let child = node.firstChild; child !== null; child = child.nextSibling) walk(child, nextDepth);
  };
  walk(tree.topNode, 0);
  return symbols;
}
