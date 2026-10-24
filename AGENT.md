# AGENT.md — bb-plugin-finder

Instructions for an agent working in this repository. Read this before changing
code, and follow it over generic habits.

## What this project is

A BB plugin (`bb-plugin-finder`, marketplace id **finder**) that browses, edits,
and previews the files of a workspace behind a project, an environment, or a
thread. It registers four frontend surfaces and one CLI command, and reads and
writes files through BB's host-aware file API so a workspace on another machine
behaves like a local one.

## Layout

| Path | Holds |
| --- | --- |
| `server.ts` | The backend: scope resolution (thread → environment → project), the RPC contract, listing, read/write with compare-and-swap, create/rename/remove/upload, content search, the `@`-mention provider, the `bb finder` CLI, and the `excludedDirectories` setting. |
| `app.tsx` | The frontend entry: `navPanel` (the Finder page), `threadPanelAction` (the Finder tab beside a thread), `experimental_threadHeaderAction` (the folder toggle), and `fileOpener` (routes BB file references into `FileOpenerTab`). |
| `components/` | `Workspace` is the shell and layout. `Explorer` is the tree and its context menu. `OutlinePanel` is the symbol tree under it. `FilePane`/`FileView`/`FileOpenerTab` render a file; `CodeEditor` is CodeMirror; `FilePaneChrome` holds the shared toolbar/notice/empty-pane pieces. The `use-*` files are the state hooks. |
| `lib/` | Pure helpers: path arithmetic (`relpath`, `paths`), tree building and filtering (`tree`), content-search matching (`search`), language detection (`file-kind`), the language→CodeMirror extension map (`editor-language`), the theme bridge (`editor-theme`), the outline extractor (`outline`), route parsing (`route`), editor preferences (`prefs`), and per-workspace memory (`workspace-state`). |
| `skills/finder/SKILL.md` | The bundled agent skill: how an agent should call `bb finder` before touching workspace paths. |
| `PLUGIN_OVERVIEW.md` | The marketplace long-form description. The store shows it verbatim, so treat it as a product surface, not as notes. |

## Invariants

Break one of these and the plugin is wrong, however well the code reads.

1. **Every path is workspace-relative and root-confined.** A `..` segment or an
   absolute path is refused before it reaches the host. Only `resolveWithinRoot`
   and the `lib/relpath` helpers do this arithmetic.
2. **Every write carries the `sha256` it was based on.** A save without the
   guard overwrites whatever an agent wrote in the meantime. `expectedSha256:
   null` is not accepted by the contract — BB reads it as create-only.
3. **One workspace identity, never a path, keys remembered state.** State is
   stored under `<kind>:<id>` in `localStorage`, so a thread worktree and its
   project checkout keep separate histories.
4. **The editor's language comes from one table.** `lib/file-kind.ts` maps
   extensions to languages; `lib/editor-language.ts` maps those to CodeMirror
   extensions; `openableExtensions()` derives from the same table. A file the
   editor cannot highlight must never be claimed by the `fileOpener` slot.
5. **The outline and the highlighting read the same syntax tree.** Never
   re-parse with a second parser or a regex — `lib/outline.ts` walks the tree the
   editor already builds.
6. **Realtime signals are scoped.** `CHANGED_CHANNEL` carries the workspace it
   came from, so a write in one workspace never re-lists another.
7. **A host may unmount the panel at any time.** Anything a user would notice
   losing — expanded folders, the file in front, drafts, the outline's height —
   belongs in `lib/prefs.ts` or `lib/workspace-state.ts`, not in React state
   alone.

## Budgets and caps

These exist because the surface would otherwise hang; do not raise one without
measuring the cost.

| Constant | Where | Why |
| --- | --- | --- |
| `LOCAL_ENTRY_LIMIT` / `REMOTE_ENTRY_LIMIT` | `server.ts` | BB's own recursive listing stops at 10k; a local walk gets 40k. The page says when it truncated. |
| `MAX_EDITABLE_BYTES` | `server.ts` | Text past 4 MB opens read-only. |
| `MAX_INLINE_IMAGE_BYTES` | `server.ts` | Inline images round-trip as base64 over RPC. |
| `SEARCH_MAX_FILES` / `SEARCH_MAX_MATCHES` / `SEARCH_MAX_FILE_BYTES` | `server.ts` | A content search is bounded three ways and reports when it stopped early. |
| `CLI_READ_MAX_BYTES` | `server.ts` | BB rejects a plugin command whose output passes 1 MiB. |
| `MARKDOWN_PREVIEW_MAX_CHARS` | `lib/file-kind.ts` | The host markdown renderer parses synchronously with no virtualization. |
| `MAX_OUTLINE_CHARS` / `MAX_SYMBOLS` / `PARSE_BUDGET_MS` | `lib/outline.ts` | An outline must never make typing wait. |

## Commands

```sh
npm install
npm run typecheck      # tsc --noEmit; must be clean before any commit
npm run build          # bb plugin build → dist/
bb plugin install . --yes
bb plugin reload finder
bb plugin dev          # rebuild + reload on save
```

There is no test suite. Verify by running the thing: build, install, then drive
the real surface. `bb finder root|tree|read` exercises the backend without a
browser.

## Verify before yielding

- `npm run typecheck` and `npm run build` both clean.
- The changed surface observed in a real BB window, not just typechecked. For UI
  work that means opening the Finder page (or the thread panel) and exercising
  the exact interaction that changed.
- For anything touching save, read, or listing, also confirm the CLI path still
  answers: `bb finder root`, `bb finder tree`, `bb finder read <path>`.
- A change to a cap, a limit, or a parser budget needs a measurement, not an
  estimate.

## Code style

- TypeScript, strict, no `any` in new code.
- Prefer editing the existing file over adding a new one; the file layout above
  is the convention.
- Comments explain *why* a non-obvious choice is right, never *what* the line
  does. Delete a comment that restates its code.
- No new dependency without a reason the current stack cannot satisfy. The
  CodeMirror packages already cover editing, highlighting, and parsing.
- Delete dead code in the same change that makes it dead. No shims, aliases, or
  re-exports for a caller that no longer exists.

## Release and marketplace

The marketplace entry lives in
[get-bb/marketplace](https://github.com/get-bb/marketplace) at
`entries/finder.json`, and points at this repository through a Git semantic
version range. Users who installed from the marketplace receive an update when
a **new immutable tag** inside that range is pushed; the entry itself does not
need to change for a compatible release.

Full procedure, including the exact commands and the entry fields:
[docs/marketplace-release.md](docs/marketplace-release.md).

The short version:

1. Bump `version` in `package.json` (minor for a feature, patch for a fix).
2. `npm run typecheck && npm run build`.
3. Commit, then `git tag -a vX.Y.Z -m "Release vX.Y.Z"`, then push the branch
   and the tag. Never move or reuse a tag.
4. Only when the entry's own fields change — a new range, a new screenshot, new
   copy, a new icon — open a pull request against the marketplace repository.
5. Update `PLUGIN_OVERVIEW.md` in the same change that changes what the store
   says, and copy it into the marketplace `overview/finder.md`.

## Known limits worth remembering

- A remote workspace listing cannot include dotfiles: BB drops them daemon-side,
  so `.files` only has an effect on the machine running BB.
- `.mdx` is deliberately not claimed by the file opener: it is JSX wearing
  markdown's extension, and a CommonMark renderer either prints the components
  as text or drops them.
- Content search never decodes binary extensions, and skips
  `.docx`/`.xlsx`/`.pptx`, because decoding one as UTF-8 reports matches inside
  a file the plugin cannot actually read.
