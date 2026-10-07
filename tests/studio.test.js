import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { imageSize } from '../src/assets.js';
import { parseManuscript } from '../src/manuscript.js';
import { createZip, readZip } from '../src/zip.js';
import { startTestApp, tinyPngDataUrl } from './helpers.js';

const has = (command) => spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
const done = async (t, response) => {
  assert.equal(response.status, 202, JSON.stringify(response.body));
  return (await t.call('POST', `/api/generations/${response.body.generation.id}/wait`, { timeoutMs: 20_000 })).body.generation;
};
const bytesOf = async (t, assetPath) => Buffer.from(await (await fetch(`${t.app.origin}${assetPath}`, { headers: { authorization: `Bearer ${t.app.token}` } })).arrayBuffer());

test('characters: saved once, added to image and video prompts, reference photos attached when the model takes them', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Cast' })).body.project;
    const photo = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl(), label: 'mira.png' })).body.asset;
    assert.equal((await t.call('POST', '/api/characters', { description: 'no name' })).status, 400);
    const created = await t.call('POST', '/api/characters', { name: 'Mira', description: 'tall woman, silver braid, red coat', referenceAssetIds: [photo.id] });
    assert.equal(created.status, 201);
    const mira = created.body.character;
    assert.deepEqual(mira.references, [{ id: photo.id, path: photo.path }]);
    assert.equal((await t.call('PATCH', `/api/characters/${mira.id}`, { referenceAssetIds: ['00000000-0000-0000-0000-000000000000'] })).status, 404);

    const base = { projectId: project.id, prompt: 'walking through a market', provider: 'mock' };
    const image = await done(t, await t.call('POST', '/api/generate', { ...base, model: 'mock-image', characterIds: [mira.id] }));
    assert.equal(image.status, 'completed');
    assert.equal(image.operation, 'edit');
    assert.deepEqual(image.inputAssetIds, [photo.id]);
    assert.match(image.finalPrompt, /Mira — tall woman, silver braid, red coat/);
    assert.match(image.finalPrompt, /as shown in the reference image/);

    const video = await done(t, await t.call('POST', '/api/generate', { ...base, model: 'mock-video', operation: 'video', characterIds: [mira.id], presets: ['dolly-in'] }));
    assert.deepEqual(video.inputAssetIds, []);
    assert.equal(video.params.droppedCharacterRefs, 1);
    assert.match(video.finalPrompt, /dolly[\s\S]*Mira — tall woman/);

    assert.equal((await t.call('POST', '/api/generate', { ...base, model: 'mock-image', characterIds: ['00000000-0000-0000-0000-000000000000'] })).status, 404);
    assert.equal((await t.call('DELETE', `/api/characters/${mira.id}`)).body.deleted, true);
    assert.equal((await t.call('GET', '/api/characters')).body.characters.length, 0);
  } finally {
    await t.close();
  }
});

