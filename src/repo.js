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
  usage: parse(r.usage, null), canvasRunId: r.canvas_run_id, nodeId: r.node_id, bookPageId: r.book_page_id, bookTarget: r.book_target,
  mimeType: r.output_mime ?? null, createdAt: r.created_at,
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
    listByTarget: (target) => db.prepare(`${generationSelect} WHERE g.book_target = ? ORDER BY g.created_at DESC`).all(target).map(toGeneration),
    listByPage: (pageId) => db.prepare(`${generationSelect} WHERE g.book_page_id = ? ORDER BY g.created_at DESC`).all(pageId).map(toGeneration),
    idsWithStatus: (status) => db.prepare('SELECT id FROM generations WHERE status = ? ORDER BY created_at').all(status).map((r) => r.id),
    create(fields) {
      const id = randomUUID();
      db.prepare(`INSERT INTO generations (id, project_id, status, operation, provider, model, prompt, director, params,
        input_asset_ids, canvas_run_id, node_id, book_page_id, book_target, created_at) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, fields.projectId, fields.operation, fields.provider, fields.model, fields.prompt, fields.director ?? null,
          JSON.stringify(fields.params ?? {}), JSON.stringify(fields.inputAssetIds ?? []), fields.canvasRunId ?? null,
          fields.nodeId ?? null, fields.bookPageId ?? null, fields.bookTarget ?? null, now());
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
    }),
  };

  return { projects, assets, generations, canvases, runs, settings, books, pages, chapters, oauth };
}

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
