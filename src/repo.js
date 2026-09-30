import { randomUUID } from 'node:crypto';

const now = () => new Date().toISOString();
const parse = (value, fallback) => (value == null ? fallback : JSON.parse(value));

const toProject = (r) => r && { id: r.id, name: r.name, createdAt: r.created_at, updatedAt: r.updated_at };
const toAsset = (r) => r && {
  id: r.id, projectId: r.project_id, kind: r.kind, mimeType: r.mime_type, path: `/assets/${r.file}`, file: r.file,
  size: r.size, label: r.label, generationId: r.generation_id, parentAssetId: r.parent_asset_id, createdAt: r.created_at,
};
const toGeneration = (r) => r && {
  id: r.id, projectId: r.project_id, status: r.status, operation: r.operation, provider: r.provider, model: r.model,
  prompt: r.prompt, finalPrompt: r.final_prompt, director: r.director, params: parse(r.params, {}),
  inputAssetIds: parse(r.input_asset_ids, []), assetId: r.output_asset_id,
  assetPath: r.output_file ? `/assets/${r.output_file}` : null, errorCategory: r.error_category, userError: r.user_error,
  usage: parse(r.usage, null), canvasRunId: r.canvas_run_id, nodeId: r.node_id, createdAt: r.created_at,
  startedAt: r.started_at, completedAt: r.completed_at, durationMs: r.duration_ms,
};
const toCanvas = (r) => r && {
  id: r.id, projectId: r.project_id, name: r.name, graph: parse(r.graph, { nodes: [], edges: [] }), version: r.version,
  createdAt: r.created_at, updatedAt: r.updated_at,
};
const toRun = (r) => r && {
  id: r.id, canvasId: r.canvas_id, status: r.status, nodeState: parse(r.node_state, {}), error: r.error,
  createdAt: r.created_at, completedAt: r.completed_at,
};

const generationSelect = `SELECT g.*, a.file AS output_file FROM generations g LEFT JOIN assets a ON a.id = g.output_asset_id`;

// Column names allowed in generation updates, keyed by their camelCase field.
const generationColumns = {
  status: 'status', finalPrompt: 'final_prompt', outputAssetId: 'output_asset_id', errorCategory: 'error_category',
  userError: 'user_error', usage: 'usage', startedAt: 'started_at', completedAt: 'completed_at', durationMs: 'duration_ms',
};