test('image tools: upscale, background removal and inpainting run as jobs on one image', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Tools' })).body.project;
    const base = { projectId: project.id, provider: 'mock', model: 'mock-tools' };
    const source = await done(t, await t.call('POST', '/api/generate', { projectId: project.id, prompt: 'a pear', provider: 'mock', model: 'mock-image' }));
    const before = imageSize(await bytesOf(t, source.assetPath));

    const upscaled = await done(t, await t.call('POST', '/api/generate', { ...base, operation: 'upscale', scale: 4, inputAssetIds: [source.assetId] }));
    assert.equal(upscaled.status, 'completed');
    assert.equal(upscaled.prompt, 'Upscale');
    assert.deepEqual(imageSize(await bytesOf(t, upscaled.assetPath)), { width: before.width * 4, height: before.height * 4 });

    const cutout = await done(t, await t.call('POST', '/api/generate', { ...base, operation: 'remove-background', inputAssetIds: [source.assetId] }));
    assert.equal(cutout.operation, 'remove-background');
    assert.equal(cutout.status, 'completed');

    assert.equal((await t.call('POST', '/api/generate', { ...base, operation: 'upscale' })).status, 400);
    assert.equal((await t.call('POST', '/api/generate', { ...base, model: 'mock-image', operation: 'upscale', inputAssetIds: [source.assetId] })).status, 400);
    const noMask = await t.call('POST', '/api/generate', { ...base, operation: 'inpaint', prompt: 'a red door', inputAssetIds: [source.assetId] });
    assert.equal(noMask.status, 400);
    assert.match(noMask.body.error, /Paint the area/);

    const mask = (await t.call('POST', '/api/assets', { projectId: project.id, dataUrl: tinyPngDataUrl(), kind: 'mask' })).body.asset;
    assert.equal(mask.kind, 'mask');
    assert.equal((await t.call('POST', '/api/generate', { ...base, operation: 'inpaint', inputAssetIds: [source.assetId], maskAssetId: mask.id })).status, 400);
    const painted = await done(t, await t.call('POST', '/api/generate', { ...base, operation: 'inpaint', prompt: 'a red door', inputAssetIds: [source.assetId], maskAssetId: mask.id }));
    assert.equal(painted.status, 'completed');
    assert.equal(painted.params.maskAssetId, mask.id);
    // Masks are working files: stored, but not listed in the project library.
    const detail = (await t.call('GET', `/api/projects/${project.id}`)).body;
    assert.ok(!detail.assets.some((a) => a.id === mask.id));
    assert.ok(detail.assets.some((a) => a.id === painted.assetId));
  } finally {
    await t.close();
  }
});

test('storyboard: idea → shot list → frames → clips → one joined video', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Film' })).body.project;
    const hero = (await t.call('POST', '/api/characters', { name: 'Pip', description: 'small red fox, green scarf' })).body.character;
    const created = await t.call('POST', `/api/projects/${project.id}/storyboards`, {
      title: 'Dawn at the lake', idea: 'A fox reaches a lake at dawn.', writer: 'mock:mock-director',
      settings: { shotCount: 4, aspect: '16:9', style: 'cinematic', characterIds: [hero.id], imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
    });
    assert.equal(created.status, 201);
    const id = created.body.sequence.id;
    assert.equal((await t.call('POST', `/api/storyboards/${id}/stitch`, {})).status, 400);

    const planned = await t.call('POST', `/api/storyboards/${id}/plan`, {});
    assert.equal(planned.status, 200, JSON.stringify(planned.body));
    assert.equal(planned.body.shots.length, 4);
    assert.deepEqual(planned.body.shots.map((s) => s.camera), ['dolly-in', 'orbit-left', 'crane-up', null]);
    assert.equal((await t.call('POST', `/api/storyboards/${id}/plan`, {})).status, 409);

    const [first, second] = planned.body.shots;
    const edited = await t.call('PATCH', `/api/shots/${second.id}`, { description: 'Close on the fox at the water\'s edge.', camera: 'rack-focus', duration: 8 });
    assert.equal(edited.body.shots[1].camera, 'rack-focus');

    const frame = await done(t, await t.call('POST', `/api/shots/${first.id}/frame`, {}));
    assert.equal(frame.status, 'completed');
    assert.match(frame.finalPrompt, /Film still\.[\s\S]*cinematic[\s\S]*Pip — small red fox/);
    assert.equal(frame.params.size, '1536x1024');
    const clipOne = await done(t, await t.call('POST', `/api/shots/${first.id}/animate`, {}));
    assert.deepEqual(clipOne.inputAssetIds, [frame.assetId]);
    assert.deepEqual(clipOne.params.presets, ['dolly-in', 'cinematic']);
    const clipTwo = await done(t, await t.call('POST', `/api/shots/${second.id}/animate`, {}));
    assert.deepEqual(clipTwo.inputAssetIds, []);
    assert.equal(clipTwo.params.duration, 8);

    const detail = (await t.call('GET', `/api/storyboards/${id}`)).body;
    assert.equal(detail.shots[0].imagePath, frame.assetPath);
    assert.equal(detail.shots[0].clipJob.status, 'completed');
    assert.ok(detail.shots[1].videoPath && !detail.shots[2].videoPath);

    if (has('ffmpeg') && has('ffprobe')) {
      const stitched = await t.call('POST', `/api/storyboards/${id}/stitch`, { wait: true });
      assert.equal(stitched.status, 200, JSON.stringify(stitched.body));
      assert.equal(stitched.body.joined, 2);
      assert.equal(stitched.body.skipped, 2);
      const file = path.join(t.dataRoot, 'joined.mp4');
      writeFileSync(file, await bytesOf(t, stitched.body.sequence.outputPath));
      const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]).toString());
      assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);
      assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.4, `duration ${info.format.duration}`);
    }

    const moved = await t.call('POST', `/api/shots/${second.id}/move`, { direction: 'up' });
    assert.equal(moved.body.shots[0].id, second.id);
    const removed = await t.call('DELETE', `/api/shots/${first.id}`);
    assert.deepEqual(removed.body.shots.map((s) => s.position), [1, 2, 3]);
    assert.equal((await t.call('GET', `/api/projects/${project.id}/storyboards`)).body.storyboards[0].shotCount, 3);
  } finally {
    await t.close();
  }
});

