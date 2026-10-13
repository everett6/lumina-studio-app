import assert from 'node:assert/strict';
import test from 'node:test';
import { startTestApp } from './helpers.js';

test('closing the app drains queued jobs before closing SQLite, with completed assets intact on restart', async () => {
  const t = await startTestApp();
  const project = (await t.call('POST','/api/projects',{name:'shutdown regression'})).body.project;
  const ids = [];
  for (let i=0; i<5; i++) {
    const g=t.app.generations.submit({projectId:project.id,prompt:`frame ${i}`,provider:'mock',model:'mock-image'});
    ids.push(g.id);
  }
  await t.close({keep:true});
  const again = await startTestApp({dataRoot:t.dataRoot});
  try {
    for (const id of ids) {
      const g=(await again.call('GET',`/api/generations/${id}`)).body.generation;
      assert.equal(g.status,'completed');
      assert.ok(g.assetId);
      assert.equal((await fetch(`${again.app.origin}${g.assetPath}`,{headers:{authorization:`Bearer ${again.app.token}`}})).status,200);
    }
  } finally { await again.close(); }
});

test('closing during a background upscale waits for the enhanced asset to be saved', {timeout:60000}, async () => {
  const t=await startTestApp();
  const project=(await t.call('POST','/api/projects',{name:'enhance shutdown'})).body.project;
  const queued=(await t.call('POST','/api/generate',{projectId:project.id,prompt:'sunset',provider:'mock',model:'mock-video',operation:'video',duration:4})).body.generation;
  const g=(await t.call('POST',`/api/generations/${queued.id}/wait`,{timeoutMs:10000})).body.generation;
  const response=await t.call('POST',`/api/assets/${g.assetId}/enhance`,{mode:'fast'});
  assert.equal(response.status,202,JSON.stringify(response.body));
  await t.close({keep:true});
  const again=await startTestApp({dataRoot:t.dataRoot});
  try {
    const enhanced=again.app.repo.assets.listByProject(project.id).find(a=>a.parentAssetId===g.assetId);
    assert.ok(enhanced,'enhanced asset must be committed before SQLite closes');
  } finally {await again.close();}
});