export function createRepo(db) {
  const touch = (projectId) => db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').run(now(), projectId);

  const projects = {
    list: () => db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all().map(toProject),
    get: (id) => toProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)),
    create(name) {
      const project = { id: randomUUID(), name: cleanName(name, 'Untitled project'), createdAt: now(), updatedAt: now() };
      db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
        .run(project.id, project.name, project.createdAt, project.updatedAt);
      return project;
    },
    rename(id, name) {
      db.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(cleanName(name, 'Untitled project'), now(), id);
      return projects.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0,
    touch,
  };

  const assets = {
    get: (id) => toAsset(db.prepare('SELECT * FROM assets WHERE id = ?').get(id)),
    listByProject: (projectId) => db.prepare('SELECT * FROM assets WHERE project_id = ? ORDER BY created_at DESC').all(projectId).map(toAsset),
    listByKind: (kind, limit = 200) => db.prepare('SELECT * FROM assets WHERE kind = ? ORDER BY created_at DESC LIMIT ?').all(kind, limit).map(toAsset),
    filesForProject: (projectId) => db.prepare('SELECT file FROM assets WHERE project_id = ?').all(projectId).map((r) => r.file),
    create({ projectId, kind, mimeType, file, size, label = null, generationId = null, parentAssetId = null }) {
      const id = file.split('.')[0];
      db.prepare(`INSERT INTO assets (id, project_id, kind, mime_type, file, size, label, generation_id, parent_asset_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, projectId, kind, mimeType, file, size, label, generationId, parentAssetId, now());
      touch(projectId);
      return assets.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM assets WHERE id = ?').run(id).changes > 0,
  };

  const generations = {
    get: (id) => toGeneration(db.prepare(`${generationSelect} WHERE g.id = ?`).get(id)),
    listByProject: (projectId, limit = 200) => db.prepare(`${generationSelect} WHERE g.project_id = ? ORDER BY g.created_at DESC LIMIT ?`)
      .all(projectId, limit).map(toGeneration),
    idsWithStatus: (status) => db.prepare('SELECT id FROM generations WHERE status = ? ORDER BY created_at').all(status).map((r) => r.id),
    create(fields) {
      const id = randomUUID();
      db.prepare(`INSERT INTO generations (id, project_id, status, operation, provider, model, prompt, director, params,
        input_asset_ids, canvas_run_id, node_id, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fields.projectId, fields.operation, fields.provider, fields.model, fields.prompt, fields.director ?? null,
          JSON.stringify(fields.params ?? {}), JSON.stringify(fields.inputAssetIds ?? []), fields.canvasRunId ?? null,
          fields.nodeId ?? null, now());
      touch(fields.projectId);
      return generations.get(id);
    },
    update(id, fields) {
      const entries = Object.entries(fields).filter(([key]) => key in generationColumns);
      if (!entries.length) return generations.get(id);
      const sql = entries.map(([key]) => `${generationColumns[key]} = ?`).join(', ');
      const values = entries.map(([key, value]) => (key === 'usage' && value != null ? JSON.stringify(value) : value ?? null));
      db.prepare(`UPDATE generations SET ${sql} WHERE id = ?`).run(...values, id);
      return generations.get(id);
    },
    // Jobs that were mid-flight when the app stopped can't be resumed; mark them so the UI can offer a retry.
    markInterrupted: () => db.prepare(`UPDATE generations SET status = 'interrupted', user_error = 'Lumina closed before this finished.',
      completed_at = ? WHERE status = 'running'`).run(now()).changes,
  };

  const canvases = {
    get: (id) => toCanvas(db.prepare('SELECT * FROM canvases WHERE id = ?').get(id)),
    listByProject: (projectId) => db.prepare('SELECT * FROM canvases WHERE project_id = ? ORDER BY updated_at DESC').all(projectId).map(toCanvas),
    create(projectId, name, graph) {
      const id = randomUUID();
      db.prepare('INSERT INTO canvases (id, project_id, name, graph, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)')
        .run(id, projectId, cleanName(name, 'Untitled canvas'), JSON.stringify(graph), now(), now());
      touch(projectId);
      return canvases.get(id);
    },
    // Optimistic concurrency: the write only lands if the caller saw the latest version.
    save(id, { name, graph, version }) {
      const current = canvases.get(id);
      if (!current) return { error: 'not_found' };
      if (version !== current.version) return { error: 'conflict', canvas: current };
      db.prepare('UPDATE canvases SET name = ?, graph = ?, version = version + 1, updated_at = ? WHERE id = ?')
        .run(cleanName(name ?? current.name, current.name), JSON.stringify(graph ?? current.graph), now(), id);
      return { canvas: canvases.get(id) };
    },
    remove: (id) => db.prepare('DELETE FROM canvases WHERE id = ?').run(id).changes > 0,
  };

  const runs = {
    get: (id) => toRun(db.prepare('SELECT * FROM canvas_runs WHERE id = ?').get(id)),
    listByCanvas: (canvasId, limit = 20) => db.prepare('SELECT * FROM canvas_runs WHERE canvas_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
      .all(canvasId, limit).map(toRun),
    create(canvasId, nodeState) {
      const id = randomUUID();
      db.prepare(`INSERT INTO canvas_runs (id, canvas_id, status, node_state, created_at) VALUES (?, ?, 'running', ?, ?)`)
        .run(id, canvasId, JSON.stringify(nodeState), now());
      return runs.get(id);
    },
    update(id, { status, nodeState, error }) {
      const done = status && status !== 'running' ? now() : null;
      db.prepare(`UPDATE canvas_runs SET status = COALESCE(?, status), node_state = COALESCE(?, node_state),
        error = COALESCE(?, error), completed_at = COALESCE(?, completed_at) WHERE id = ?`)
        .run(status ?? null, nodeState ? JSON.stringify(nodeState) : null, error ?? null, done, id);
      return runs.get(id);
    },
    markInterrupted: () => db.prepare(`UPDATE canvas_runs SET status = 'interrupted', completed_at = ? WHERE status = 'running'`).run(now()).changes,
  };

  const settings = {
    get: (key, fallback = null) => parse(db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value, fallback),
    set: (key, value) => db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value)),
  };

  return { projects, assets, generations, canvases, runs, settings };
}

function cleanName(name, fallback) {
  return String(name ?? '').trim().slice(0, 80) || fallback;
}
