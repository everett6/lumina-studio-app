import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startTestApp } from './helpers.js';

const serverPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../mcp/server.js');
const parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
const names = ['create_film_canon', 'get_film_canon', 'update_canon', 'lock_canon', 'unlock_canon', 'canon_diff', 'canon_affected_shots', 'invalidate_affected_approvals', 'canon_snapshot_for_job', 'canon_sync_from_globals'];

test('versioned film canon over MCP', async (t) => {
  const app = await startTestApp();
  const client = new Client({ name: 'canon-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, LUMINA_DATA_DIR: app.dataRoot }, stderr: 'ignore' }));
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const good = async (name, args) => { const r = await call(name, args); assert.ok(!r.isError, r.content?.[0]?.text); return parse(r); };
  try {
    const repo = app.app.repo;
    const hero = repo.characters.create({ name: 'Aiko', description: 'Red hair', designTags: 'red hair, green eyes' });
    const bridge = repo.characters.create({ name: 'Bridge', kind: 'location', description: 'River on the east' });
    const project = await good('create_project', { name: 'Canon' });
    const board = await good('create_storyboard', { projectId: project.id, title: 'Bridge duel', idea: 'A duel', plan: false, characterIds: [hero.id, bridge.id], look: 'anime', imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' });
    const args = { storyboardId: board.id };
    await good('start_film', args);
    await good('import_shot_plan', { ...args, shots: [
      { description: 'Aiko on bridge', duration: 3, details: { characterIds: [hero.id], locationId: bridge.id } },
      { description: 'An empty field', duration: 3, details: {} },
      { description: 'A gloved hand holds the sword', duration: 3, details: {} },
    ] });
    const shots = repo.shots.listBySequence(board.id);
    await good('set_scene_state', { shotId: shots[0].id, start: { characters: [{ id: hero.id, wardrobe: 'kimono', props: { held: ['sword'] } }], location: bridge.id }, end: { characters: [{ id: hero.id, wardrobe: 'coat' }] } });
    await good('set_scene_state', { shotId: shots[2].id, start: { characters: [{ id: 'extra', wardrobe: 'kimono', props: { held: ['sword'] } }] }, end: {} });
    let canon;
    await t.test('all ten tools expose titles, descriptions and schemas', async () => {
      const list = (await client.listTools()).tools;
      for (const name of names) { const tool = list.find((x) => x.name === name); assert.ok(tool, name); assert.ok(tool.title && tool.description && tool.inputSchema); }
    });
    await t.test('creation seeds a stable revision and refuses duplicate creation', async () => {
      canon = await good('create_film_canon', args);
      assert.equal(canon.revision, 1);
      assert.equal(canon.canon.characters[0].id, hero.id);
      assert.equal(canon.canon.characters[0].designTags, hero.designTags);
      assert.equal(canon.canon.locations[0].id, bridge.id);
      assert.equal(canon.canon.style.look, 'anime');
      const duplicate = await call('create_film_canon', args);
      assert.equal(duplicate.isError, true);
    });
    await t.test('updates create explicit revisions and retain full film bible fields', async () => {
      const character = { ...canon.canon.characters[0], identity: 'Aiko, heir of the bridge', proportions: 'Seven heads tall', hair: 'red', eyes: 'green', distinguishingFeatures: ['left cheek scar'], wardrobeVariants: [{ id: 'kimono', description: 'Blue silk', allowedWhen: ['duel'] }], voice: { provider: 'mock', model: 'mock-speech', voice: 'aiko' } };
      canon = await good('update_canon', { ...args, expectedRevision: 1, patch: { characters: [character], props: [{ id: 'sword', owner: hero.id, description: 'Notched steel' }], storyFacts: { relationships: ['Aiko guards the bridge'], motivations: ['protect home'], prohibitedContradictions: ['Aiko cannot swim'], setupPayoffs: [{ setup: 'Notched blade', payoff: 'Blade breaks' }] } } });
      assert.equal(canon.revision, 2);
      assert.equal(canon.canon.characters[0].hair, 'red');
      assert.equal((await good('get_film_canon', { ...args, revision: 1 })).canon.props.length, 0);
      assert.deepEqual((await good('get_film_canon', args)).canon, canon.canon);
    });
    await t.test('stale writes return HTTP 409 and unknown fields are rejected', async () => {
      assert.equal((await call('update_canon', { ...args, expectedRevision: 1, patch: { style: { look: 'live-action' } } })).isError, true);
      assert.equal((await app.call('PATCH', `/api/storyboards/${board.id}/canon`, { expectedRevision: 1, patch: { style: { look: 'live-action' } } })).status, 409);
      assert.equal((await app.call('PATCH', `/api/storyboards/${board.id}/canon`, { expectedRevision: 2, patch: { revision: 99 } })).status, 400);
      assert.equal((await good('get_film_canon', args)).revision, 2);
    });
    await t.test('locks block updates and global sync; explicit reasons are journaled', async () => {
      assert.equal((await good('lock_canon', { ...args, reason: 'Approved model bible' })).locked, true);
      assert.equal((await call('update_canon', { ...args, expectedRevision: 2, patch: { style: { look: 'live-action' } } })).isError, true);
      assert.equal((await call('canon_sync_from_globals', { ...args, apply: true })).isError, true);
      assert.equal((await good('unlock_canon', { ...args, reason: 'Revise the hair' })).locked, false);
      const journal = await good('get_film_journal', args);
      assert.ok(journal.events.some((e) => e.data.action === 'lock_canon' && e.data.reason === 'Approved model bible'));
      assert.ok(journal.events.some((e) => e.data.action === 'unlock_canon'));
    });
    await t.test('diffs and affected shots include characters, locations, props and wardrobe', async () => {
      const diff = await good('canon_diff', { ...args, fromRevision: 1, toRevision: 2 });
      assert.ok(diff.changes.some((c) => c.section === 'characters' && c.id === hero.id));
      const affected = await good('canon_affected_shots', { ...args, fromRevision: 1, toRevision: 2 });
      assert.deepEqual(affected.shots.map((s) => s.shotId), shots.map((s) => s.id), 'story facts can affect every shot');
      for (const [change, expected] of [
        // Shots 2 and 3 have no cast of their own, so generation draws them with the storyboard cast (Aiko, Bridge).
        [{ section: 'characters', id: hero.id }, shots.map((s) => s.id)],
        [{ section: 'locations', id: bridge.id }, shots.map((s) => s.id)],
        [{ section: 'props', id: 'sword' }, [shots[0].id, shots[2].id]],
        [{ section: 'wardrobe', characterId: hero.id, id: 'coat' }, [shots[0].id]],
        [{ section: 'style' }, shots.map((s) => s.id)],
      ]) assert.deepEqual((await good('canon_affected_shots', { ...args, change })).shots.map((s) => s.shotId), expected);
    });
    await t.test('approval invalidation resets real frame and clip approvals explicitly', async () => {
      // Seed media, then use the real review API to approve it before invalidating through MCP.
      const generated = await good('generate_shot', { shotId: shots[0].id, kind: 'frame', provider: 'mock', model: 'mock-image' });
      const asset = repo.assets.get(generated.assetId);
      assert.ok(asset);
      repo.shots.update(shots[0].id, { videoAssetId: asset.id });
      await good('review_shot', { shotId: shots[0].id, approveFrame: true, status: 'accepted' });
      assert.equal(repo.shots.get(shots[0].id).review.frameApproved, asset.id);
      assert.equal(repo.shots.get(shots[0].id).review.status, 'accepted');
      const result = await good('invalidate_affected_approvals', { ...args, revision: 2 });
      assert.equal(result.changed.length, 1);
      assert.equal(result.changed[0].before.frameApproved, asset.id);
      assert.equal(result.changed[0].after.frameApproved, null);
      assert.equal(repo.shots.get(shots[0].id).review.frameApproved, null);
      assert.equal(repo.shots.get(shots[0].id).review.status, 'pending');
      assert.equal((await good('invalidate_affected_approvals', { ...args, revision: 2 })).changed.length, 0);
    });
    let snapshot;
    await t.test('job snapshots are stored, hashed and immutable in SQLite', async () => {
      snapshot = await good('canon_snapshot_for_job', args);
      assert.ok(snapshot.id);
      assert.match(snapshot.hash, /^[0-9a-f]{64}$/);
      assert.equal(snapshot.revision, 2);
      assert.ok(snapshot.referenceRevisions.length >= 2);
      assert.equal(snapshot.hash, createHash('sha256').update(snapshot.hashInput).digest('hex'));
      const db = new DatabaseSync(path.join(app.dataRoot, 'data', 'lumina.db'));
      try {
        const saved = db.prepare('SELECT * FROM canon_snapshots WHERE id = ?').get(snapshot.id);
        assert.ok(saved);
        assert.throws(() => db.prepare('UPDATE canon_snapshots SET hash = ? WHERE id = ?').run('tampered', snapshot.id), /immutable/);
        assert.throws(() => db.prepare('DELETE FROM canon_snapshots WHERE id = ?').run(snapshot.id), /immutable/);
      } finally { db.close(); }
    });
    await t.test('global edits never silently change canon; explicit sync makes a revision', async () => {
      await good('update_character', { characterId: hero.id, description: 'Silver hair', designTags: 'silver hair, green eyes' });
      assert.equal((await good('get_film_canon', args)).canon.characters[0].description, 'Red hair');
      const dry = await good('canon_sync_from_globals', args);
      assert.equal(dry.applied, false);
      assert.ok(dry.changes.some((c) => c.id === hero.id));
      assert.equal((await good('get_film_canon', args)).revision, 2);
      const sync = await good('canon_sync_from_globals', { ...args, apply: true });
      assert.equal(sync.applied, true);
      assert.equal(sync.revision, 3);
      const current = await good('get_film_canon', args);
      assert.equal(current.canon.characters[0].description, 'Silver hair');
      assert.equal(current.canon.characters[0].wardrobeVariants[0].id, 'kimono');
      assert.equal((await good('get_film_canon', { ...args, revision: 2 })).canon.characters[0].description, 'Red hair');
      assert.equal((await good('canon_sync_from_globals', args)).changes.length, 0);
      const next = await good('canon_snapshot_for_job', args);
      assert.notEqual(next.hash, snapshot.hash);
      assert.equal(repo.canonSnapshots.get(snapshot.id).hash, snapshot.hash);
    });
    await t.test('sync previews actual canon/global divergence even when globals did not change', async () => {
      const current = await good('get_film_canon', args);
      const characters = current.canon.characters.map((c) => ({ ...c, description: 'Film-specific description' }));
      await good('update_canon', { ...args, expectedRevision: 3, patch: { characters } });
      const preview = await good('canon_sync_from_globals', args);
      assert.ok(preview.changes.some((c) => c.id === hero.id && c.before.description === 'Film-specific description' && c.after.description === 'Silver hair'));
      assert.equal((await good('get_film_canon', args)).canon.characters[0].description, 'Film-specific description');
      const applied = await good('canon_sync_from_globals', { ...args, apply: true });
      assert.equal(applied.revision, 5);
      assert.equal((await good('get_film_canon', args)).canon.characters[0].description, 'Silver hair');
    });
    await t.test('seeding discovers global products held only in scene state', async () => {
      const prop = repo.characters.create({ name: 'Lantern', kind: 'product', description: 'Brass lantern' });
      const b = await good('create_storyboard', { projectId: project.id, title: 'Props', idea: 'A lantern', plan: false });
      await good('import_shot_plan', { storyboardId: b.id, shots: [{ description: 'A hand holds a lantern', duration: 3, details: {} }] });
      const shot = repo.shots.listBySequence(b.id)[0];
      await good('set_scene_state', { shotId: shot.id, start: { characters: [{ id: 'extra', props: { held: [prop.id] } }] }, end: {} });
      const seeded = await good('create_film_canon', { storyboardId: b.id });
      assert.equal(seeded.canon.props[0]?.id, prop.id);
      await good('update_character', { characterId: prop.id, description: 'Dented brass lantern' });
      assert.ok((await good('canon_sync_from_globals', { storyboardId: b.id })).changes.some((c) => c.id === prop.id));
    });
    await t.test('wardrobe-only revisions target the variant owner and leave unrelated approvals intact', async () => {
      const current = await good('get_film_canon', args);
      const characters = current.canon.characters.map((c) => ({ ...c, wardrobeVariants: [{ ...c.wardrobeVariants[0], description: 'Torn blue silk' }] }));
      const updated = await good('update_canon', { ...args, expectedRevision: current.revision, patch: { characters } });
      const report = await good('canon_affected_shots', { ...args, fromRevision: current.revision, toRevision: updated.revision });
      assert.deepEqual(report.shots.map((s) => s.shotId), [shots[0].id]);
      const image = repo.shots.get(shots[0].id).imageAssetId;
      repo.shots.update(shots[1].id, { imageAssetId: image, videoAssetId: image });
      await good('review_shot', { shotId: shots[0].id, approveFrame: true, status: 'accepted' });
      await good('review_shot', { shotId: shots[1].id, approveFrame: true, status: 'accepted' });
      const reset = await good('invalidate_affected_approvals', { ...args, revision: updated.revision });
      assert.deepEqual(reset.changed.map((s) => s.shotId), [shots[0].id]);
      assert.equal(repo.shots.get(shots[1].id).review.frameApproved, image);
      assert.equal(repo.shots.get(shots[1].id).review.status, 'accepted');
    });
    await t.test('concurrent updates permit exactly one writer at the expected revision', async () => {
      const current = await good('get_film_canon', args);
      const results = await Promise.all(['warm', 'cool'].map((color) => app.call('PATCH', `/api/storyboards/${board.id}/canon`, { expectedRevision: current.revision, patch: { style: { palette: [color] } } })));
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
      assert.equal((await good('get_film_canon', args)).revision, current.revision + 1);
    });
    await t.test('reference revisions and snapshots survive later global/asset changes and reopened connections', async () => {
      const current = await good('get_film_canon', args);
      const image = repo.shots.get(shots[0].id).imageAssetId;
      const characters = current.canon.characters.map((c) => ({ ...c, approvedReferenceAssetIds: [image] }));
      const updated = await good('update_canon', { ...args, expectedRevision: current.revision, patch: { characters } });
      const frozen = await good('canon_snapshot_for_job', args);
      assert.ok(frozen.referenceRevisions.some((r) => r.type === 'asset' && r.id === image && r.record.id === image));
      await good('update_character', { characterId: hero.id, description: 'A later global version' });
      const repeated = await good('canon_snapshot_for_job', args);
      assert.notEqual(frozen.id, repeated.id);
      assert.equal(repeated.hash, frozen.hash, 'a global edit cannot change an existing canon or its references');
      const db = new DatabaseSync(path.join(app.dataRoot, 'data', 'lumina.db'));
      try {
        assert.equal(db.prepare('SELECT hash FROM canon_snapshots WHERE id = ?').get(frozen.id).hash, frozen.hash);
        assert.throws(() => db.prepare('UPDATE canon_revisions SET document = ? WHERE sequence_id = ? AND revision = ?').run('{}', board.id, updated.revision), /immutable/);
        assert.throws(() => db.prepare('DELETE FROM canon_revisions WHERE sequence_id = ? AND revision = ?').run(board.id, updated.revision), /immutable/);
        const event = db.prepare('SELECT id FROM canon_events WHERE sequence_id = ? LIMIT 1').get(board.id);
        assert.throws(() => db.prepare('UPDATE canon_events SET action = ? WHERE id = ?').run('tampered', event.id), /append-only/);
      } finally { db.close(); }
    });
    await t.test('malformed requests and revision references fail without mutation', async () => {
      const current = await good('get_film_canon', args);
      for (const body of [
        { expectedRevision: current.revision, patch: { props: [{ id: 'p', description: 'no owner' }] } },
        { expectedRevision: current.revision, patch: { characters: [current.canon.characters[0], current.canon.characters[0]] } },
        { expectedRevision: 0, patch: {} },
      ]) assert.equal((await app.call('PATCH', `/api/storyboards/${board.id}/canon`, body)).status, 400);
      assert.equal((await call('canon_affected_shots', args)).isError, true);
      assert.equal((await call('canon_affected_shots', { ...args, change: { section: 'characters' } })).isError, true);
      assert.equal((await call('canon_diff', { ...args, fromRevision: 1, toRevision: 999 })).isError, true);
      assert.equal((await app.call('POST', `/api/storyboards/${board.id}/canon/lock`, { reason: ' ' })).status, 400);
      assert.equal((await good('get_film_canon', args)).revision, current.revision);
    });
    await t.test('canon without a film controller still records locks and cascades with its storyboard', async () => {
      const b = await good('create_storyboard', { projectId: project.id, title: 'No controller', idea: 'A quiet room', plan: false });
      await good('create_film_canon', { storyboardId: b.id });
      await good('lock_canon', { storyboardId: b.id, reason: 'Final' });
      assert.ok(repo.canonEvents.list(b.id).some((e) => e.action === 'lock_canon' && e.data.reason === 'Final'));
      const frozen = await good('canon_snapshot_for_job', { storyboardId: b.id });
      assert.equal((await app.call('DELETE', `/api/storyboards/${b.id}`)).status, 200);
      assert.equal(repo.canonSnapshots.get(frozen.id), undefined);
      assert.equal(repo.canonHeads.get(b.id), undefined);
    });
  } finally { await client.close(); await app.close(); }
});
