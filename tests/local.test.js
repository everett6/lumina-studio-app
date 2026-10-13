import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { modelInstalled } from '../src/providers/local.js';
import { startTestApp, tempRoot } from './helpers.js';

test('local GPU provider: ready only when every model file is in the cache; listed as free', async () => {
  const hub = tempRoot();
  const root = path.join(hub, 'models--Wan-AI--Wan2.2-TI2V-5B-Diffusers', 'snapshots', 'abc');
  const put = (file, text = '{}') => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  assert.equal(modelInstalled(hub), false);
  put('model_index.json');
  put('vae/diffusion_pytorch_model.safetensors', 'x');
  put('transformer/diffusion_pytorch_model.safetensors.index.json', '{');
  assert.equal(modelInstalled(hub), false, 'an index still being written is not a server error');
  put('transformer/diffusion_pytorch_model.safetensors.index.json', JSON.stringify({ weight_map: { a: 'diffusion_pytorch_model-00001-of-00002.safetensors', b: 'diffusion_pytorch_model-00002-of-00002.safetensors' } }));
  put('text_encoder/model.safetensors.index.json', JSON.stringify({ weight_map: { a: 'model-00001-of-00001.safetensors' } }));
  put('transformer/diffusion_pytorch_model-00001-of-00002.safetensors', 'x');
  put('text_encoder/model-00001-of-00001.safetensors', 'x');
  assert.equal(modelInstalled(hub), false, 'a shard is still downloading');
  put('transformer/diffusion_pytorch_model-00002-of-00002.safetensors', 'x');
  assert.equal(modelInstalled(hub), true);
  rmSync(hub, { recursive: true, force: true });

  const previous = process.env.HF_HUB_CACHE;
  process.env.HF_HUB_CACHE = tempRoot(); // an empty cache: the model is not installed
  const t = await startTestApp();
  try {
    const local = (await t.call('GET', '/api/catalog')).body.providers.find((p) => p.id === 'local');
    assert.equal(local.ready, false);
    assert.match(local.note, /hf download Wan-AI\/Wan2.2-TI2V-5B-Diffusers/);
    const wan = local.models[0];
    assert.deepEqual(wan.operations, ['generate', 'video']);
    assert.equal(wan.price.usd, 0);
  } finally {
    if (previous === undefined) delete process.env.HF_HUB_CACHE; else process.env.HF_HUB_CACHE = previous;
    await t.close();
  }
});
