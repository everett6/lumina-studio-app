import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import path from 'node:path';

// Each migration runs once, in order, inside a transaction. Append new entries; never edit old ones.
const migrations = [
  `CREATE TABLE projects (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE assets (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     kind TEXT NOT NULL,
     mime_type TEXT NOT NULL,
     file TEXT NOT NULL,
     size INTEGER NOT NULL,
     label TEXT,
     generation_id TEXT,
     parent_asset_id TEXT,
     created_at TEXT NOT NULL
   );
   CREATE INDEX assets_project ON assets(project_id, created_at DESC);
   CREATE TABLE generations (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     operation TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     prompt TEXT NOT NULL,
     final_prompt TEXT,
     director TEXT,
     params TEXT NOT NULL DEFAULT '{}',
     input_asset_ids TEXT NOT NULL DEFAULT '[]',
     output_asset_id TEXT,
     error_category TEXT,
     user_error TEXT,
     usage TEXT,
     canvas_run_id TEXT,
     node_id TEXT,
     created_at TEXT NOT NULL,
     started_at TEXT,
     completed_at TEXT,
     duration_ms INTEGER
   );
   CREATE INDEX generations_project ON generations(project_id, created_at DESC);
   CREATE INDEX generations_status ON generations(status);
   CREATE TABLE canvases (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     name TEXT NOT NULL,
     graph TEXT NOT NULL,
     version INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE canvas_runs (
     id TEXT PRIMARY KEY,
     canvas_id TEXT NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
     status TEXT NOT NULL,
     node_state TEXT NOT NULL DEFAULT '{}',
     error TEXT,
     created_at TEXT NOT NULL,
     completed_at TEXT
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
  `CREATE TABLE books (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'picture_book',
     brief TEXT NOT NULL DEFAULT '{}',
     bible TEXT NOT NULL DEFAULT '{}',
     writer TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX books_project ON books(project_id, updated_at DESC);
   CREATE TABLE book_pages (
     id TEXT PRIMARY KEY,
     book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     text TEXT NOT NULL DEFAULT '',
     illustration_brief TEXT NOT NULL DEFAULT '',
     asset_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX book_pages_book ON book_pages(book_id, position);
   CREATE TABLE page_revisions (
     id TEXT PRIMARY KEY,
     page_id TEXT NOT NULL REFERENCES book_pages(id) ON DELETE CASCADE,
     text TEXT NOT NULL,
     illustration_brief TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX page_revisions_page ON page_revisions(page_id, created_at DESC);
   ALTER TABLE generations ADD COLUMN book_page_id TEXT;`,
  `CREATE TABLE book_chapters (
     id TEXT PRIMARY KEY,
     book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     title TEXT NOT NULL DEFAULT '',
     summary TEXT NOT NULL DEFAULT '',
     beats TEXT NOT NULL DEFAULT '[]',
     text TEXT NOT NULL DEFAULT '',
     asset_id TEXT,
     narration_asset_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX book_chapters_book ON book_chapters(book_id, position);
   CREATE TABLE chapter_revisions (
     id TEXT PRIMARY KEY,
     chapter_id TEXT NOT NULL REFERENCES book_chapters(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     summary TEXT NOT NULL,
     beats TEXT NOT NULL,
     text TEXT NOT NULL,
     source TEXT NOT NULL,
     created_at TEXT NOT NULL
   );
   CREATE INDEX chapter_revisions_chapter ON chapter_revisions(chapter_id, created_at DESC);
   ALTER TABLE books ADD COLUMN cover_asset_id TEXT;
   ALTER TABLE book_pages ADD COLUMN narration_asset_id TEXT;
   ALTER TABLE book_pages ADD COLUMN video_asset_id TEXT;
   ALTER TABLE generations ADD COLUMN book_target TEXT;
   CREATE INDEX generations_book_target ON generations(book_target);
   CREATE TABLE oauth_clients (client_id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
   CREATE TABLE oauth_tokens (
     token_hash TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     client_id TEXT NOT NULL,
     scopes TEXT NOT NULL DEFAULT '[]',
     resource TEXT,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL
   );`,
];

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations').get().v;
  for (let version = applied + 1; version <= migrations.length; version += 1) {
    transaction(db, () => {
      db.exec(migrations[version - 1]);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
    });
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function readLegacy(dataDir, name) {
  const file = path.join(dataDir, name);
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

// One-time import of the v0.1 JSON stores. Originals are renamed to *.imported, not deleted.
function importLegacyJson(db, dataDir) {
  const names = ['projects.json', 'assets.json', 'generations.json'];
  if (!names.some((name) => existsSync(path.join(dataDir, name)))) return;
  const [projects, assets, generations] = names.map((name) => readLegacy(dataDir, name));
  transaction(db, () => {
    const insertProject = db.prepare('INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)');
    for (const p of projects) insertProject.run(p.id, p.name, p.createdAt, p.updatedAt || p.createdAt);
    const insertAsset = db.prepare(`INSERT OR IGNORE INTO assets (id, project_id, kind, mime_type, file, size, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)`);
    for (const a of assets) {
      insertAsset.run(a.id, a.projectId, a.kind, a.mimeType, path.basename(a.path), a.size, a.createdAt, a.projectId);
    }
    const insertGeneration = db.prepare(`INSERT OR IGNORE INTO generations
      (id, project_id, status, operation, provider, model, prompt, final_prompt, params, output_asset_id,
       error_category, user_error, created_at, completed_at, duration_ms)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM projects WHERE id = ?)`);
    for (const g of generations) {
      const status = g.status === 'processing' ? 'interrupted' : g.status;
      insertGeneration.run(g.id, g.projectId, status, g.operation || 'generate', g.provider || 'openai', g.model || 'unknown',
        g.prompt, g.finalPrompt ?? null, JSON.stringify({ size: g.size, quality: g.quality }), g.assetId ?? null,
        g.errorCategory ?? null, g.userError ?? null, g.createdAt, g.completedAt ?? null, g.durationMs ?? null, g.projectId);
    }
  });
  for (const name of names) {
    const file = path.join(dataDir, name);
    if (existsSync(file)) renameSync(file, `${file}.imported`);
  }
}

export function openDatabase(dataDir) {
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'lumina.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  importLegacyJson(db, dataDir);
  return db;
}
