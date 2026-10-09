Browse, edit, and preview the files of a project, environment, or thread
workspace — the file tree an agent is working in, beside the conversation.

## What you get

- A **Finder** page in the sidebar with the workspace picker, and a
  **Finder** tab beside every thread — toggled by the folder button in
  the thread header (click to open, click again to close) or opened from the
  panel's Actions list.
- A file tree with dotfile toggle, path filter, expand/collapse all, refresh,
  new file, new folder, upload, rename, and delete. Right-click a row for the
  same actions plus copy-path.
- A CodeMirror editor with syntax highlighting in your BB code theme, find in
  file, go to line, multi-cursor, and code folding.
- **Auto-save** (off by default) and a **line-wrap** toggle, both remembered
  between sessions.
- A markdown preview that renders **Mermaid** diagrams, using BB's own message
  renderer, so it looks like the rest of BB.
- Copy the file's contents or its path in one click.
- **Add the file to the prompt**: it becomes an `@` mention whose contents are
  resolved when the message is sent, so the agent reads the file as it is then,
  not as it was when you attached it.

## How it works

The plugin resolves a workspace to a directory and a machine, then reads and
writes through BB's host-aware file API. A workspace on another machine works
the same way. Every save carries the hash the edit was based on, so a change an
agent made underneath you stops the save and offers Reload or Save again instead
of silently overwriting the agent's work.

A write from anywhere — another tab, another device, or the plugin's CLI —
refreshes every open tree over realtime.

## For agents

The bundled skill teaches an agent to resolve the workspace with `bb finder
root` before touching paths, list it with `bb finder tree`, and read a file with
`bb finder read <path>`. That matters because the workspace is not always on the
machine the agent runs on.