test('manuscript import: text, Markdown and Word files split into chapters', async () => {
  const md = parseManuscript({ fileName: 'book.md', bytes: Buffer.from('# The Long Road\n\n## One\n\nFirst para.\nstill first.\n\nSecond para.\n\n## Two\n\n### A scene\n\nMore text.\n') });
  assert.equal(md.title, 'The Long Road');
  assert.deepEqual(md.chapters, [{ title: 'One', text: 'First para. still first.\n\nSecond para.' }, { title: 'Two', text: 'A scene\n\nMore text.' }]);
  const txt = parseManuscript({ fileName: 'draft.txt', bytes: Buffer.from('A note before.\r\n\r\nCHAPTER ONE\r\n\r\nIt began.\r\n\r\nChapter 2: The Lake\r\n\r\nIt went on.') });
  assert.deepEqual(txt.chapters.map((c) => c.title), ['Opening', 'CHAPTER ONE', 'Chapter 2: The Lake']);
  assert.equal(parseManuscript({ fileName: 'plain.txt', bytes: Buffer.from('Just one block.\n\nAnd another.') }).chapters.length, 1);
  assert.throws(() => parseManuscript({ fileName: 'x.pdf', bytes: Buffer.from('%PDF') }), /\.txt, \.md or \.docx/);
  const zipped = readZip(createZip([{ name: 'a.txt', data: 'hello', store: true }, { name: 'b/c.txt', data: 'x'.repeat(5000) }]));
  assert.equal(zipped.get('a.txt').toString(), 'hello');
  assert.equal(zipped.get('b/c.txt').length, 5000);

  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Import' })).body.project;
    const imported = await t.call('POST', `/api/projects/${project.id}/books/import`, { fileName: 'my_novel.md', text: '## Arrival\n\nPip came to the lake.\n\n## Storm\n\nThe sky & the water turned.\n', writer: 'mock:mock-director' });
    assert.equal(imported.status, 201, JSON.stringify(imported.body));
    assert.equal(imported.body.book.title, 'my novel');
    assert.equal(imported.body.book.kind, 'novel');
    assert.deepEqual(imported.body.chapters.map((c) => [c.position, c.title, c.text]), [[1, 'Arrival', 'Pip came to the lake.'], [2, 'Storm', 'The sky & the water turned.']]);

    // Round trip through Lumina's own Word export.
    const docx = await bytesOf(t, `/api/books/${imported.body.book.id}/export.docx`);
    const again = await t.call('POST', `/api/projects/${project.id}/books/import`, { fileName: 'back.docx', dataBase64: docx.toString('base64'), title: 'Round trip', kind: 'nonfiction' });
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.book.kind, 'nonfiction');
    const titles = again.body.chapters.map((c) => c.title);
    assert.ok(titles.some((title) => /Arrival/.test(title)) && titles.some((title) => /Storm/.test(title)), titles.join(' | '));
    assert.ok(again.body.chapters.some((c) => c.text.includes('The sky & the water turned.')));

    // An imported chapter can be revised by the writer like any other.
    const revised = await t.call('POST', `/api/chapters/${imported.body.chapters[0].id}/revise`, { instruction: 'make it tense' });
    assert.match(revised.body.chapter.text, /Revised \(make it tense\)/);
    assert.equal((await t.call('POST', `/api/projects/${project.id}/books/import`, { fileName: 'empty.txt', text: '   ' })).status, 400);
  } finally {
    await t.close();
  }
});

