# Library and project management

All eleven tools are free and local. They do not submit generation jobs, call providers, download models or require a GPU. The MCP extension uses authenticated API routes; renaming reuses the existing project PATCH route. New metadata uses only `repo.settings` (`asset-tags:<assetId>` and `asset-tags:index`); there are no schema changes.

| Tool | Inputs | Result |
| --- | --- | --- |
| `rename_project` | `projectId`, `name` (1–80 trimmed characters) | Renamed project |
| `tag_assets` | `assetIds` (1–200), `add=[]`, `remove=[]` (up to 50 each, 1–80 characters per tag) | Asset IDs and sorted tags; exact case-sensitive matches, removal wins |
| `search_assets` | Optional `projectId`, `kind`, `tag`, `text`, `from`, `to`; `offset=0`, `limit=30` (1–100) | Small asset summaries and tags, `total`, `offset`, `limit`, `nextOffset` |
| `asset_lineage` | `assetId` | Asset, nearest-first `parents`, direct `children`, generation summaries and warnings for missing parents/cycles |
| `storage_usage` | Optional `projectId` | `assetBytes`, project totals, `byKind`, ten `largest` files, `dataFolderBytes`, `dataRootBytes`, `freeDiskBytes`, warnings |
| `find_unused_assets` | `projectId` | Dry-run `assets` with sizes, `total`, `bytes`; never deletes |
| `delete_assets` | `assetIds` (1–200), required literal `confirm: true` | `deleted` IDs, `failed` filesystem operations, `bytesFreed` |
| `duplicate_storyboard` | `storyboardId`, `title` (1–80 characters) | New `sequence`, new `shots`, warnings |
| `export_storyboard_json` | `storyboardId` | `{ json }`, containing portable plan JSON text |
| `import_storyboard_json` | `projectId`, `json` | New `sequence`, new `shots`, warnings |
| `get_generation_history` | `projectId`; optional exact `status`, `operation`, `model`; `offset=0`, `limit=30` (1–100) | `generations`, `total`, pagination fields |

Search matches case-insensitive substrings in labels, tags and original generation prompts. Dates are inclusive ISO creation-time boundaries; a date without a time means midnight UTC. Search and history sort by creation time descending, then ID descending for ties. Offset pagination is deterministic while records and filters remain unchanged; it is not a snapshot across concurrent edits or insertions. Generation summaries include at most 2,000 prompt characters, recorded billing state and ledger estimates/charges; unavailable costs are null, not assumed to be zero.

## Reference safety and deletion

Unused detection and batch deletion share one conservative scan across **all** projects, since global characters and other projects can reference the destination project's assets. It includes:

- Shot frames/clips, recorded dialogue, sound effects, attached clips, post-processing caches, reviews and takes exposed by the sequence service, including recognized derived takes.
- Storyboard settings (music, ambience and music cues), joined output and stored scene/join state.
- Book covers, pages, chapters and their media; previous generation outputs tied to surviving book/shot targets.
- Global character references, canvas graphs, all canvas run states and saved canvas templates.
- Film controller state and all film events, including media belonging to generations named in events. Stored visual-review events and optional canon revisions/events/snapshots are also retained.
- Parent assets of derived files, generation inputs and masks (kept for retries), and active-job outputs.

Nested values, object keys, IDs embedded in strings and stored asset filenames count as references. This deliberately retains some files that a person might consider unused. Ordinary unattached generation outputs do not become protected solely because they have a generation-history row.

Deletion validates the entire batch before touching any files. A referenced, unknown, unsafe or non-regular asset refuses the batch. Symlinks are never followed or deleted. Duplicate requested IDs count once. Missing files permit row cleanup and free zero bytes. The reference check and file operations run synchronously inside a repository write transaction, preventing app requests from attaching assets between check and deletion. Individual unlink failures preserve their rows and appear in `failed`; successfully deleted files are counted using actual file sizes. Tags and the tag index are cleaned up. Filesystem work and SQLite commits cannot be made crash-atomic: a process/disk failure may require cleanup of missing files. Existing legacy single-asset/project deletion APIs are unchanged; these guarantees apply to the new library tools/routes.

## Copies and portable plans

A duplicate preserves the plan, screenplay, settings, shot details and structured scene states. It allocates new storyboard/shot IDs and remaps cue `shotId` references. Media IDs are shared: no media bytes are copied. Shot review approvals, film output/controller, join state and derived rendering caches are omitted. Separate extension histories, such as canon and visual-review histories, are not cloned.

Exports use `format: "lumina-storyboard"`, `version: 1`, `title`, `idea`, `screenplay`, `settings`, and ordered `shots`. Each shot contains its source `id`, description, camera, duration, details, image/video asset IDs and optional scene state. No local paths, files, joined output or approvals are exported.

Import accepts JSON text up to 1 MiB, up to 60 shots and a total planned runtime of 900 seconds. It validates the version, envelope, shot shapes, media/character IDs and nested dialogue/music/sound fields before any write. It rejects duplicate shot IDs, path-bearing fields and unsafe object keys at every depth. It never reads embedded filenames, opens paths or downloads media. Import creates a new board transactionally, remapping shot/cue IDs. Missing global characters are removed from cast arrays and locations, missing dialogue speakers become `none`, and missing scene-state characters are omitted, with warnings. Missing or foreign-project media IDs are cleared with warnings. Media files and character definitions are not bundled; move/recreate them separately before using the imported plan for production.

Storage measurements use logical regular-file sizes, not allocated disk blocks. Project filtering affects asset statistics; folder/disk statistics are global. The data folder means `<dataRoot>/data` (database and settings), while the data-root total also includes storage, exports and other local folders. Symlinks are skipped and measurement failures are reported. Reference scans use the repository's exposed records and known extension settings; arbitrary third-party settings namespaces require adding a reference source. Scans and folder traversal read the complete local library and may take time for large installations.

## Verification

`tests/library-tools.test.js` uses the real stdio MCP client against a temporary app/data directory with mock providers and offline mode. It covers eleven tool registrations, rename/tags/search and pagination, a derived asset made through the existing reframe API, lineage/history, conservative references, confirmation and batch deletion, physical storage, duplication without approvals and JSON round trips/refusals.

Run only the requested focused suites:

```sh
timeout 180 node --test tests/library-tools.test.js tests/mcp.test.js
```
