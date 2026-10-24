# Releasing to the BB marketplace

The plugin is listed in [get-bb/marketplace](https://github.com/get-bb/marketplace)
as the community entry `finder`. This file records how a release reaches a user
who installed it from the marketplace, and the exact steps to take.

## How updates reach a user

The entry's `source` is a Git semantic-version range:

```json
"source": {
  "git": {
    "url": "https://github.com/rayzalzero/bb-plugin-finder.git",
    "range": "^0.2.0"
  }
}
```

BB resolves that range against the repository's **release tags**. Consequences:

- A new tag `vX.Y.Z` inside the range is picked up **without a new marketplace
  pull request**. The registry is re-read, the newest compatible tag wins, and
  a user's next `bb plugin update finder` installs it.
- A tag outside the range (for example `1.0.0` while the range is `^0.2.0`) is
  invisible until the entry's range is widened by a pull request.
- A tag is immutable by convention. Never move, delete, or reuse one: a moved
  tag makes two different builds answer to the same version, and BB caches
  installs by version.
- An exact `ref` instead of a `range` pins the plugin forever. This project uses
  a range on purpose.

The marketplace repository itself is only touched when something the entry
*says* changes: source URL or range, display name, description, category, tags,
icon, screenshots, overview text, or the author account.

## Cutting a release

Run from the plugin repository root.

```sh
# 1. Version bump: minor for a feature, patch for a fix.
#    Edit "version" in package.json.

# 2. Prove it builds and typechecks.
npm run typecheck
npm run build

# 3. Smoke the changed surface in a real BB window (see AGENT.md).

# 4. Commit. The message says what a user gets, not which file moved.
git add -A
git commit -m "Add a resizable symbol outline"

# 5. Tag the release commit. Annotated, and never moved afterwards.
git tag -a v0.2.0 -m "Release v0.2.0"

# 6. Publish.
git push origin HEAD
git push origin v0.2.0

# 7. Confirm the public tag resolves.
git ls-remote --tags https://github.com/rayzalzero/bb-plugin-finder.git
```

The tag name is `vX.Y.Z` with no prefix: the repository holds one plugin at its
root, so the marketplace entry needs no `tagPrefix` and no `subdir`.

Verify the release is installable the way a user gets it:

```sh
bb plugin install git:https://github.com/rayzalzero/bb-plugin-finder.git@semver:^0.2.0 --yes
bb plugin list | grep -A3 finder
```

## Updating the marketplace entry

Only when an entry field changes. Clone a fork, branch from upstream `main`, and
touch nothing but the entry, its icon, its screenshots, and its overview file.

```sh
git clone https://github.com/rayzalzero/marketplace.git /tmp/marketplace
cd /tmp/marketplace
git remote add upstream https://github.com/get-bb/marketplace.git
git fetch upstream main
git switch -c submit-finder-X.Y.Z upstream/main
```

### The entry file

`entries/finder.json`. The schema
(`schema/marketplace-v2.schema.json`) rejects any field not in this list:

| Field | Rule |
| --- | --- |
| `id` | Must equal the filename and the plugin id BB derives from `package.json` (`bb-plugin-finder` → `finder`). |
| `displayName` | The product name, short enough for a card title. No "plugin", no "BB". |
| `description` | First sentence is the hook: the outcome, under ~140 characters, starting with a verb. Each later sentence gives one capability. State every cost (external service, account, separate install). |
| `icon` | A vendored file under `icons/`, named `<id>-<first 8 of sha256>.<ext>`, ≤ 256 KB. |
| `screenshots` | Up to six, under `screenshots/finder/`, PNG/JPEG/WebP, ≥ 1200 px wide, ≤ 2 MiB each. |
| `overview` | `./overview/finder.md` — a copy of this repository's `PLUGIN_OVERVIEW.md`. |
| `tags` | Up to ten lowercase, hyphenated, ≤ 32 characters. Words a user searches for. |
| `author` | `github` must be the account opening the pull request. No email. |
| `category` | One id from `marketplace.base.json`. Finder uses `file-viewers-and-editors`. |
| `source` | The Git range above. |

Do not author `publishedAt`; the build writes it from the commit that first
added the entry.

### The overview file

`overview/finder.md` is the long-form description and must stay identical to
`PLUGIN_OVERVIEW.md` in this repository. Rules the build enforces:

- UTF-8, at most 4000 characters.
- Markdown only: headings, paragraphs, emphasis, strong, strikethrough, inline
  code, code blocks, blockquotes, ordered and unordered lists, thematic breaks,
  and links.
- Every link must be an absolute `https` URL.
- No raw HTML, images, tables, footnotes, or task lists.
- No `#` title at the top — the page already shows the plugin name. Start with
  the outcome and use `##` for sections.

```sh
cp /path/to/bb-file-explorer/PLUGIN_OVERVIEW.md overview/finder.md
```

### Screenshots

Capture the real plugin surface from a running BB, never a mockup. Capture at a
device pixel ratio of 2 when the tool allows it, crop to the plugin area so no
unrelated project list or thread text is published, and check the image for
tokens, email addresses, and home-directory paths before committing.

```sh
python3 -c "from PIL import Image; print(Image.open('screenshots/finder/outline.png').size)"
```

### Validate and open the pull request

```sh
npm ci --ignore-scripts
npm run build     # validates entries, icons, screenshots, overview
npm run check     # same build plus remote-source liveness

git status --short
git diff --check
git diff -- entries/finder.json overview/finder.md

git add entries/finder.json overview/finder.md screenshots/finder/
git commit -m "Update Finder listing for vX.Y.Z"
git push -u origin submit-finder-X.Y.Z
```

Open the pull request against `get-bb/marketplace:main`. The body states what
the plugin does, the release source and range, the plugin checks that passed,
the marketplace checks that passed, what each screenshot shows, and where the
overview text came from.

### The v1-change gate

CI runs `npm run gate:v1`, which compares every entry against the frozen v1
document already published at `https://getbb.app/marketplace/v1/marketplace.json`.
Any byte that differs in an existing entry — the range, the description, a tag
— fails the job with:

```
error: Frozen v1 entries changed. changed entries: finder
error: Add the "v1-change" label if the change is intentional.
```

Only a repository maintainer can apply that label; a contributor's token gets
`Must have admin rights to Repository`. So an update pull request that changes
any v1 field stays red until a maintainer labels it, and that is the normal path
— say so in a comment on the pull request instead of trying to make the job
green. `npm run build` and `npm test` run before the gate and must pass on their
own.

A maintainer reviews the source and the behavior before merging. Merging
publishes both marketplace documents; it installs nothing on any user's
machine.

## Checklist

- [ ] `package.json` version bumped, `npm run typecheck` and `npm run build` clean.
- [ ] Changed surface observed in a real BB window.
- [ ] Commit pushed, annotated tag `vX.Y.Z` pushed, `git ls-remote --tags` shows it.
- [ ] `bb plugin install git:…@semver:^X.Y.Z` succeeds.
- [ ] `PLUGIN_OVERVIEW.md` updated if the store copy changed, ≤ 4000 characters.
- [ ] Marketplace pull request opened only if an entry field changed.
- [ ] `npm run build` and `npm run check` pass in the marketplace clone.
