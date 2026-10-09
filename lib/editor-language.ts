import { StreamLanguage } from "@codemirror/language";
import { cpp } from "@codemirror/lang-cpp";
import { css } from "@codemirror/lang-css";
import { go } from "@codemirror/lang-go";
import { html } from "@codemirror/lang-html";
import { java } from "@codemirror/lang-java";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { php } from "@codemirror/lang-php";
import { python } from "@codemirror/lang-python";
import { rust } from "@codemirror/lang-rust";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { clojure } from "@codemirror/legacy-modes/mode/clojure";
import { coffeeScript } from "@codemirror/legacy-modes/mode/coffeescript";
import { diff } from "@codemirror/legacy-modes/mode/diff";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { erlang } from "@codemirror/legacy-modes/mode/erlang";
import { groovy } from "@codemirror/legacy-modes/mode/groovy";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { pascal } from "@codemirror/legacy-modes/mode/pascal";
import { perl } from "@codemirror/legacy-modes/mode/perl";
import { powerShell } from "@codemirror/legacy-modes/mode/powershell";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { protobuf } from "@codemirror/legacy-modes/mode/protobuf";
import { r } from "@codemirror/legacy-modes/mode/r";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { sass } from "@codemirror/legacy-modes/mode/sass";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { vb } from "@codemirror/legacy-modes/mode/vb";
import { verilog } from "@codemirror/legacy-modes/mode/verilog";
import { vhdl } from "@codemirror/legacy-modes/mode/vhdl";
import type { Extension } from "@codemirror/state";

/**
 * Language support by language id, built once at module scope. A StreamLanguage
 * wrapper is a few kilobytes per grammar, so the whole long tail costs less
 * than a single Lezer parser and no grammar is worth deferring behind a
 * dynamic import.
 */
const BY_LANGUAGE: Readonly<Record<string, Extension>> = {
  clojure: StreamLanguage.define(clojure),
  coffeescript: StreamLanguage.define(coffeeScript),
  cpp: cpp(),
  css: css(),
  diff: StreamLanguage.define(diff),
  dockerfile: StreamLanguage.define(dockerFile),
  erlang: StreamLanguage.define(erlang),
  go: go(),
  groovy: StreamLanguage.define(groovy),
  haskell: StreamLanguage.define(haskell),
  html: html(),
  // No dedicated grammar ships here: the closest available parser still beats
  // plain text for brackets, strings, and comments.
  dart: java(),
  elixir: StreamLanguage.define(ruby),
  java: java(),
  javascript: javascript({ jsx: true }),
  json: json(),
  kotlin: java(),
  less: css(),
  lua: StreamLanguage.define(lua),
  markdown: markdown(),
  pascal: StreamLanguage.define(pascal),
  perl: StreamLanguage.define(perl),
  php: php(),
  powershell: StreamLanguage.define(powerShell),
  properties: StreamLanguage.define(properties),
  protobuf: StreamLanguage.define(protobuf),
  python: python(),
  r: StreamLanguage.define(r),
  ruby: StreamLanguage.define(ruby),
  rust: rust(),
  sass: StreamLanguage.define(sass),
  scala: java(),
  scss: css(),
  shell: StreamLanguage.define(shell),
  sql: sql(),
  swift: StreamLanguage.define(swift),
  toml: StreamLanguage.define(toml),
  typescript: javascript({ jsx: true, typescript: true }),
  vb: StreamLanguage.define(vb),
  verilog: StreamLanguage.define(verilog),
  vhdl: StreamLanguage.define(vhdl),
  xml: xml(),
  yaml: yaml(),
};

/** The language extension for `language`, or null for plain text. */
export function languageExtension(language: string): Extension | null {
  return BY_LANGUAGE[language] ?? null;
}
