// MCP tools: library. Registered with shared { tool, text, ok, safe, client, z } helpers.
// `meta`: name -> [flags (r read-only, d destructive, i idempotent, o external/paid), cost, next].
const free = 'Free; local only.';
export const meta = {
  rename_project: ['i', free, 'list_projects'],
  tag_assets: ['i', free, 'search_assets'],
  search_assets: ['r', free, 'asset_lineage'],
  asset_lineage: ['r', free, null],
  storage_usage: ['r', free, 'find_unused_assets'],
  find_unused_assets: ['r', free, 'delete_assets (confirm=true) only after reviewing candidates'],
  delete_assets: ['d', free, 'storage_usage'],
  duplicate_storyboard: ['', free, 'get_storyboard'],
  export_storyboard_json: ['r', free, 'import_storyboard_json'],
  import_storyboard_json: ['', free, 'get_storyboard'],
  get_generation_history: ['r', free, 'get_generation'],
};

export function register({ tool, text, ok, safe, client, z }) {
  const id = z.string().regex(/^[a-f0-9-]{36}$/i);
  const ids = z.array(id).min(1).max(200);
  const paging = { offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(30) };
  const query = (values) => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const add = (name, title, description, inputSchema, handler) => tool(name, { title, description, inputSchema }, safe(async (args) => ok(text(await handler(args)))));
  add('rename_project', 'Rename a project', 'Change the project name, keeping its assets and storyboards.',
    { projectId: id, name: z.string().trim().min(1).max(80) }, async ({ projectId, name }) => (await client.call('PATCH', `/api/projects/${projectId}`, { name })).project);
  add('tag_assets', 'Tag library assets', 'Add and remove exact, case-sensitive tags on a batch of assets. Duplicate tags are collapsed; removal wins. Tags persist locally.',
    { assetIds: ids, add: z.array(z.string().trim().min(1).max(80)).max(50).default([]), remove: z.array(z.string().trim().min(1).max(80)).max(50).default([]) },
    (args) => client.call('POST', '/api/library/assets/tags', args));
  add('search_assets', 'Search the asset library', 'Filter by project, kind, exact tag, label/prompt/tag text or inclusive ISO creation dates (from/to). Small summaries, newest first with an ID tie-break, offset/limit and nextOffset. Pagination is stable while the library is unchanged.',
    { projectId: id.optional(), kind: z.string().max(80).optional(), tag: z.string().max(80).optional(), text: z.string().max(500).optional(), from: z.string().optional(), to: z.string().optional(), ...paging },
    (args) => client.call('GET', `/api/library/assets/search?${query(args)}`));
  add('asset_lineage', 'Trace an asset’s lineage', 'Show an asset, its parent chain (nearest first), direct children such as reframes/upscales/takes, and each asset’s creating generation: model, prompt excerpt and recorded cost/billing state.',
    { assetId: id }, ({ assetId }) => client.call('GET', `/api/assets/${assetId}/lineage`));
  add('storage_usage', 'Measure local storage', 'Measure file bytes per project and kind, the ten largest assets, the data folder and entire Lumina data root, and available disk space. Project filtering affects asset totals; folder and disk totals stay global. Symlinks are skipped.',
    { projectId: id.optional() }, (args) => client.call('GET', `/api/library/storage?${query(args)}`));
  add('find_unused_assets', 'Find unused asset candidates', 'Dry run only: list unreferenced assets and their on-disk sizes. Conservatively scans all projects, shots/takes, pages, chapters, characters, storyboard music/cues/sfx, canvas graphs/runs/templates, film events, lineage and generation inputs. Does not delete anything.',
    { projectId: id }, ({ projectId }) => client.call('GET', `/api/projects/${projectId}/unused-assets`));
  add('delete_assets', 'Delete unused library assets', 'Permanently delete asset files and rows, requiring confirm=true. Rechecks the same conservative reference scan and refuses the whole batch if any asset is referenced or unknown. Reports deleted IDs, filesystem failures and actual bytes freed.',
    { assetIds: ids, confirm: z.literal(true) }, (args) => client.call('POST', '/api/library/assets/delete', args));
  add('duplicate_storyboard', 'Branch a storyboard', 'Copy a storyboard’s plan, settings, screenplay and scene states into a new storyboard. Shots share the same media IDs with no file copies. Cue shot IDs are remapped. Joined film, controller and review approvals are omitted.',
    { storyboardId: id, title: z.string().trim().min(1).max(80) }, ({ storyboardId, title }) => client.call('POST', `/api/storyboards/${storyboardId}/duplicate`, { title }));
  add('export_storyboard_json', 'Export a portable storyboard plan', 'Return versioned JSON text containing the storyboard plan, shots, details, settings, scene states and character/media IDs. Contains no file paths, joined film or approvals. Media files and character definitions are not bundled.',
    { storyboardId: id }, ({ storyboardId }) => client.call('GET', `/api/storyboards/${storyboardId}/export-json`));
  add('import_storyboard_json', 'Import a portable storyboard plan', 'Validate exported Lumina JSON text (version 1, up to 1 MB) and create a new storyboard without running generation. Reject malformed plans and embedded path fields. Missing characters map to none with warnings; media unavailable in the destination project is cleared with warnings. New shot IDs and cue references are remapped.',
    { projectId: id, json: z.string().max(1024 * 1024) }, ({ projectId, json }) => client.call('POST', `/api/projects/${projectId}/storyboards/import-json`, { json }));
  add('get_generation_history', 'Browse generation history', 'Browse a project’s recorded generations, newest first, filtered by status, operation or exact model. Paginated small summaries include prompt excerpts and recorded cost/billing state. Does not submit or retry jobs.',
    { projectId: id, status: z.string().max(80).optional(), operation: z.string().max(80).optional(), model: z.string().max(200).optional(), ...paging },
    ({ projectId, ...args }) => client.call('GET', `/api/projects/${projectId}/generation-history?${query(args)}`));
}
