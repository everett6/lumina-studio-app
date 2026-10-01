import assert from 'node:assert/strict';
import test from 'node:test';
import openai from '../src/providers/openai.js';
import fal from '../src/providers/fal.js';
import gemini from '../src/providers/gemini.js';
import replicate from '../src/providers/replicate.js';
import { userMessage } from '../src/providers/http.js';
import { fakeFetch, tinyPng } from './helpers.js';

const png = tinyPng();
const b64 = png.toString('base64');
const image = { mime: 'image/png', bytes: png };

test('openai: JSON generation and multipart edit with image[]', async () => {
  const fake = fakeFetch(() => ({ body: { data: [{ b64_json: b64 }], usage: { total_tokens: 5 } } }));
  try {
    const out = await openai.run({ key: 'k', model: 'gpt-image-2.5-flare', prompt: 'p', size: '1024x1024', quality: 'low', images: [] });
    assert.deepEqual(out.bytes, png);
    assert.equal(fake.calls[0].url, 'https://api.openai.com/v1/images/generations');
    assert.equal(JSON.parse(fake.calls[0].options.body).model, 'gpt-image-2.5-flare');
    await openai.run({ key: 'k', model: 'gpt-image-2.5-flare', prompt: 'p', size: '1024x1024', quality: 'low', images: [image, image] });
    assert.equal(fake.calls[1].url, 'https://api.openai.com/v1/images/edits');
    assert.equal(fake.calls[1].options.body.getAll('image[]').length, 2);
  } finally {
    fake.restore();
  }
});

test('openai: 401 becomes an auth error with a friendly message', async () => {
  const fake = fakeFetch(() => ({ status: 401, body: { error: { message: 'Incorrect API key' } } }));
  try {
    await assert.rejects(openai.run({ key: 'bad', model: 'm', prompt: 'p', size: '1024x1024', quality: 'low', images: [] }), (error) => {
      assert.equal(error.category, 'auth');
      assert.match(userMessage(error), /rejected the API key/);
      return true;
    });
  } finally {
    fake.restore();
  }
});

test('fal: submits to the queue, polls status, downloads the result', async () => {
  const fake = fakeFetch((url) => {
    if (url === 'https://queue.fal.run/fal-ai/flux-pro/kontext') return { body: { request_id: 'r', status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' } };
    if (url === 'https://queue.fal.run/s') return { body: { status: 'COMPLETED' } };
    if (url === 'https://queue.fal.run/r') return { body: { images: [{ url: 'https://fal.media/out.png' }] } };
    if (url === 'https://fal.media/out.png') return { body: png };
    return { status: 500 };
  });
  try {
    const out = await fal.run({ key: 'k', model: 'fal-ai/flux-pro/kontext', prompt: 'p', size: '1536x1024', images: [image] });
    assert.deepEqual(out.bytes, png);
    const input = JSON.parse(fake.calls[0].options.body);
    assert.equal(input.aspect_ratio, '3:2');
    assert.match(input.image_url, /^data:image\/png;base64,/);
    assert.equal(fake.calls[0].options.headers.authorization, 'Key k');
  } finally {
    fake.restore();
  }
});

test('fal: image tools send each endpoint its own input and read image or images[0]', async () => {
  const fake = fakeFetch((url) => {
    if (/^https:\/\/queue\.fal\.run\/fal-ai\/(esrgan|birefnet\/v2|flux-pro\/v1\/fill)$/.test(url)) return { body: { status_url: 'https://queue.fal.run/s', response_url: `https://queue.fal.run/r?m=${url.includes('fill') ? 'fill' : 'one'}` } };
    if (url === 'https://queue.fal.run/s') return { body: { status: 'COMPLETED' } };
    if (url === 'https://queue.fal.run/r?m=one') return { body: { image: { url: 'https://fal.media/out.png' } } };
    if (url === 'https://queue.fal.run/r?m=fill') return { body: { images: [{ url: 'https://fal.media/out.png' }] } };
    if (url === 'https://fal.media/out.png') return { body: png };
    return { status: 500 };
  });
  const submitted = (model) => JSON.parse(fake.calls.find((c) => c.url === `https://queue.fal.run/${model}`).options.body);
  try {
    for (const m of ['fal-ai/esrgan', 'fal-ai/birefnet/v2', 'fal-ai/flux-pro/v1/fill']) assert.ok(fal.models.some((x) => x.id === m), m);
    assert.deepEqual((await fal.tool({ key: 'k', model: 'fal-ai/esrgan', operation: 'upscale', image, scale: 4, prompt: 'Upscale' })).bytes, png);
    assert.deepEqual({ ...submitted('fal-ai/esrgan'), image_url: 'x' }, { image_url: 'x', scale: 4, output_format: 'png' });
    await fal.tool({ key: 'k', model: 'fal-ai/birefnet/v2', operation: 'remove-background', image, prompt: 'Remove background' });
    assert.deepEqual(Object.keys(submitted('fal-ai/birefnet/v2')).sort(), ['image_url', 'output_format']);
    assert.deepEqual((await fal.tool({ key: 'k', model: 'fal-ai/flux-pro/v1/fill', operation: 'inpaint', image, mask: image, prompt: 'a red door' })).bytes, png);
    const fill = submitted('fal-ai/flux-pro/v1/fill');
    assert.equal(fill.prompt, 'a red door');
    assert.match(fill.mask_url, /^data:image\/png;base64,/);
  } finally {
    fake.restore();
  }
});

test('gemini: finds the image inside interaction steps and sends inline inputs', async () => {
  const fake = fakeFetch(() => ({ body: { id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'ok' }, { type: 'image', mime_type: 'image/png', data: b64 }] }] } }));
  try {
    const out = await gemini.run({ key: 'k', model: 'gemini-3.1-flash-image', prompt: 'p', size: '1024x1536', images: [image] });
    assert.deepEqual(out.bytes, png);
    const body = JSON.parse(fake.calls[0].options.body);
    assert.equal(body.response_format.aspect_ratio, '2:3');
    assert.equal(body.input[1].type, 'image');
    assert.equal(fake.calls[0].options.headers['x-goog-api-key'], 'k');
  } finally {
    fake.restore();
  }
});

