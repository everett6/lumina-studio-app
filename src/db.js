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
  `CREATE TABLE characters (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     kind TEXT NOT NULL DEFAULT 'character',
     description TEXT NOT NULL DEFAULT '',
     reference_asset_ids TEXT NOT NULL DEFAULT '[]',
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE sequences (
     id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
     title TEXT NOT NULL,
     idea TEXT NOT NULL DEFAULT '',
     writer TEXT,
     settings TEXT NOT NULL DEFAULT '{}',
     output_asset_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX sequences_project ON sequences(project_id, updated_at DESC);
   CREATE TABLE shots (
     id TEXT PRIMARY KEY,
     sequence_id TEXT NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
     position INTEGER NOT NULL,
     description TEXT NOT NULL DEFAULT '',
     camera TEXT,
     duration INTEGER,
     image_asset_id TEXT,
     video_asset_id TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX shots_sequence ON shots(sequence_id, position);
   CREATE TABLE canvas_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, graph TEXT NOT NULL, created_at TEXT NOT NULL);`,
  // 5: spending ledger (kept when projects are deleted), provider job ids for resuming, idempotency keys,
  // approvals for costly or unpriced requests, film details on shots, screenplays, character voices.
  `ALTER TABLE generations ADD COLUMN provider_job TEXT;
   ALTER TABLE generations ADD COLUMN idempotency_key TEXT;
   ALTER TABLE generations ADD COLUMN billing TEXT;
   CREATE UNIQUE INDEX generations_idempotency ON generations(idempotency_key) WHERE idempotency_key IS NOT NULL;
   CREATE TABLE spend_ledger (
     generation_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     provider TEXT NOT NULL,
     model TEXT NOT NULL,
     operation TEXT NOT NULL,
     estimated_usd REAL,
     actual_usd REAL,
     status TEXT NOT NULL,
     note TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE INDEX spend_created ON spend_ledger(created_at);
   CREATE TABLE spend_approvals (
     id TEXT PRIMARY KEY,
     signature TEXT NOT NULL,
     summary TEXT NOT NULL,
     estimated_usd REAL,
     status TEXT NOT NULL,
     requested_by TEXT,
     created_at TEXT NOT NULL,
     decided_at TEXT,
     used_by TEXT
   );
   ALTER TABLE shots ADD COLUMN details TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE shots ADD COLUMN review TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE sequences ADD COLUMN screenplay TEXT NOT NULL DEFAULT '';
   ALTER TABLE characters ADD COLUMN voice TEXT;
   ALTER TABLE characters ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;`,
  `ALTER TABLE characters ADD COLUMN design_tags TEXT NOT NULL DEFAULT '';`,
  // Submission accounting is additive: existing settings, ledger amounts and legacy billing are untouched.
  `ALTER TABLE generations ADD COLUMN billing_state TEXT;
   ALTER TABLE generations ADD COLUMN request_fingerprint TEXT;
   ALTER TABLE generations ADD COLUMN retry_of TEXT;
   UPDATE generations SET billing_state = CASE
     WHEN provider IN ('local', 'mock') THEN 'confirmed_unbilled'
     WHEN billing = 'charged' THEN 'charged'
     WHEN billing = 'none' THEN 'confirmed_unbilled'
     WHEN billing = 'unknown' THEN 'billing_unknown'
     WHEN provider_job IS NOT NULL THEN 'submitted'
     WHEN status = 'queued' THEN 'not_submitted'
     ELSE 'billing_unknown' END;`,
  `CREATE TABLE films (
     id TEXT PRIMARY KEY,
     sequence_id TEXT NOT NULL UNIQUE REFERENCES sequences(id) ON DELETE CASCADE,
     brief TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(brief)),
     policy TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(policy)),
     revision INTEGER NOT NULL DEFAULT 1,
     state TEXT NOT NULL DEFAULT 'plan',
     pause_reason TEXT,
     lease_owner TEXT,
     lease_expires_at TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE film_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     film_id TEXT NOT NULL REFERENCES films(id) ON DELETE CASCADE,
     revision INTEGER NOT NULL,
     at TEXT NOT NULL,
     kind TEXT NOT NULL CHECK(kind IN ('checkpoint','approval','job','finding','repair','delivery','pause','resume','edit')),
     data TEXT NOT NULL CHECK(json_valid(data))
   );
   CREATE INDEX film_events_film ON film_events(film_id, id);
   CREATE TRIGGER film_events_no_update BEFORE UPDATE ON film_events
     BEGIN SELECT RAISE(ABORT, 'film_events is append-only'); END;
   -- Events are never edited; they go only with their film (deleting a storyboard cascades).`,
  // Film canon documents, source baselines and job snapshots are immutable; only the head/lock is mutable.
  `CREATE TABLE film_canons (
     sequence_id TEXT PRIMARY KEY REFERENCES sequences(id) ON DELETE CASCADE,
     revision INTEGER NOT NULL CHECK(revision >= 1),
     locked INTEGER NOT NULL DEFAULT 0 CHECK(locked IN (0, 1)),
     lock_reason TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL
   );
   CREATE TABLE canon_revisions (
     sequence_id TEXT NOT NULL REFERENCES film_canons(sequence_id) ON DELETE CASCADE,
     revision INTEGER NOT NULL CHECK(revision >= 1),
     document TEXT NOT NULL CHECK(json_valid(document)),
     globals TEXT NOT NULL CHECK(json_valid(globals)),
     reference_revisions TEXT NOT NULL CHECK(json_valid(reference_revisions)),
     source TEXT NOT NULL,
     created_at TEXT NOT NULL,
     PRIMARY KEY(sequence_id, revision)
   );
   CREATE TABLE canon_events (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     sequence_id TEXT NOT NULL REFERENCES film_canons(sequence_id) ON DELETE CASCADE,
     revision INTEGER NOT NULL,
     action TEXT NOT NULL,
     data TEXT NOT NULL CHECK(json_valid(data)),
     created_at TEXT NOT NULL
   );
   CREATE INDEX canon_events_sequence ON canon_events(sequence_id, id);
   CREATE TABLE canon_snapshots (
     id TEXT PRIMARY KEY,
     sequence_id TEXT NOT NULL REFERENCES film_canons(sequence_id) ON DELETE CASCADE,
     revision INTEGER NOT NULL,
     hash TEXT NOT NULL,
     payload TEXT NOT NULL CHECK(json_valid(payload)),
     created_at TEXT NOT NULL,
     FOREIGN KEY(sequence_id, revision) REFERENCES canon_revisions(sequence_id, revision)
   );
   CREATE TRIGGER canon_revisions_no_update BEFORE UPDATE ON canon_revisions
     BEGIN SELECT RAISE(ABORT, 'canon revisions are immutable'); END;
   CREATE TRIGGER canon_revisions_no_delete BEFORE DELETE ON canon_revisions
     WHEN EXISTS (SELECT 1 FROM film_canons WHERE sequence_id = OLD.sequence_id)
     BEGIN SELECT RAISE(ABORT, 'canon revisions are immutable'); END;
   CREATE TRIGGER canon_snapshots_no_update BEFORE UPDATE ON canon_snapshots
     BEGIN SELECT RAISE(ABORT, 'canon snapshots are immutable'); END;
   CREATE TRIGGER canon_snapshots_no_delete BEFORE DELETE ON canon_snapshots
     WHEN EXISTS (SELECT 1 FROM film_canons WHERE sequence_id = OLD.sequence_id)
     BEGIN SELECT RAISE(ABORT, 'canon snapshots are immutable'); END;
   CREATE TRIGGER canon_events_no_update BEFORE UPDATE ON canon_events
     BEGIN SELECT RAISE(ABORT, 'canon events are append-only'); END;
   CREATE TRIGGER canon_events_no_delete BEFORE DELETE ON canon_events
     WHEN EXISTS (SELECT 1 FROM film_canons WHERE sequence_id = OLD.sequence_id)
     BEGIN SELECT RAISE(ABORT, 'canon events are append-only'); END;`,
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
