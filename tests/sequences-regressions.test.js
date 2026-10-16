import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.js';
import { createRepo } from '../src/repo.js';
import { createSequenceService } from '../src/sequences.js';

process.env.LUMINA_NO_NVENC = '1';
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'sequence-regression-'));
  const db = openDatabase(dir), repo = createRepo(db);
  t.after(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = repo.projects.create({ name: 'Synthetic' });
  let count = 0;
  const assetStore = {
    path: (asset) => path.join(dir, asset.file),
    save: async ({ bytes, ...fields }) => {
      const file = `film-${++count}.mp4`;
      writeFileSync(path.join(dir, file), bytes);
      return repo.assets.create({ ...fields, file, size: bytes.length, mimeType: 'video/mp4' });
    },
  };
  const service = createSequenceService({ repo, assetStore });
  const sequence = service.create({ projectId: project.id, title: 'Synthetic', settings: { requireApproval: true, colorMatch: 'off', finish: 'none', outputHeight: 480 } });
  const clip = repo.assets.create({ projectId: project.id, kind: 'video', file: 'clip.mp4', size: 1, mimeType: 'video/mp4' });
  const shot = repo.shots.insert(sequence.id, { position: 1, description: 'Synthetic', duration: 0.5 });
  repo.shots.update(shot.id, { imageAssetId: clip.id, videoAssetId: clip.id, review: { status: 'accepted', assetId: clip.id, frameApproved: clip.id } });
  return { repo, service, sequence, shot, dir };
}

test('completed replacement frame clears clip acceptance and blocks approval-required join', async (t) => {
  const { repo, service, sequence, shot } = fixture(t);
  const frame = repo.assets.create({ projectId: sequence.projectId, kind: 'image', file: 'new-frame.png', size: 1, mimeType: 'image/png' });
  service.onGenerationUpdate({ bookTarget: `shot-image:${shot.id}`, status: 'completed', assetId: frame.id });
  const updated = repo.shots.get(shot.id);
  assert.equal(updated.imageAssetId, frame.id);
  assert.equal(updated.review.frameApproved, null);
  assert.equal(updated.review.status, 'pending');
  assert.equal(updated.videoAssetId, 'clip');
  await assert.rejects(service.stitch(sequence.id), (e) => e.status === 409 && /accept every shot/.test(e.message));
});

test('joined settings fingerprint survives service restart and detects each film setting change', async (t) => {
  const { repo, service, sequence, dir } = fixture(t);
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:r=24:d=0.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(dir, 'clip.mp4')]);
  const joined = await service.stitch(sequence.id, { wait: true });
  assert.equal(joined.sequence.join.state, 'completed', joined.sequence.join.error);
  assert.equal(joined.sequence.joinStale, false);
  const restarted = createSequenceService({ repo });
  assert.equal(restarted.detail(sequence.id).sequence.joinStale, false);
  const baseline = repo.sequences.get(sequence.id).settings;
  const changes = { music: { assetId: 'music', volume: 0.4 }, ambience: { assetId: 'ambience', volume: 0.2 }, clipVolume: 0.5,
    finish: 'cinematic', outputHeight: 720, aspect: '1:1', transition: 'crossfade', colorMatch: 'film', upscale: 'fast', interpolateFps: 30,
    narratorVoice: { provider: 'mock', model: 'speech', voice: 'narrator' } };
  for (const [key, value] of Object.entries(changes)) {
    restarted.update(sequence.id, { settings: { ...baseline, [key]: value } });
    assert.equal(restarted.detail(sequence.id).sequence.joinStale, true, `${key} changes the film`);
    restarted.update(sequence.id, { settings: baseline });
    assert.equal(restarted.detail(sequence.id).sequence.joinStale, false, `${key} restored`);
  }
  restarted.update(sequence.id, { title: 'Renamed', settings: { shotCount: 2 } });
  assert.equal(restarted.detail(sequence.id).sequence.joinStale, false, 'planning metadata does not change the film');
});
