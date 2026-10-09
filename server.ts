import path from "node:path";
import { readFile, readdir, stat } from "node:fs/promises";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { resolveWithinRoot } from "./lib/paths.js";
import { CHANGED_CHANNEL } from "./lib/channels.js";
import { utf8Head } from "./lib/text.js";
import { dirnameOf, normalizeRelative } from "./lib/relpath.js";
import { mentionId, parseMentionId } from "./lib/mention.js";
import type { FlatEntry } from "./lib/tree.js";
import { extensionOf } from "./lib/file-kind.js";
import {
  compileSearch,
  findLineMatches,
  type SearchMatch,
  type SearchOptions,
} from "./lib/search.js";

/** BB's own recursive listing is capped at 10k; a local walk gets more room. */
const LOCAL_ENTRY_LIMIT = 40_000;
const REMOTE_ENTRY_LIMIT = 10_000;

/** Text past this is shown read-only — an editor stops being usable long before. */
const MAX_EDITABLE_BYTES = 4 * 1024 * 1024;

/** Inline images round-trip as base64 through RPC, so keep them modest. */
const MAX_INLINE_IMAGE_BYTES = 2 * 1024 * 1024;

/** How many files a mention search returns to the composer. */
const MENTION_SEARCH_LIMIT = 20;

/**
 * The most `bb finder read` prints. BB rejects a plugin command's output past
 * 1 MiB outright, so the command stays well under that and truncates instead of
 * failing.
 */
const CLI_READ_MAX_BYTES = 512 * 1024;

/**
 * Content search budget. A workspace can hold tens of thousands of files, so
 * the scan is bounded three ways — files inspected, matches returned, and the
 * size of any single file — and reports when it stopped early. Reading whole
 * files past this size would cost more than the result is worth.
 */
const SEARCH_MAX_FILES = 2_000;
const SEARCH_MAX_MATCHES = 500;
const SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024;
/**
 * How many files are read at once. A local workspace reads through node:fs, so
 * a scan is bound by disk latency rather than CPU; a remote one goes over the
 * host bridge, where an unbounded fan-out would queue requests the host is also
 * serving for the tree and the editor.
 */
const SEARCH_READ_CONCURRENCY = 8;

/** Extensions that are never text, so a binary file is never decoded. */
const SEARCH_SKIPPED_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "avif", "tiff",
  "pdf", "zip", "gz", "tgz", "bz2", "xz", "7z", "rar", "jar", "war",
  "exe", "dll", "so", "dylib", "bin", "class", "o", "a", "wasm",
  "woff", "woff2", "ttf", "otf", "eot",
  "mp3", "mp4", "mov", "avi", "mkv", "wav", "ogg", "webm",
  "sqlite", "db", "pyc",
  // A `.docx` is a ZIP of XML parts. Decoding one as UTF-8 yields readable
  // fragments of `word/document.xml`, so a search would report matches inside a
  // Word file it cannot actually read.
  "docx", "xlsx", "pptx", "odt", "ods", "odp",
]);

const scopeSchema = z
  .object({
    kind: z.enum(["thread", "environment", "project"]),
    id: z.string().min(1),
  })
  .strict();

type Scope = z.infer<typeof scopeSchema>;

const workspaceSchema = z.object({
  ref: scopeSchema,
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  kind: z.enum(["project", "environment"]),
});

const entrySchema = z.object({
  path: z.string(),
  kind: z.enum(["file", "directory"]),
});

const resolvedScopeSchema = z.object({
  root: z.string(),
  hostId: z.string(),
  hostName: z.string(),
  isLocal: z.boolean(),
  label: z.string(),
  sublabel: z.string(),
  projectId: z.string(),
  environmentId: z.string().nullable(),
  ref: scopeSchema,
});

const readResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    content: z.string(),
    sha256: z.string(),
    sizeBytes: z.number(),
    absolutePath: z.string(),
    editable: z.boolean(),
  }),
  z.object({
    kind: z.literal("image"),
    dataUrl: z.string(),
    sizeBytes: z.number(),
    absolutePath: z.string(),
  }),
  z.object({
    kind: z.literal("binary"),
    sizeBytes: z.number(),
    absolutePath: z.string(),
    reason: z.string(),
  }),
]);