test('canvas templates: save a canvas as a template and start new canvases from it', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Templates' })).body.project;
    const builtIn = (await t.call('GET', '/api/templates')).body.templates;
    assert.ok(builtIn.length && builtIn.every((x) => x.builtIn));
    const canvas = (await t.call('POST', `/api/projects/${project.id}/canvases`, { template: builtIn[0].id, name: 'Mine' })).body.canvas;
    const empty = (await t.call('POST', `/api/projects/${project.id}/canvases`, { name: 'Empty' })).body.canvas;
    assert.equal((await t.call('POST', '/api/templates', { canvasId: empty.id })).status, 400);
    const saved = await t.call('POST', '/api/templates', { canvasId: canvas.id, name: 'My pipeline' });
    assert.equal(saved.status, 201);
    assert.match(saved.body.template.id, /^user:/);
    assert.ok((await t.call('GET', '/api/templates')).body.templates.some((x) => x.name === 'My pipeline' && !x.builtIn));
    const fromMine = (await t.call('POST', `/api/projects/${project.id}/canvases`, { template: saved.body.template.id })).body.canvas;
    assert.equal(fromMine.name, 'My pipeline');
    assert.deepEqual(fromMine.graph, canvas.graph);
    assert.equal((await t.call('DELETE', `/api/templates/${saved.body.template.id}`)).body.deleted, true);
    assert.ok(!(await t.call('GET', '/api/templates')).body.templates.some((x) => x.name === 'My pipeline'));
  } finally {
    await t.close();
  }
});

test('catalog carries list prices and the estimate helper follows each pricing unit', async () => {
  const { estimateUsd, priceFor } = await import('../src/pricing.js');
  assert.equal(estimateUsd(priceFor('fal', 'fal-ai/flux-pro/kontext'), { size: '1024x1024' }), 0.04);
  assert.ok(Math.abs(estimateUsd(priceFor('fal', 'fal-ai/flux/schnell'), { size: '1536x1024' }) - 0.003 * 1.572864) < 1e-9);
  assert.ok(Math.abs(estimateUsd(priceFor('fal', 'fal-ai/kling-video/v3/pro/text-to-video'), { duration: 5 }) - 0.84) < 1e-9);
  assert.equal(estimateUsd(priceFor('openai', 'gpt-image-2.5-flare'), { size: '1024x1024' }), null);
  assert.equal(estimateUsd(priceFor('replicate', 'black-forest-labs/flux-schnell')), null);
  const t = await startTestApp();
  try {
    const catalog = (await t.call('GET', '/api/catalog')).body;
    assert.match(catalog.pricesAsOf, /^\d{4}-\d{2}-\d{2}$/);
    const model = (provider, id) => catalog.providers.find((p) => p.id === provider).models.find((m) => m.id === id);
    assert.deepEqual(model('gemini', 'veo-3.1-generate-preview').price, { usd: 0.4, per: 'second' });
    assert.equal(model('replicate', 'black-forest-labs/flux-1.1-pro').price, null);
    assert.match(model('openai', 'gpt-image-2.5-sunburst').price.text, /per token/);
  } finally {
    await t.close();
  }
});