test('gemini: a response without an image is reported as a policy refusal', async () => {
  const fake = fakeFetch(() => ({ body: { id: 'i1', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'no' }] }] } }));
  try {
    await assert.rejects(gemini.run({ key: 'k', model: 'gemini-3.1-flash-image', prompt: 'p', size: '1024x1024', images: [] }), { category: 'policy' });
  } finally {
    fake.restore();
  }
});

test('replicate: waits, polls when still processing, and handles array output', async () => {
  const fake = fakeFetch((url) => {
    if (url.endsWith('/predictions')) return { body: { status: 'processing', urls: { get: 'https://api.replicate.com/v1/predictions/x' } } };
    if (url.endsWith('/predictions/x')) return { body: { status: 'succeeded', output: ['https://replicate.delivery/out.png'] } };
    if (url === 'https://replicate.delivery/out.png') return { body: png };
    return { status: 500 };
  });
  try {
    const out = await replicate.run({ key: 'k', model: 'black-forest-labs/flux-schnell', prompt: 'p', size: '1024x1024', images: [] });
    assert.deepEqual(out.bytes, png);
    assert.equal(fake.calls[0].options.headers.prefer, 'wait=60');
    assert.equal(JSON.parse(fake.calls[0].options.body).input.aspect_ratio, '1:1');
  } finally {
    fake.restore();
  }
});

test('rate limits and non-https result URLs are categorized', async () => {
  const limited = fakeFetch(() => ({ status: 429, body: { detail: 'Too many requests' } }));
  try {
    await assert.rejects(replicate.run({ key: 'k', model: 'black-forest-labs/flux-schnell', prompt: 'p', size: '1024x1024', images: [] }), { category: 'rate_limit' });
  } finally {
    limited.restore();
  }
  const insecure = fakeFetch(() => ({ body: { status: 'succeeded', output: 'http://insecure.example/out.png' } }));
  try {
    await assert.rejects(replicate.run({ key: 'k', model: 'black-forest-labs/flux-schnell', prompt: 'p', size: '1024x1024', images: [] }), /non-HTTPS/);
  } finally {
    insecure.restore();
  }
});