/** What `read` returns: the file as text, as an inline image, or as neither. */
export type ReadResult = z.infer<typeof readResultSchema>;

export type ResolvedScope = z.infer<typeof resolvedScopeSchema>;
export type WorkspaceOption = z.infer<typeof workspaceSchema>;

export const rpcContract = defineRpcContract({
  workspaces: {
    input: z.null(),
    output: z.object({
      workspaces: z.array(workspaceSchema),
      defaultRef: scopeSchema.nullable(),
    }),
  },
  tree: {
    input: z.object({ scope: scopeSchema, includeHidden: z.boolean() }).strict(),
    output: z.object({
      scope: resolvedScopeSchema,
      entries: z.array(entrySchema),
      truncated: z.boolean(),
      listing: z.enum(["local", "remote"]),
    }),
  },
  read: {
    input: z.object({ scope: scopeSchema, path: z.string().min(1) }).strict(),
    output: readResultSchema,
  },
  write: {
    input: z
      .object({
        scope: scopeSchema,
        path: z.string().min(1),
        content: z.string(),
        /**
         * The hash the edit was based on, guarding against an agent having
         * written the file in the meantime. Omit to overwrite regardless.
         * (`null` is deliberately not accepted: BB reads it as create-only,
         * which would conflict on every existing file.)
         */
        expectedSha256: z.string().optional(),
      })
      .strict(),
    output: z.discriminatedUnion("outcome", [
      z.object({
        outcome: z.literal("written"),
        sha256: z.string(),
        sizeBytes: z.number(),
      }),
      z.object({
        outcome: z.literal("conflict"),
        currentSha256: z.string().nullable(),
      }),
    ]),
  },
  create: {
    input: z
      .object({
        scope: scopeSchema,
        /** Directory the new entry goes in; "" is the workspace root. */
        directory: z.string(),
        name: z.string().min(1).max(255),
        kind: z.enum(["file", "directory"]),
      })
      .strict(),
    output: z.object({ path: z.string() }),
  },
  rename: {
    input: z
      .object({
        scope: scopeSchema,
        path: z.string().min(1),
        name: z.string().min(1).max(255),
      })
      .strict(),
    output: z.object({ path: z.string() }),
  },
  remove: {
    input: z
      .object({
        scope: scopeSchema,
        path: z.string().min(1),
        recursive: z.boolean(),
      })
      .strict(),
    output: z.object({ ok: z.literal(true) }),
  },
  search: {
    input: z
      .object({
        scope: scopeSchema,
        query: z.string().min(1).max(500),
        includeHidden: z.boolean(),
        caseSensitive: z.boolean(),
        regexp: z.boolean(),
        wholeWord: z.boolean(),
        /** Directory to search under; "" is the workspace root. */
        directory: z.string(),
      })
      .strict(),
    output: z.object({
      matches: z.array(
        z.object({
          path: z.string(),
          line: z.number(),
          column: z.number(),
          text: z.string(),
          matchStart: z.number(),
          matchEnd: z.number(),
        }),
      ),
      /** True when the scan stopped at its budget; the results are partial. */
      truncated: z.boolean(),
      filesScanned: z.number(),
      invalidPattern: z.string().nullable(),
    }),
  },
  upload: {
    input: z
      .object({
        scope: scopeSchema,
        directory: z.string(),
        files: z.array(
          z.object({
            name: z.string().min(1).max(255),
            contentBase64: z.string(),
          }),
        ),
      })
      .strict(),
    output: z.object({ written: z.array(z.string()) }),
  },
});

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    excludedDirectories: {
      type: "string",
      label: "Excluded directory names (one per line)",
      experimental_multiline: true,
      default: "node_modules\n.git\nvendor\ntarget\n.venv",
    },
  });

  async function excludedNames(): Promise<Set<string>> {
    const { excludedDirectories } = await settings.get();
    const names = excludedDirectories
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.includes("/"));
    return new Set(names);
  }

  let cachedLocalHostId: string | null = null;

  /**
   * The mention menu's cached listing per workspace, and how long it lives.
   * `search` runs on every keystroke, so one walk of the workspace serves a
   * burst of them; a write drops the entry through `publishChanged`.
   */
  const mentionListings = new Map<string, { at: number; entries: FlatEntry[] }>();
  const MENTION_LISTING_TTL_MS = 10_000;

  /**
   * Announce a workspace change: forget what the mention menu knew about that
   * workspace, so it cannot offer a file that just moved, then signal every
   * open tree over realtime.
   */
  function publishChanged(
    scope: Scope,
    path: string,
    extra?: { from?: string; sha256?: string },
  ): void {
    mentionListings.delete(`${scope.kind}:${scope.id}`);
    bb.realtime.publish(CHANGED_CHANNEL, { scope, path, ...extra });
  }

  /**
   * The daemon running on THIS machine, read from the id file BB's own
   * primary-host resolution trusts first.
   *
   * `system.config().primaryHostId` is deliberately not used as a locality
   * test: when the data directory has no id file BB falls back to "the only
   * connected host", which on a headless server is somebody else's laptop.
   * Walking that host's paths with node:fs would read the server's disk and
   * quietly serve the wrong machine's files.
   */
  async function localHostId(): Promise<string | null> {
    if (cachedLocalHostId !== null) return cachedLocalHostId;
    const { dataDir } = await bb.sdk.system.config();
    try {
      const value = (await readFile(path.join(dataDir, "host-id"), "utf8")).trim();
      if (value !== "") cachedLocalHostId = value;
      return cachedLocalHostId;
    } catch {
      return null;
    }
  }

  async function hostName(hostId: string): Promise<string> {
    try {
      return (await bb.sdk.hosts.get({ hostId })).name;
    } catch {
      return "this machine";
    }
  }

  /**
   * `projects.get` serves standard projects only — asking it for the singleton
   * personal project is a 404 — so fall back to the list that can include it.
   */
  async function projectById(projectId: string) {
    try {
      return await bb.sdk.projects.get({ projectId });
    } catch {
      const projects = await bb.sdk.projects.list({ includePersonal: true });
      return projects.find((entry) => entry.id === projectId) ?? null;
    }
  }

  /** Turn whatever the caller pointed at into one browsable directory. */
  async function resolveScope(
    scope: Scope,
  ): Promise<{ ok: true; scope: ResolvedScope } | { ok: false; reason: string }> {
    let environmentId: string | null = null;
    let projectId: string | null = null;

    if (scope.kind === "thread") {
      const thread = await bb.sdk.threads.get({ threadId: scope.id });
      environmentId = thread.environmentId;
      projectId = thread.projectId;
    } else if (scope.kind === "environment") {
      environmentId = scope.id;
    } else {
      projectId = scope.id;
    }

    const local = await localHostId();

    if (environmentId !== null) {
      const environment = await bb.sdk.environments.get({ environmentId });
      if (environment.path !== null) {
        const owner = await projectById(environment.projectId);
        return {
          ok: true,
          scope: {
            root: environment.path,
            hostId: environment.hostId,
            hostName: await hostName(environment.hostId),
            isLocal: environment.hostId === local,
            label: owner?.name ?? "Workspace",
            sublabel:
              environment.branchName ??
              environment.name ??
              (environment.isWorktree ? "worktree" : "workspace"),
            projectId: environment.projectId,
            environmentId,
            ref: scope,
          },
        };
      }
      // A provisioning or torn-down environment has no directory yet. Fall
      // through to the project checkout so the panel still shows something.
      if (projectId === null) projectId = environment.projectId;
    }

    if (projectId === null) {
      return { ok: false, reason: "This thread has no workspace yet." };
    }

    const found = await projectById(projectId);
    if (found === null) return { ok: false, reason: "That project no longer exists." };

    const source =
      found.sources.find((entry) => entry.isDefault) ?? found.sources[0];
    if (source === undefined) {
      return { ok: false, reason: `${found.name} has no checkout on any machine yet.` };
    }

    return {
      ok: true,
      scope: {
        root: source.path,
        hostId: source.hostId,
        hostName: await hostName(source.hostId),
        isLocal: source.hostId === local,
        label: found.name,
        sublabel: "project checkout",
        projectId,
        environmentId: null,
        ref: scope,
      },
    };
  }

  /**
   * A recursive listing of a directory on this machine. BB's own `listPaths`
   * silently drops the dependency directories it excludes, and a local walk is
   * both faster and able to honour the plugin's own exclusion list. Breadth
   * first, so a workspace larger than the cap keeps its shallow part.
   */
  async function walkLocal(
    root: string,
    includeHidden: boolean,
    excluded: ReadonlySet<string>,
  ): Promise<{ entries: FlatEntry[]; truncated: boolean }> {
    const entries: FlatEntry[] = [];
    let truncated = false;
    const queue: Array<{ absolute: string; prefix: string }> = [
      { absolute: root, prefix: "" },
    ];
    // A cursor rather than `shift()`: the queue holds one entry per directory,
    // and shifting a 20k-entry array is quadratic.
    let head = 0;

    while (head < queue.length) {
      const current = queue[head];
      head += 1;
      if (current === undefined) break;
      let dirents;
      try {
        dirents = await readdir(current.absolute, { withFileTypes: true });
      } catch (error) {
        // The root failing is fatal — a workspace deleted underneath BB must
        // not be reported as an empty one. A subdirectory failing is not: the
        // rest of the tree is still worth returning.
        if (current.prefix === "") throw error;
        bb.log.warn(
          `skipped ${current.absolute}: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }

      for (const dirent of dirents) {
        const name = dirent.name;
        if (excluded.has(name)) continue;
        if (!includeHidden && name.startsWith(".")) continue;
        if (dirent.isSymbolicLink()) continue;
        const relative = current.prefix === "" ? name : `${current.prefix}/${name}`;
        if (dirent.isDirectory()) {
          if (entries.length >= LOCAL_ENTRY_LIMIT) {
            truncated = true;
            return { entries, truncated };
          }
          entries.push({ path: relative, kind: "directory" });
          queue.push({ absolute: path.join(current.absolute, name), prefix: relative });
        } else if (dirent.isFile()) {
          if (entries.length >= LOCAL_ENTRY_LIMIT) {
            truncated = true;
            return { entries, truncated };
          }
          entries.push({ path: relative, kind: "file" });
        }
      }
    }
    return { entries, truncated };
  }

  async function listEntries(
    scope: ResolvedScope,
    includeHidden: boolean,
  ): Promise<{ entries: FlatEntry[]; truncated: boolean; listing: "local" | "remote" }> {
    const excluded = await excludedNames();
    if (scope.isLocal) {
      try {
        const walked = await walkLocal(scope.root, includeHidden, excluded);
        return { ...walked, listing: "local" };
      } catch (error) {
        bb.log.warn(
          `local walk of ${scope.root} failed (${error instanceof Error ? error.message : String(error)}); falling back to BB's listing`,
        );
      }
    }

    const result = await bb.sdk.files.listPaths({
      hostId: scope.hostId,
      path: scope.root,
      includeFiles: true,
      includeDirectories: true,
      includeHidden,
      limit: REMOTE_ENTRY_LIMIT,
    });
    return {
      entries: result.paths
        .map((entry) => ({ path: entry.path, kind: entry.kind }))
        .filter((entry) =>
          normalizeRelative(entry.path)
            .split("/")
            .every((segment) => !excluded.has(segment)),
        ),
      truncated: result.truncated,
      listing: "remote",
    };
  }

  async function requireScope(scope: Scope): Promise<ResolvedScope> {
    const resolved = await resolveScope(scope);
    if (!resolved.ok) throw new Error(resolved.reason);
    return resolved.scope;
  }

  bb.rpc.register(rpcContract, {
    async workspaces() {
      const projects = await bb.sdk.projects.list({
        include: "threads",
        includePersonal: true,
      });
      const workspaces: WorkspaceOption[] = [];
      for (const project of projects) {
        if (project.sources.length > 0) {
          workspaces.push({
            ref: { kind: "project", id: project.id },
            label: project.name,
            sublabel: project.kind === "personal" ? "personal files" : "project checkout",
            projectId: project.id,
            kind: "project",
          });
        }
        const threads = "threads" in project ? project.threads : [];
        const seen = new Set<string>();
        for (const thread of threads) {
          const environmentId = thread.environmentId;
          if (environmentId === null || seen.has(environmentId)) continue;
          if (thread.archivedAt !== null || thread.deletedAt !== null) continue;
          if (thread.environmentWorkspaceDisplayKind === "other") continue;
          seen.add(environmentId);
          workspaces.push({
            ref: { kind: "environment", id: environmentId },
            label: project.name,
            sublabel: thread.environmentBranchName ?? thread.environmentName ?? "worktree",
            projectId: project.id,
            kind: "environment",
          });
        }
      }
      return { workspaces, defaultRef: workspaces[0]?.ref ?? null };
    },

    async tree({ scope, includeHidden }) {
      const resolved = await requireScope(scope);
      const listed = await listEntries(resolved, includeHidden);
      return {
        scope: resolved,
        entries: listed.entries,
        truncated: listed.truncated,
        listing: listed.listing,
      };
    },

    async read({ scope, path: relativePath }) {
      const resolved = await requireScope(scope);
      const absolutePath = resolveWithinRoot(resolved.root, relativePath);
      const file = await bb.sdk.files.read({
        hostId: resolved.hostId,
        path: absolutePath,
        rootPath: resolved.root,
      });

      if (file.contentEncoding === "utf8") {
        return {
          kind: "text" as const,
          content: file.content,
          sha256: file.sha256,
          sizeBytes: file.sizeBytes,
          absolutePath,
          editable: file.sizeBytes <= MAX_EDITABLE_BYTES,
        };
      }

      const mimeType = file.mimeType;
      if (mimeType !== undefined && mimeType.startsWith("image/")) {
        if (file.sizeBytes > MAX_INLINE_IMAGE_BYTES) {
          return {
            kind: "binary" as const,
            sizeBytes: file.sizeBytes,
            absolutePath,
            reason: "This image is too large to preview here.",
          };
        }
        return {
          kind: "image" as const,
          dataUrl: `data:${mimeType};base64,${file.content}`,
          sizeBytes: file.sizeBytes,
          absolutePath,
        };
      }

      return {
        kind: "binary" as const,
        sizeBytes: file.sizeBytes,
        absolutePath,
        reason: "This file is not text.",
      };
    },

    async write({ scope, path: relativePath, content, expectedSha256 }) {
      const resolved = await requireScope(scope);
      const absolutePath = resolveWithinRoot(resolved.root, relativePath);
      const result = await bb.sdk.files.write({
        hostId: resolved.hostId,
        path: absolutePath,
        rootPath: resolved.root,
        content,
        contentEncoding: "utf8",
        ...(expectedSha256 === undefined ? {} : { expectedSha256 }),
      });

      if (result.outcome !== "written") {
        return { outcome: "conflict" as const, currentSha256: result.currentSha256 };
      }
      publishChanged(scope, normalizeRelative(relativePath), { sha256: result.sha256 });
      return {
        outcome: "written" as const,
        sha256: result.sha256,
        sizeBytes: result.sizeBytes,
      };
    },

    async create({ scope, directory, name, kind }) {
      const resolved = await requireScope(scope);
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error("A name cannot contain a path separator.");
      }
      const relativePath = normalizeRelative(
        directory === "" ? name : `${directory}/${name}`,
      );
      const absolutePath = resolveWithinRoot(resolved.root, relativePath);

      if (kind === "directory") {
        // Non-recursive: the directory being created in already exists, so a
        // name that is taken fails instead of silently reporting success the
        // way a recursive mkdir does.
        await bb.sdk.files.mkdir({
          hostId: resolved.hostId,
          path: absolutePath,
          rootPath: resolved.root,
          recursive: false,
        });
      } else {
        const result = await bb.sdk.files.write({
          hostId: resolved.hostId,
          path: absolutePath,
          rootPath: resolved.root,
          content: "",
          contentEncoding: "utf8",
          // Create-only: never clobber a file that appeared since the listing.
          expectedSha256: null,
          createParents: true,
        });
        if (result.outcome !== "written") {
          throw new Error(`${relativePath} already exists.`);
        }
      }
      publishChanged(scope, relativePath);
      return { path: relativePath };
    },

    async rename({ scope, path: relativePath, name }) {
      const resolved = await requireScope(scope);
      if (name.includes("/") || name.includes("\\") || name === "." || name === "..") {
        throw new Error("A name cannot contain a path separator.");
      }
      const sourcePath = resolveWithinRoot(resolved.root, relativePath);
      const parent = dirnameOf(relativePath);
      const destination = parent === "" ? name : `${parent}/${name}`;
      const destinationPath = resolveWithinRoot(resolved.root, destination);
      if (sourcePath === destinationPath) return { path: destination };

      await bb.sdk.files.move({
        hostId: resolved.hostId,
        sourcePath,
        destinationPath,
        rootPath: resolved.root,
      });
      publishChanged(scope, destination, { from: normalizeRelative(relativePath) });
      return { path: destination };
    },

    async remove({ scope, path: relativePath, recursive }) {
      const resolved = await requireScope(scope);
      if (normalizeRelative(relativePath) === "") {
        throw new Error("Refusing to remove the workspace root.");
      }
      const absolutePath = resolveWithinRoot(resolved.root, relativePath);
      await bb.sdk.files.remove({
        hostId: resolved.hostId,
        path: absolutePath,
        rootPath: resolved.root,
        recursive,
      });
      publishChanged(scope, normalizeRelative(relativePath));
      return { ok: true as const };
    },

    /**
     * Search file contents across a workspace or one directory inside it.
     *
     * The listing comes from the same walk the tree uses, so the search honours
     * the workspace's exclusion list and its dotfile setting rather than
     * inventing a second idea of what belongs to a workspace.
     */
    async search({
      scope,
      query,
      includeHidden,
      caseSensitive,
      regexp,
      wholeWord,
      directory,
    }) {
      const resolved = await requireScope(scope);
      const options: SearchOptions = { caseSensitive, regexp, wholeWord };
      const compiled = compileSearch(query, options);
      if (!compiled.ok) {
        return {
          matches: [],
          truncated: false,
          filesScanned: 0,
          invalidPattern: compiled.reason,
        };
      }

      const listed = await listEntries(resolved, includeHidden);
      const prefix = normalizeRelative(directory);
      const candidates = listed.entries
        .filter((entry) => entry.kind === "file")
        .filter((entry) => prefix === "" || entry.path.startsWith(`${prefix}/`))
        .filter((entry) => !SEARCH_SKIPPED_EXTENSIONS.has(extensionOf(entry.path)));

      const budgeted = candidates.slice(0, SEARCH_MAX_FILES);
      // The listing itself may already have been cut short, and so may the file
      // budget; either way the caller is told the results are partial.
      let truncated = listed.truncated || budgeted.length < candidates.length;

      const matches: Array<SearchMatch & { path: string }> = [];
      let filesScanned = 0;
      let cursor = 0;

      /** One file's text, or null when it is binary, oversized, or unreadable. */
      const textOf = async (relativePath: string): Promise<string | null> => {
        try {
          const absolutePath = resolveWithinRoot(resolved.root, relativePath);
          if (resolved.isLocal) {
            // Stat before reading. Reading a multi-gigabyte file whole only to
            // discover it is over the limit would cost the scan more than the
            // file is worth, and the limit exists to bound exactly that.
            const stats = await stat(absolutePath);
            if (stats.size > SEARCH_MAX_FILE_BYTES) return null;
            return (await readFile(absolutePath)).toString("utf8");
          }
          const file = await bb.sdk.files.read({
            hostId: resolved.hostId,
            path: absolutePath,
            rootPath: resolved.root,
          });
          return file.contentEncoding === "utf8" && file.sizeBytes <= SEARCH_MAX_FILE_BYTES
            ? file.content
            : null;
        } catch {
          // A file that vanished between the listing and the read, or one the
          // host refuses, is not an error worth failing the whole search for.
          return null;
        }
      };

      // Workers pull from one shared cursor so the caps stay exact no matter how
      // the reads interleave, and results are collected per file rather than
      // pushed as they land — the order stays the scan order.
      const perFile = new Map<string, SearchMatch[]>();
      const worker = async (): Promise<void> => {
        for (;;) {
          const entry = budgeted[cursor];
          cursor += 1;
          if (entry === undefined) return;
          if (matches.length >= SEARCH_MAX_MATCHES) return;
          const text = await textOf(entry.path);
          if (text === null) continue;
          filesScanned += 1;
          // Re-checked after the read: several workers are in flight at once, so
          // the budget left when this file was picked up may be gone by the time
          // its text arrives. Everything from here to the push is synchronous,
          // so the cap cannot be exceeded.
          const remaining = SEARCH_MAX_MATCHES - matches.length;
          if (remaining <= 0) return;
          const found = findLineMatches(text, compiled.pattern, remaining);
          if (found.length === 0) continue;
          perFile.set(entry.path, found);
          for (const match of found) matches.push({ path: entry.path, ...match });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SEARCH_READ_CONCURRENCY, budgeted.length) }, worker),
      );
      // The workers stop at the match cap, so reaching it means the scan did not
      // finish — there may be more matches further down the list.
      if (matches.length >= SEARCH_MAX_MATCHES) truncated = true;

      return {
        // Reading is concurrent, so matches arrive out of scan order; the order
        // is restored here by walking the budgeted list once more.
        matches: budgeted.flatMap((entry) =>
          (perFile.get(entry.path) ?? []).map((match) => ({ path: entry.path, ...match })),
        ),
        truncated,
        filesScanned,
        invalidPattern: null,
      };
    },

    async upload({ scope, directory, files }) {
      const resolved = await requireScope(scope);
      const written: string[] = [];
      for (const file of files) {
        // The same rule `create` applies: a name is a name, not a path. Without
        // it a crafted request could nest directories the caller never chose.
        if (file.name.includes("/") || file.name.includes("\\")) {
          throw new Error(`${file.name} is not a valid file name.`);
        }
        const relativePath = normalizeRelative(
          directory === "" ? file.name : `${directory}/${file.name}`,
        );
        const absolutePath = resolveWithinRoot(resolved.root, relativePath);
        const result = await bb.sdk.files.write({
          hostId: resolved.hostId,
          path: absolutePath,
          rootPath: resolved.root,
          content: file.contentBase64,
          contentEncoding: "base64",
          createParents: true,
        });
        if (result.outcome === "written") written.push(relativePath);
      }
      publishChanged(scope, directory);
      return { written };
    },
  });

  /**
   * `@`-mentions of workspace files in a thread composer. The item id carries
   * the workspace it came from, because resolution runs at send time with no
   * ambient route — the message may be sent long after the tree was listed.
   *
   * The mention menu calls `search` on every keystroke, and each call would
   * otherwise walk the whole workspace. One listing per workspace is reused for
   * a short window instead; a write publishes `CHANGED_CHANNEL`, which drops
   * the cached entry so the menu cannot offer a file that was just deleted.
   */
  async function mentionEntries(scope: Scope, resolved: ResolvedScope): Promise<FlatEntry[]> {
    const key = `${scope.kind}:${scope.id}`;
    const cached = mentionListings.get(key);
    const now = Date.now();
    if (cached !== undefined && now - cached.at < MENTION_LISTING_TTL_MS) return cached.entries;
    const listed = await listEntries(resolved, false);
    mentionListings.set(key, { at: now, entries: listed.entries });
    return listed.entries;
  }

  bb.ui.registerMentionProvider({
    id: "file",
    label: "Finder",
    triggers: ["@"],
    async search({ query, projectId, threadId }) {
      const scope: Scope | null =
        threadId !== null
          ? { kind: "thread", id: threadId }
          : projectId !== null
            ? { kind: "project", id: projectId }
            : null;
      if (scope === null) return [];
      const resolved = await resolveScope(scope);
      if (!resolved.ok) return [];

      const needle = query.trim().toLowerCase();
      const entries = await mentionEntries(scope, resolved.scope);
      return entries
        .filter((entry) => entry.kind === "file")
        .filter((entry) => needle === "" || entry.path.toLowerCase().includes(needle))
        .slice(0, MENTION_SEARCH_LIMIT)
        .map((entry) => ({
          id: mentionId(scope, entry.path),
          title: entry.path,
          subtitle: resolved.scope.label,
          icon: "FileText",
        }));
    },
    async resolve(itemId) {
      const parsed = parseMentionId(itemId);
      if (parsed === null) return { context: `File: ${itemId} (unrecognized reference)` };
      const resolved = await resolveScope(parsed.scope);
      if (!resolved.ok) {
        return { context: `File: ${parsed.path} (${resolved.reason})` };
      }
      try {
        const file = await bb.sdk.files.read({
          hostId: resolved.scope.hostId,
          path: resolveWithinRoot(resolved.scope.root, parsed.path),
          rootPath: resolved.scope.root,
        });
        if (file.contentEncoding !== "utf8") {
          return {
            context: `File: ${parsed.path} (${resolved.scope.root}) — binary, ${file.sizeBytes} bytes, not attached`,
          };
        }
        const truncated = file.sizeBytes > MAX_EDITABLE_BYTES;
        const content = truncated ? file.content.slice(0, MAX_EDITABLE_BYTES) : file.content;
        return {
          context: [
            `File: ${parsed.path}`,
            `Workspace root: ${resolved.scope.root}`,
            ...(truncated ? ["(truncated to the first 4 MB)"] : []),
            "",
            "```",
            content,
            "```",
          ].join("\n"),
        };
      } catch (error) {
        return {
          context: `File: ${parsed.path} (could not be read: ${error instanceof Error ? error.message : String(error)})`,
        };
      }
    },
  });

  bb.cli.register({
    name: "finder",
    summary: "Browse the files of a thread's workspace",
    commands: [
      { name: "tree", summary: "List the workspace's files", usage: "bb finder tree [--all] [--limit <n>]" },
      { name: "read", summary: "Print a file relative to the workspace root", usage: "bb finder read <path>" },
      { name: "root", summary: "Print the resolved workspace root and machine", usage: "bb finder root" },
    ],
    async run(argv, ctx) {
      const scope: Scope | null =
        ctx.threadId !== undefined
          ? { kind: "thread", id: ctx.threadId }
          : ctx.projectId !== undefined
            ? { kind: "project", id: ctx.projectId }
            : null;
      if (scope === null) {
        return { exitCode: 1, stderr: "No thread or project in context; run this inside a thread.\n" };
      }
      const resolved = await resolveScope(scope);
      if (!resolved.ok) return { exitCode: 1, stderr: `${resolved.reason}\n` };

      const [command, ...rest] = argv;
      switch (command) {
        case "root":
          return {
            exitCode: 0,
            stdout: `${resolved.scope.root}\nmachine: ${resolved.scope.hostName}\n`,
          };
        case "tree": {
          const limitFlag = rest.findIndex((arg) => arg === "--limit");
          const parsed = limitFlag === -1 ? Number.NaN : Number.parseInt(rest[limitFlag + 1] ?? "", 10);
          const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
          const listed = await listEntries(resolved.scope, rest.includes("--all"));
          const shown = listed.entries.slice(0, limit);
          const lines = shown.map((entry) =>
            entry.kind === "directory" ? `${entry.path}/` : entry.path,
          );
          if (shown.length < listed.entries.length) {
            lines.push(`(showing ${shown.length} of ${listed.entries.length} entries)`);
          }
          return { exitCode: 0, stdout: `${lines.join("\n")}\n` };
        }
        case "read": {
          const relativePath = rest.find((arg) => !arg.startsWith("--"));
          if (relativePath === undefined) break;
          const file = await bb.sdk.files.read({
            hostId: resolved.scope.hostId,
            path: resolveWithinRoot(resolved.scope.root, relativePath),
            rootPath: resolved.scope.root,
          });
          if (file.contentEncoding !== "utf8") {
            return { exitCode: 1, stderr: `${relativePath} is not text.\n` };
          }
          // CLI output is a bounded surface — BB refuses a plugin command whose
          // output exceeds 1 MiB — so a large file prints a head and says so
          // rather than failing the whole command on the host's limit. The head
          // is cut on a UTF-8 boundary: a byte budget is what the host counts,
          // and half a code point would be invalid output.
          const head = utf8Head(file.content, CLI_READ_MAX_BYTES);
          if (head.truncated) {
            return {
              exitCode: 0,
              stdout: `${head.text}\n\n(truncated: showing the first ${head.bytes} bytes of ${file.sizeBytes})\n`,
            };
          }
          return { exitCode: 0, stdout: file.content };
        }
        default:
          break;
      }
      return {
        exitCode: 1,
        stderr: "Usage: bb finder tree [--all] [--limit <n>] | bb finder read <path> | bb finder root\n",
      };
    },
  });

}