test('a five-minute film: 30 planned shots aimed at 300 seconds, clips at each shot\'s length, joined in the background', { skip: !has('ffmpeg') && 'needs ffmpeg', timeout: 240_000 }, async () => {
  process.env.LUMINA_MOCK_FULL_CLIPS = '1';
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Feature' })).body.project;
    const created = await t.call('POST', `/api/projects/${project.id}/storyboards`, {
      title: 'Lake', idea: 'A fox crosses the valley to reach a frozen lake.', writer: 'mock:mock-director',
      settings: { shotCount: 30, targetSeconds: 300, imageProvider: 'mock', imageModel: 'mock-image', videoProvider: 'mock', videoModel: 'mock-video' },
    });
    const id = created.body.sequence.id;
    assert.equal(created.body.sequence.settings.targetSeconds, 300);
    const planned = (await t.call('POST', `/api/storyboards/${id}/plan`, {})).body;
    assert.equal(planned.shots.length, 30);
    for (const shot of planned.shots) assert.ok([4, 8, 10].includes(shot.duration), `shot length ${shot.duration} is one the video model makes`);
    for (const shot of planned.shots) await t.call('PATCH', `/api/shots/${shot.id}`, { duration: 10 });
    // A length the model does not offer becomes the nearest one it does.
    const odd = await done(t, await t.call('POST', '/api/generate', { projectId: project.id, operation: 'video', prompt: 'x', provider: 'mock', model: 'mock-video', duration: 7 }));
    assert.equal(odd.params.duration, 8);
    const ids = [];
    for (const shot of planned.shots) ids.push((await t.call('POST', `/api/shots/${shot.id}/animate`, {})).body.generation.id);
    for (const gid of ids) assert.equal((await t.call('POST', `/api/generations/${gid}/wait`, { timeoutMs: 60_000 })).body.generation.status, 'completed');
    const started = await t.call('POST', `/api/storyboards/${id}/stitch`, {});
    assert.equal(started.status, 202);
    assert.equal(started.body.sequence.join.state, 'running');
    assert.equal((await t.call('POST', `/api/storyboards/${id}/stitch`, {})).status, 409);
    let detail = started.body;
    while (detail.sequence.join.state === 'running') {
      await new Promise((resolve) => setTimeout(resolve, 500));
      detail = (await t.call('GET', `/api/storyboards/${id}`)).body;
    }
    assert.equal(detail.sequence.join.state, 'completed', detail.sequence.join.error);
    assert.equal(detail.sequence.join.done, 30);
    const file = path.join(t.dataRoot, 'feature.mp4');
    writeFileSync(file, await bytesOf(t, detail.sequence.outputPath));
    const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    assert.ok(Math.abs(seconds - 300) < 2, `joined film runs ${seconds} s`);
  } finally {
    delete process.env.LUMINA_MOCK_FULL_CLIPS;
    await t.close();
  }
});

test('search and fetch (ChatGPT connector shape): projects, storyboards and characters are found by keyword and read in full', async () => {
  const t = await startTestApp();
  try {
    const project = (await t.call('POST', '/api/projects', { name: 'Lighthouse film' })).body.project;
    const board = (await t.call('POST', `/api/projects/${project.id}/storyboards`, { title: 'Keeper', idea: 'A keeper rows out at dawn.', settings: {} })).body.sequence;
    await t.call('POST', `/api/storyboards/${board.id}/shots`, { description: 'Wide shot of the rowing boat leaving the rocks.' });
    await t.call('POST', '/api/characters', { name: 'Ada', description: 'lighthouse keeper, grey wool coat' });
    const results = (await t.call('GET', '/api/search?q=lighthouse')).body.results;
    assert.deepEqual(results.map((r) => r.id.split(':')[0]).sort(), ['character', 'project']);
    const shots = (await t.call('GET', '/api/search?q=rowing')).body.results;
    assert.equal(shots[0].id, `storyboard:${board.id}`);
    const doc = (await t.call('GET', `/api/search/document?id=${encodeURIComponent(shots[0].id)}`)).body;
    assert.match(doc.text, /Shot 1 .*rowing boat/);
    assert.equal((await t.call('GET', '/api/search/document?id=book:nope')).status, 404);
  } finally {
    await t.close();
  }
});
