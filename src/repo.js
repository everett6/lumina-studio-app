import { randomUUID } from 'node:crypto';
import { transaction } from './db.js';

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
  usage: parse(r.usage, null), canvasRunId: r.canvas_run_id, nodeId: r.node_id, bookPageId: r.book_page_id, bookTarget: r.book_target,
  mimeType: r.output_mime ?? null, createdAt: r.created_at,
  providerJob: parse(r.provider_job, null), idempotencyKey: r.idempotency_key ?? null, billing: r.billing ?? null,
  billingState: parse(r.provider_job, null)?.billingState ?? r.billing_state ?? parse(r.params, {})?.accounting?.billingState ?? null,
  requestFingerprint: r.request_fingerprint ?? parse(r.params, {})?.accounting?.requestFingerprint ?? null,
  retryOf: r.retry_of ?? parse(r.params, {})?.accounting?.retryOf ?? null,
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

const generationSelect = `SELECT g.*, a.file AS output_file, a.mime_type AS output_mime FROM generations g LEFT JOIN assets a ON a.id = g.output_asset_id`;

// Column names allowed in generation updates, keyed by their camelCase field.
const generationColumns = {
  status: 'status', finalPrompt: 'final_prompt', outputAssetId: 'output_asset_id', errorCategory: 'error_category',
  userError: 'user_error', usage: 'usage', startedAt: 'started_at', completedAt: 'completed_at', durationMs: 'duration_ms',
  providerJob: 'provider_job', billing: 'billing', billingState: 'billing_state',
};
const jsonColumns = new Set(['usage', 'providerJob']);

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
    listByTarget: (target) => db.prepare(`${generationSelect} WHERE g.book_target = ? ORDER BY g.created_at DESC`).all(target).map(toGeneration),
    listByPage: (pageId) => db.prepare(`${generationSelect} WHERE g.book_page_id = ? ORDER BY g.created_at DESC`).all(pageId).map(toGeneration),
    idsWithStatus: (status) => db.prepare('SELECT id FROM generations WHERE status = ? ORDER BY created_at').all(status).map((r) => r.id),
    create(fields) {
      const id = randomUUID();
      db.prepare(`INSERT INTO generations (id, project_id, status, operation, provider, model, prompt, director, params,
        input_asset_ids, canvas_run_id, node_id, book_page_id, book_target, idempotency_key, billing, billing_state, request_fingerprint, retry_of, created_at)
        VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fields.projectId, fields.operation, fields.provider, fields.model, fields.prompt, fields.director ?? null,
          JSON.stringify(fields.params ?? {}), JSON.stringify(fields.inputAssetIds ?? []), fields.canvasRunId ?? null,
          fields.nodeId ?? null, fields.bookPageId ?? null, fields.bookTarget ?? null, fields.idempotencyKey ?? null, fields.billing ?? null, fields.billingState ?? 'not_submitted', fields.requestFingerprint ?? null, fields.retryOf ?? null, now());
      touch(fields.projectId);
      return generations.get(id);
    },
    update(id, fields) {
      const entries = Object.entries(fields).filter(([key]) => key in generationColumns);
      if (!entries.length) return generations.get(id);
      const sql = entries.map(([key]) => `${generationColumns[key]} = ?`).join(', ');
      const values = entries.map(([key, value]) => (jsonColumns.has(key) && value != null ? JSON.stringify(value) : value ?? null));
      db.prepare(`UPDATE generations SET ${sql} WHERE id = ?`).run(...values, id);
      return generations.get(id);
    },
    claim: (id) => db.prepare("UPDATE generations SET status = 'running' WHERE id = ? AND status = 'queued'").run(id).changes > 0,
    byIdempotencyKey: (key) => toGeneration(db.prepare(`${generationSelect} WHERE g.idempotency_key = ?`).get(key)),
    // Jobs that were mid-flight when the app stopped can't be resumed; mark them so the UI can offer a retry.
    markInterrupted: (ids) => {
      const mark = db.prepare(`UPDATE generations SET status = 'interrupted', user_error = 'Lumina closed before this finished.',
        completed_at = ? WHERE id = ? AND status = 'running'`);
      return ids.reduce((count, id) => count + mark.run(now(), id).changes, 0);
    },
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

  const books = {
    get: (id) => toBook(db.prepare('SELECT * FROM books WHERE id = ?').get(id)),
    listByProject: (projectId) => db.prepare(`SELECT b.*, (SELECT COUNT(*) FROM book_pages p WHERE p.book_id = b.id) AS page_count
      FROM books b WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId).map((r) => ({ ...toBook(r), pageCount: r.page_count })),
    create({ projectId, title, kind = 'picture_book', brief = {}, bible = {}, writer = null }) {
      const id = randomUUID();
      db.prepare('INSERT INTO books (id, project_id, title, kind, brief, bible, writer, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, cleanName(title, 'Untitled book'), kind, JSON.stringify(brief), JSON.stringify(bible), writer, now(), now());
      touch(projectId);
      return books.get(id);
    },
    update(id, { title, brief, bible, writer, coverAssetId }) {
      const current = books.get(id);
      db.prepare('UPDATE books SET title = ?, brief = ?, bible = ?, writer = ?, cover_asset_id = ?, updated_at = ? WHERE id = ?')
        .run(title === undefined ? current.title : cleanName(title, current.title), JSON.stringify(brief ?? current.brief),
          JSON.stringify(bible ?? current.bible), writer === undefined ? current.writer : writer,
          coverAssetId === undefined ? current.coverAssetId : coverAssetId, now(), id);
      return books.get(id);
    },
    touch: (id) => db.prepare('UPDATE books SET updated_at = ? WHERE id = ?').run(now(), id),
    remove: (id) => db.prepare('DELETE FROM books WHERE id = ?').run(id).changes > 0,
  };

  const pageSelect = 'SELECT p.*, a.file AS asset_file FROM book_pages p LEFT JOIN assets a ON a.id = p.asset_id';
  const pages = {
    get: (id) => toPage(db.prepare(`${pageSelect} WHERE p.id = ?`).get(id)),
    listByBook: (bookId) => db.prepare(`${pageSelect} WHERE p.book_id = ? ORDER BY p.position`).all(bookId).map(toPage),
    // Positions are kept dense (1..n) so reordering is a simple swap.
    renumber(bookId) {
      const ids = db.prepare('SELECT id FROM book_pages WHERE book_id = ? ORDER BY position, created_at').all(bookId).map((r) => r.id);
      const set = db.prepare('UPDATE book_pages SET position = ? WHERE id = ?');
      ids.forEach((pageId, index) => set.run(index + 1, pageId));
    },
    insert(bookId, { position, text = '', illustrationBrief = '' }) {
      const id = randomUUID();
      db.prepare('UPDATE book_pages SET position = position + 1 WHERE book_id = ? AND position >= ?').run(bookId, position);
      db.prepare('INSERT INTO book_pages (id, book_id, position, text, illustration_brief, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, bookId, position, text, illustrationBrief, now(), now());
      books.touch(bookId);
      return pages.get(id);
    },
    replaceAll(bookId, list) {
      db.prepare('DELETE FROM book_pages WHERE book_id = ?').run(bookId);
      const insert = db.prepare('INSERT INTO book_pages (id, book_id, position, text, illustration_brief, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
      const revision = db.prepare('INSERT INTO page_revisions (id, page_id, text, illustration_brief, source, created_at) VALUES (?, ?, ?, ?, ?, ?)');
      list.forEach((page, index) => {
        const id = randomUUID();
        insert.run(id, bookId, index + 1, page.text, page.illustrationBrief, now(), now());
        revision.run(randomUUID(), id, page.text, page.illustrationBrief, 'plan', now());
      });
      books.touch(bookId);
      return pages.listByBook(bookId);
    },
    // Text edits keep the previous version in page_revisions.
    update(id, { text, illustrationBrief, assetId }, source = 'edit') {
      const current = pages.get(id);
      const nextText = text ?? current.text;
      const nextBrief = illustrationBrief ?? current.illustrationBrief;
      if (nextText !== current.text || nextBrief !== current.illustrationBrief) {
        db.prepare('INSERT INTO page_revisions (id, page_id, text, illustration_brief, source, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), id, nextText, nextBrief, source, now());
      }
      db.prepare('UPDATE book_pages SET text = ?, illustration_brief = ?, asset_id = ?, updated_at = ? WHERE id = ?')
        .run(nextText, nextBrief, assetId === undefined ? current.assetId : assetId, now(), id);
      books.touch(current.bookId);
      return pages.get(id);
    },
    move(id, direction) {
      const page = pages.get(id);
      const neighbour = db.prepare(`SELECT id, position FROM book_pages WHERE book_id = ? AND position ${direction < 0 ? '<' : '>'} ?
        ORDER BY position ${direction < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(page.bookId, page.position);
      if (!neighbour) return page;
      db.prepare('UPDATE book_pages SET position = ? WHERE id = ?').run(neighbour.position, id);
      db.prepare('UPDATE book_pages SET position = ? WHERE id = ?').run(page.position, neighbour.id);
      books.touch(page.bookId);
      return pages.get(id);
    },
    remove(id) {
      const page = pages.get(id);
      db.prepare('DELETE FROM book_pages WHERE id = ?').run(id);
      pages.renumber(page.bookId);
      books.touch(page.bookId);
    },
    revisions: (id) => db.prepare('SELECT * FROM page_revisions WHERE page_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id)
      .map((r) => ({ id: r.id, text: r.text, illustrationBrief: r.illustration_brief, source: r.source, createdAt: r.created_at })),
    setMedia(id, { narrationAssetId, videoAssetId }) {
      const current = pages.get(id);
      db.prepare('UPDATE book_pages SET narration_asset_id = ?, video_asset_id = ?, updated_at = ? WHERE id = ?')
        .run(narrationAssetId === undefined ? current.narrationAssetId : narrationAssetId, videoAssetId === undefined ? current.videoAssetId : videoAssetId, now(), id);
      return pages.get(id);
    },
  };

  const chapters = {
    get: (id) => toChapter(db.prepare('SELECT * FROM book_chapters WHERE id = ?').get(id)),
    listByBook: (bookId) => db.prepare('SELECT * FROM book_chapters WHERE book_id = ? ORDER BY position').all(bookId).map(toChapter),
    renumber(bookId) {
      const ids = db.prepare('SELECT id FROM book_chapters WHERE book_id = ? ORDER BY position, created_at').all(bookId).map((r) => r.id);
      const set = db.prepare('UPDATE book_chapters SET position = ? WHERE id = ?');
      ids.forEach((chapterId, index) => set.run(index + 1, chapterId));
    },
    revise(id, source) {
      const c = chapters.get(id);
      db.prepare('INSERT INTO chapter_revisions (id, chapter_id, title, summary, beats, text, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(randomUUID(), id, c.title, c.summary, JSON.stringify(c.beats), c.text, source, now());
    },
    insert(bookId, { position, title = '', summary = '', beats = [], text = '' }, source = 'edit') {
      const id = randomUUID();
      db.prepare('UPDATE book_chapters SET position = position + 1 WHERE book_id = ? AND position >= ?').run(bookId, position);
      db.prepare('INSERT INTO book_chapters (id, book_id, position, title, summary, beats, text, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, bookId, position, title, summary, JSON.stringify(beats), text, now(), now());
      chapters.revise(id, source);
      books.touch(bookId);
      return chapters.get(id);
    },
    replaceAll(bookId, list) {
      db.prepare('DELETE FROM book_chapters WHERE book_id = ?').run(bookId);
      list.forEach((chapter, index) => chapters.insert(bookId, { ...chapter, position: index + 1 }, 'outline'));
      return chapters.listByBook(bookId);
    },
    // Every content change snapshots the new state into chapter_revisions.
    update(id, fields, source = 'edit') {
      const c = chapters.get(id);
      const next = {
        title: fields.title ?? c.title, summary: fields.summary ?? c.summary, beats: fields.beats ?? c.beats, text: fields.text ?? c.text,
        assetId: fields.assetId === undefined ? c.assetId : fields.assetId,
        narrationAssetId: fields.narrationAssetId === undefined ? c.narrationAssetId : fields.narrationAssetId,
      };
      db.prepare(`UPDATE book_chapters SET title = ?, summary = ?, beats = ?, text = ?, asset_id = ?, narration_asset_id = ?, updated_at = ? WHERE id = ?`)
        .run(next.title, next.summary, JSON.stringify(next.beats), next.text, next.assetId, next.narrationAssetId, now(), id);
      const changed = next.title !== c.title || next.summary !== c.summary || next.text !== c.text || JSON.stringify(next.beats) !== JSON.stringify(c.beats);
      if (changed) chapters.revise(id, source);
      books.touch(c.bookId);
      return chapters.get(id);
    },
    move(id, direction) {
      const c = chapters.get(id);
      const neighbour = db.prepare(`SELECT id, position FROM book_chapters WHERE book_id = ? AND position ${direction < 0 ? '<' : '>'} ?
        ORDER BY position ${direction < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(c.bookId, c.position);
      if (!neighbour) return c;
      db.prepare('UPDATE book_chapters SET position = ? WHERE id = ?').run(neighbour.position, id);
      db.prepare('UPDATE book_chapters SET position = ? WHERE id = ?').run(c.position, neighbour.id);
      books.touch(c.bookId);
      return chapters.get(id);
    },
    remove(id) {
      const c = chapters.get(id);
      db.prepare('DELETE FROM book_chapters WHERE id = ?').run(id);
      chapters.renumber(c.bookId);
      books.touch(c.bookId);
    },
    revisions: (id) => db.prepare('SELECT * FROM chapter_revisions WHERE chapter_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50').all(id)
      .map((r) => ({ id: r.id, title: r.title, summary: r.summary, beats: parse(r.beats, []), text: r.text, source: r.source, createdAt: r.created_at })),
  };

  const oauth = {
    getClient: (clientId) => parse(db.prepare('SELECT data FROM oauth_clients WHERE client_id = ?').get(clientId)?.data, undefined),
    saveClient: (client) => db.prepare('INSERT OR REPLACE INTO oauth_clients (client_id, data, created_at) VALUES (?, ?, ?)').run(client.client_id, JSON.stringify(client), now()),
    saveToken: ({ tokenHash, kind, clientId, scopes, resource, expiresAt }) => db.prepare(`INSERT INTO oauth_tokens
      (token_hash, kind, client_id, scopes, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(tokenHash, kind, clientId, JSON.stringify(scopes ?? []), resource ?? null, expiresAt, now()),
    getToken(tokenHash) {
      const r = db.prepare('SELECT * FROM oauth_tokens WHERE token_hash = ?').get(tokenHash);
      return r && { kind: r.kind, clientId: r.client_id, scopes: parse(r.scopes, []), resource: r.resource, expiresAt: r.expires_at };
    },
    deleteToken: (tokenHash) => db.prepare('DELETE FROM oauth_tokens WHERE token_hash = ?').run(tokenHash),
    revokeAll() {
      db.prepare('DELETE FROM oauth_tokens').run();
      db.prepare('DELETE FROM oauth_clients').run();
    },
    stats: () => ({
      clients: db.prepare('SELECT COUNT(*) AS n FROM oauth_clients').get().n,
      activeTokens: db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'access' AND expires_at > ?").get(Date.now()).n,
      webSessions: db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens WHERE kind = 'web' AND expires_at > ?").get(Date.now()).n,
    }),
  };

  // Every paid request: an estimate reserved before it starts, settled with the provider's charge when known.
  // Rows outlive their projects so deleting a project never resets what has been spent.
  const toSpend = (r) => r && {
    generationId: r.generation_id, projectId: r.project_id, provider: r.provider, model: r.model, operation: r.operation,
    estimatedUsd: r.estimated_usd, actualUsd: r.actual_usd, status: r.status, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
  };
  const spend = {
    get: (generationId) => toSpend(db.prepare('SELECT * FROM spend_ledger WHERE generation_id = ?').get(generationId)),
    reserve({ generationId, projectId, provider, model, operation, estimatedUsd, note = null }) {
      db.prepare(`INSERT INTO spend_ledger (generation_id, project_id, provider, model, operation, estimated_usd, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`).run(generationId, projectId, provider, model, operation, estimatedUsd ?? null, note, now(), now());
    },
    settle(generationId, { status, actualUsd, note }) {
      db.prepare('UPDATE spend_ledger SET status = ?, actual_usd = COALESCE(?, actual_usd), note = COALESCE(?, note), updated_at = ? WHERE generation_id = ?')
        .run(status, actualUsd ?? null, note ?? null, now(), generationId);
      return spend.get(generationId);
    },
    // Money counted against limits: charges as billed (or as estimated when the provider gave no figure), plus
    // reservations still open and outcomes still unknown. Released reservations count nothing.
    total({ since = null, projectId = null } = {}) {
      const where = ["status IN ('reserved', 'charged', 'unknown')"];
      const args = [];
      if (since) { where.push('created_at >= ?'); args.push(since); }
      if (projectId) { where.push('project_id = ?'); args.push(projectId); }
      const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_usd, estimated_usd)), 0) AS usd, COUNT(*) AS n FROM spend_ledger WHERE ${where.join(' AND ')}`).get(...args);
      return { usd: Math.round(row.usd * 10000) / 10000, count: row.n };
    },
    breakdown({ since = null } = {}) {
      const r = db.prepare(`SELECT
        COALESCE(SUM(estimated_usd), 0) AS estimatedUsd,
        COALESCE(SUM(CASE WHEN status = 'reserved' THEN COALESCE(actual_usd, estimated_usd) ELSE 0 END), 0) AS reservedUsd,
        COALESCE(SUM(CASE WHEN status = 'charged' THEN COALESCE(actual_usd, estimated_usd) ELSE 0 END), 0) AS chargedUsd,
        COALESCE(SUM(CASE WHEN status = 'unknown' THEN COALESCE(actual_usd, estimated_usd) ELSE 0 END), 0) AS unknownUsd
        FROM spend_ledger WHERE (? IS NULL OR created_at >= ?)`).get(since, since);
      return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Math.round(v * 10000) / 10000]));
    },
    outstanding(provider) {
      const row = db.prepare(`SELECT COALESCE(SUM(COALESCE(actual_usd, estimated_usd)), 0) AS usd,
        SUM(CASE WHEN COALESCE(actual_usd, estimated_usd) IS NULL THEN 1 ELSE 0 END) AS unpriced
        FROM spend_ledger WHERE provider = ? AND status IN ('reserved', 'unknown')`).get(provider);
      return { usd: row.usd, unpriced: row.unpriced ?? 0 };
    },
    list: (limit = 200) => db.prepare('SELECT * FROM spend_ledger ORDER BY created_at DESC LIMIT ?').all(limit).map(toSpend),
    byModel: () => db.prepare(`SELECT provider, model, COUNT(*) AS jobs, SUM(COALESCE(actual_usd, estimated_usd)) AS usd FROM spend_ledger
      WHERE status IN ('reserved', 'charged', 'unknown') GROUP BY provider, model ORDER BY usd DESC`).all(),
  };

  const toApproval = (r) => r && {
    id: r.id, signature: r.signature, summary: parse(r.summary, {}), estimatedUsd: r.estimated_usd, status: r.status,
    requestedBy: r.requested_by, createdAt: r.created_at, decidedAt: r.decided_at, usedBy: r.used_by,
  };
  const approvals = {
    get: (id) => toApproval(db.prepare('SELECT * FROM spend_approvals WHERE id = ?').get(id)),
    // An approval the person gave for exactly this request and that no job has used yet.
    approvedFor: (signature) => toApproval(db.prepare("SELECT * FROM spend_approvals WHERE signature = ? AND status = 'approved' ORDER BY decided_at DESC LIMIT 1").get(signature)),
    pendingFor: (signature) => toApproval(db.prepare("SELECT * FROM spend_approvals WHERE signature = ? AND status = 'pending' ORDER BY created_at DESC LIMIT 1").get(signature)),
    list: (status = null) => (status
      ? db.prepare('SELECT * FROM spend_approvals WHERE status = ? ORDER BY created_at DESC LIMIT 100').all(status)
      : db.prepare('SELECT * FROM spend_approvals ORDER BY created_at DESC LIMIT 100').all()).map(toApproval),
    create({ signature, summary, estimatedUsd, requestedBy }) {
      const id = randomUUID();
      db.prepare(`INSERT INTO spend_approvals (id, signature, summary, estimated_usd, status, requested_by, created_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?)`).run(id, signature, JSON.stringify(summary), estimatedUsd ?? null, requestedBy ?? null, now());
      return approvals.get(id);
    },
    decide: (id, status) => db.prepare("UPDATE spend_approvals SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending'").run(status, now(), id).changes > 0,
    use: (id, generationId) => db.prepare("UPDATE spend_approvals SET status = 'used', used_by = ? WHERE id = ? AND status = 'approved'").run(generationId, id).changes > 0,
  };

  // Characters are global (usable in every project). Their reference photos are ordinary assets.
  const characters = {
    get: (id) => toCharacter(db.prepare('SELECT * FROM characters WHERE id = ?').get(id)),
    list: () => db.prepare('SELECT * FROM characters ORDER BY name COLLATE NOCASE').all().map(toCharacter),
    create({ name, kind = 'character', description = '', referenceAssetIds = [], voice = null, designTags = '' }) {
      const id = randomUUID();
      db.prepare('INSERT INTO characters (id, name, kind, description, reference_asset_ids, voice, design_tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, cleanName(name, 'Unnamed'), kind, description, JSON.stringify(referenceAssetIds), voice ? JSON.stringify(voice) : null, designTags, now(), now());
      return characters.get(id);
    },
    update(id, { name, kind, description, referenceAssetIds, voice, locked, designTags }) {
      const c = characters.get(id);
      db.prepare('UPDATE characters SET name = ?, kind = ?, description = ?, reference_asset_ids = ?, voice = ?, locked = ?, design_tags = ?, updated_at = ? WHERE id = ?')
        .run(name === undefined ? c.name : cleanName(name, c.name), kind ?? c.kind, description ?? c.description,
          JSON.stringify(referenceAssetIds ?? c.referenceAssetIds), JSON.stringify(voice === undefined ? c.voice : voice),
          locked === undefined ? (c.locked ? 1 : 0) : (locked ? 1 : 0), designTags ?? c.designTags, now(), id);
      return characters.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM characters WHERE id = ?').run(id).changes > 0,
  };

  const sequences = {
    get: (id) => toSequence(db.prepare('SELECT * FROM sequences WHERE id = ?').get(id)),
    listByProject: (projectId) => db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM shots x WHERE x.sequence_id = s.id) AS shot_count
      FROM sequences s WHERE project_id = ? ORDER BY updated_at DESC`).all(projectId).map((r) => ({ ...toSequence(r), shotCount: r.shot_count })),
    create({ projectId, title, idea = '', writer = null, settings = {} }) {
      const id = randomUUID();
      db.prepare('INSERT INTO sequences (id, project_id, title, idea, writer, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, projectId, cleanName(title, 'Untitled storyboard'), idea, writer, JSON.stringify(settings), now(), now());
      touch(projectId);
      return sequences.get(id);
    },
    update(id, { title, idea, writer, settings, outputAssetId, screenplay }) {
      const s = sequences.get(id);
      db.prepare('UPDATE sequences SET title = ?, idea = ?, writer = ?, settings = ?, output_asset_id = ?, screenplay = ?, updated_at = ? WHERE id = ?')
        .run(title === undefined ? s.title : cleanName(title, s.title), idea ?? s.idea, writer === undefined ? s.writer : writer,
          JSON.stringify(settings ?? s.settings), outputAssetId === undefined ? s.outputAssetId : outputAssetId, screenplay ?? s.screenplay, now(), id);
      return sequences.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM sequences WHERE id = ?').run(id).changes > 0,
  };

  const shots = {
    get: (id) => toShot(db.prepare('SELECT * FROM shots WHERE id = ?').get(id)),
    listBySequence: (sequenceId) => db.prepare('SELECT * FROM shots WHERE sequence_id = ? ORDER BY position').all(sequenceId).map(toShot),
    renumber(sequenceId) {
      const ids = db.prepare('SELECT id FROM shots WHERE sequence_id = ? ORDER BY position, created_at').all(sequenceId).map((r) => r.id);
      const set = db.prepare('UPDATE shots SET position = ? WHERE id = ?');
      ids.forEach((shotId, index) => set.run(index + 1, shotId));
    },
    insert(sequenceId, { position, description = '', camera = null, duration = null, details = {} }) {
      const id = randomUUID();
      db.prepare('UPDATE shots SET position = position + 1 WHERE sequence_id = ? AND position >= ?').run(sequenceId, position);
      db.prepare('INSERT INTO shots (id, sequence_id, position, description, camera, duration, details, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, sequenceId, position, description, camera, duration, JSON.stringify(details ?? {}), now(), now());
      return shots.get(id);
    },
    replaceAll(sequenceId, list) {
      db.prepare('DELETE FROM shots WHERE sequence_id = ?').run(sequenceId);
      list.forEach((shot, index) => shots.insert(sequenceId, { ...shot, position: index + 1 }));
      return shots.listBySequence(sequenceId);
    },
    update(id, fields) {
      const s = shots.get(id);
      const pick = (key) => (fields[key] === undefined ? s[key] : fields[key]);
      db.prepare('UPDATE shots SET description = ?, camera = ?, duration = ?, image_asset_id = ?, video_asset_id = ?, details = ?, review = ?, updated_at = ? WHERE id = ?')
        .run(pick('description'), pick('camera'), pick('duration'), pick('imageAssetId'), pick('videoAssetId'),
          JSON.stringify(pick('details') ?? {}), JSON.stringify(pick('review') ?? {}), now(), id);
      return shots.get(id);
    },
    move(id, direction) {
      const s = shots.get(id);
      const neighbour = db.prepare(`SELECT id, position FROM shots WHERE sequence_id = ? AND position ${direction < 0 ? '<' : '>'} ?
        ORDER BY position ${direction < 0 ? 'DESC' : 'ASC'} LIMIT 1`).get(s.sequenceId, s.position);
      if (!neighbour) return s;
      db.prepare('UPDATE shots SET position = ? WHERE id = ?').run(neighbour.position, id);
      db.prepare('UPDATE shots SET position = ? WHERE id = ?').run(s.position, neighbour.id);
      return shots.get(id);
    },
    remove(id) {
      const s = shots.get(id);
      db.prepare('DELETE FROM shots WHERE id = ?').run(id);
      shots.renumber(s.sequenceId);
    },
  };

  const canvasTemplates = {
    list: () => db.prepare('SELECT * FROM canvas_templates ORDER BY name COLLATE NOCASE').all().map(toTemplate),
    get: (id) => toTemplate(db.prepare('SELECT * FROM canvas_templates WHERE id = ?').get(id)),
    create(name, graph) {
      const id = randomUUID();
      db.prepare('INSERT INTO canvas_templates (id, name, graph, created_at) VALUES (?, ?, ?, ?)').run(id, cleanName(name, 'My template'), JSON.stringify(graph), now());
      return canvasTemplates.get(id);
    },
    remove: (id) => db.prepare('DELETE FROM canvas_templates WHERE id = ?').run(id).changes > 0,
  };

  const filmEvents = {
    append: (filmId, revision, kind, data) => db.prepare('INSERT INTO film_events (film_id, revision, at, kind, data) VALUES (?, ?, ?, ?, ?)')
      .run(filmId, revision, now(), kind, JSON.stringify(data)),
    list: (filmId) => db.prepare('SELECT * FROM film_events WHERE film_id = ? ORDER BY id').all(filmId).map((r) => ({
      id: r.id, filmId: r.film_id, revision: r.revision, at: r.at, kind: r.kind, data: parse(r.data, {}),
    })),
  };
  const toFilm = (r) => r && ({
    id: r.id, sequenceId: r.sequence_id, brief: parse(r.brief, {}), policy: parse(r.policy, {}), revision: r.revision,
    state: r.state, pauseReason: r.pause_reason, leaseOwner: r.lease_owner, leaseExpiresAt: r.lease_expires_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  });
  const appendFilmEvents = (film, events, at) => {
    const insert = db.prepare('INSERT INTO film_events (film_id, revision, at, kind, data) VALUES (?, ?, ?, ?, ?)');
    for (const event of events) insert.run(film.id, film.revision, at, event.kind, JSON.stringify(event.data ?? {}));
  };
  const films = {
    get: (id) => toFilm(db.prepare('SELECT * FROM films WHERE id = ?').get(id)),
    bySequence: (id) => toFilm(db.prepare('SELECT * FROM films WHERE sequence_id = ?').get(id)),
    open(sequenceId, { brief = {}, policy = {}, at = now() } = {}) {
      return transaction(db, () => {
        const existing = films.bySequence(sequenceId);
        if (existing) return existing;
        const id = randomUUID();
        db.prepare('INSERT INTO films (id, sequence_id, brief, policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(id, sequenceId, JSON.stringify(brief), JSON.stringify(policy), at, at);
        const film = films.get(id);
        appendFilmEvents(film, [{ kind: 'checkpoint', data: { stage: 'plan', phase: 'opened' } }], at);
        return film;
      });
    },
    acquire(id, owner, ttlMs, at = now()) {
      const expires = new Date(Date.parse(at) + ttlMs).toISOString();
      return db.prepare(`UPDATE films SET lease_owner = ?, lease_expires_at = ?
        WHERE id = ? AND (lease_owner IS NULL OR lease_expires_at <= ? OR lease_owner = ?)`)
        .run(owner, expires, id, at, owner).changes > 0;
    },
    release: (id, owner) => db.prepare('UPDATE films SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?')
      .run(id, owner).changes > 0,
    // Fence every transition and its events with one CAS under the SQLite write lock.
    commit(id, { expectedRevision, owner = null, at = now(), state, pauseReason, brief, policy }, events = []) {
      return transaction(db, () => {
        const old = films.get(id);
        if (!old || old.revision !== expectedRevision) return null;
        const changed = db.prepare(`UPDATE films SET revision = revision + 1, state = ?, pause_reason = ?, brief = ?, policy = ?, updated_at = ?
          WHERE id = ? AND revision = ? AND (? IS NULL OR (lease_owner = ? AND lease_expires_at > ?))`)
          .run(state ?? old.state, pauseReason === undefined ? old.pauseReason : pauseReason,
            JSON.stringify(brief ?? old.brief), JSON.stringify(policy ?? old.policy), at, id, expectedRevision, owner, owner, at);
        if (!changed.changes) return null;
        const film = films.get(id);
        appendFilmEvents(film, events, at);
        return film;
      });
    },
    edit(id, { expectedRevision, brief, policy, at = now() }) {
      const latest = new Map();
      for (const e of filmEvents.list(id).filter((e) => e.kind === 'finding' && e.data.source === 'brief')) latest.set(e.data.id, e.data);
      const resolved = [...latest.values()].filter((f) => !f.resolved).map((f) => ({ kind: 'finding', data: { ...f, resolved: true, reason: 'Brief/policy edited; re-evaluate at delivery.' } }));
      return films.commit(id, { expectedRevision, brief, policy, at, state: 'plan', pauseReason: null },
        [{ kind: 'edit', data: { brief, policy } }, ...resolved, { kind: 'checkpoint', data: { stage: 'plan', phase: 'edited' } }]);
    },
  };

  // Canon accessors never expose updates to historical documents or job snapshots.
  const canonHeads = {
    get: (id) => {
      const r = db.prepare('SELECT * FROM film_canons WHERE sequence_id = ?').get(id);
      return r && { storyboardId: r.sequence_id, revision: r.revision, locked: Boolean(r.locked), lockReason: r.lock_reason, createdAt: r.created_at, updatedAt: r.updated_at };
    },
    create(id) {
      db.prepare('INSERT INTO film_canons (sequence_id, revision, created_at, updated_at) VALUES (?, 1, ?, ?)').run(id, now(), now());
    },
    advance: (id, expectedRevision) => db.prepare('UPDATE film_canons SET revision = revision + 1, updated_at = ? WHERE sequence_id = ? AND revision = ? AND locked = 0')
      .run(now(), id, expectedRevision).changes > 0,
    lock: (id, locked, reason) => db.prepare('UPDATE film_canons SET locked = ?, lock_reason = ?, updated_at = ? WHERE sequence_id = ?')
      .run(locked ? 1 : 0, reason, now(), id),
  };
  const canonRevisions = {
    get: (id, revision) => {
      const r = db.prepare('SELECT * FROM canon_revisions WHERE sequence_id = ? AND revision = ?').get(id, revision);
      return r && { storyboardId: r.sequence_id, revision: r.revision, canon: parse(r.document, {}), globals: parse(r.globals, {}), referenceRevisions: parse(r.reference_revisions, []), source: r.source, createdAt: r.created_at };
    },
    insert(id, revision, { canon, globals, referenceRevisions, source }) {
      db.prepare('INSERT INTO canon_revisions (sequence_id, revision, document, globals, reference_revisions, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, revision, JSON.stringify(canon), JSON.stringify(globals), JSON.stringify(referenceRevisions), source, now());
    },
  };
  const canonEvents = {
    append(id, revision, action, data) {
      db.prepare('INSERT INTO canon_events (sequence_id, revision, action, data, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, revision, action, JSON.stringify(data), now());
    },
    list: (id) => db.prepare('SELECT * FROM canon_events WHERE sequence_id = ? ORDER BY id').all(id).map((r) => ({ id: r.id, revision: r.revision, action: r.action, data: parse(r.data, {}), createdAt: r.created_at })),
  };
  const canonSnapshots = {
    get: (id) => {
      const r = db.prepare('SELECT * FROM canon_snapshots WHERE id = ?').get(id);
      return r && { id: r.id, storyboardId: r.sequence_id, revision: r.revision, hash: r.hash, ...parse(r.payload, {}), createdAt: r.created_at };
    },
    insert({ id, storyboardId, revision, hash, ...payload }) {
      db.prepare('INSERT INTO canon_snapshots (id, sequence_id, revision, hash, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, storyboardId, revision, hash, JSON.stringify(payload), now());
      return canonSnapshots.get(id);
    },
  };

  return { transaction: (fn) => transaction(db, fn), projects, assets, generations, canvases, runs, settings, books, pages, chapters, oauth, characters, sequences, shots, canvasTemplates, spend, approvals, films, filmEvents, canonHeads, canonRevisions, canonEvents, canonSnapshots };
}

const toCharacter = (r) => r && {
  id: r.id, name: r.name, kind: r.kind, description: r.description, referenceAssetIds: parse(r.reference_asset_ids, []),
  voice: parse(r.voice, null), locked: Boolean(r.locked), designTags: r.design_tags ?? '',
  createdAt: r.created_at, updatedAt: r.updated_at,
};
const toSequence = (r) => r && {
  id: r.id, projectId: r.project_id, title: r.title, idea: r.idea, writer: r.writer, settings: parse(r.settings, {}), screenplay: r.screenplay ?? '',
  outputAssetId: r.output_asset_id, createdAt: r.created_at, updatedAt: r.updated_at,
};
const toShot = (r) => r && {
  id: r.id, sequenceId: r.sequence_id, position: r.position, description: r.description, camera: r.camera, duration: r.duration,
  imageAssetId: r.image_asset_id, videoAssetId: r.video_asset_id, details: parse(r.details, {}), review: parse(r.review, {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
};
const toTemplate = (r) => r && { id: r.id, name: r.name, graph: parse(r.graph, { nodes: [], edges: [] }), createdAt: r.created_at };

const toChapter = (r) => r && {
  id: r.id, bookId: r.book_id, position: r.position, title: r.title, summary: r.summary, beats: parse(r.beats, []), text: r.text,
  assetId: r.asset_id, narrationAssetId: r.narration_asset_id, createdAt: r.created_at, updatedAt: r.updated_at,
};

const toBook = (r) => r && {
  id: r.id, projectId: r.project_id, title: r.title, kind: r.kind, brief: parse(r.brief, {}), bible: parse(r.bible, {}),
  writer: r.writer, coverAssetId: r.cover_asset_id, createdAt: r.created_at, updatedAt: r.updated_at,
};
const toPage = (r) => r && {
  id: r.id, bookId: r.book_id, position: r.position, text: r.text, illustrationBrief: r.illustration_brief, assetId: r.asset_id,
  narrationAssetId: r.narration_asset_id, videoAssetId: r.video_asset_id,
  assetPath: r.asset_file ? `/assets/${r.asset_file}` : null, createdAt: r.created_at, updatedAt: r.updated_at,
};

function cleanName(name, fallback) {
  return String(name ?? '').trim().slice(0, 80) || fallback;
}
